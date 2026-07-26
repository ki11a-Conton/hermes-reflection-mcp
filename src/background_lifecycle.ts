import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { STORE_DIR } from "../storage.js";
import { BackgroundStateStore, type BackgroundStatus } from "./background_state.js";
import { getReviewSourceState, runReview } from "./review_engine.js";

type ReviewMode = "deterministic" | "llm" | "auto";

interface BackgroundReviewInput {
  session_id: string;
  signal: AbortSignal;
  before_apply: () => Promise<boolean>;
  with_apply_lease: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
}

interface BackgroundReviewOutput {
  success: boolean;
  source_fingerprint: string;
  outcome_class: string;
}

export interface BackgroundLifecycleOptions {
  enabled: boolean;
  interval_ms: number;
  idle_ms: number;
  lease_ms: number;
  max_sessions_per_run: number;
  review_mode: ReviewMode;
  auto_apply: boolean;
  store: BackgroundStateStore;
  review?: (input: BackgroundReviewInput) => Promise<BackgroundReviewOutput>;
  source_state?: (sessionId: string) => Promise<{ source_fingerprint: string; reflection_count: number }>;
}

export interface BackgroundLifecycleSummary {
  enabled: boolean;
  started: boolean;
  timer_unrefed: boolean;
  running: boolean;
  stopping: boolean;
  interval_ms: number;
  idle_ms: number;
  review_mode: ReviewMode;
  auto_apply: boolean;
}

function truthy(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function reviewMode(value: string | undefined): ReviewMode {
  return value === "deterministic" || value === "llm" || value === "auto" ? value : "auto";
}

interface BackgroundLeaseRefresherOptions {
  store: BackgroundStateStore;
  ownerId: string;
  fencingToken: number;
  leaseMs: number;
  initialExpiresAt: string;
  onLost: () => void;
}

class BackgroundLeaseRefresher {
  private readonly intervalMs: number;
  private lastConfirmedExpiry: number;
  private runPromise: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private stopped = false;
  private lost = false;

  constructor(private readonly options: BackgroundLeaseRefresherOptions) {
    this.intervalMs = Math.max(100, Math.min(30_000, Math.floor(options.leaseMs / 3)));
    const parsedExpiry = Date.parse(options.initialExpiresAt);
    this.lastConfirmedExpiry = Number.isFinite(parsedExpiry)
      ? parsedExpiry
      : Date.now() + options.leaseMs;
  }

  async start(): Promise<boolean> {
    if (this.stopped || this.lost) return false;
    if (this.runPromise) return true;
    const current = await this.refreshNow();
    if (!current || this.stopped) return false;
    this.runPromise = this.run();
    return true;
  }

  async refreshNow(): Promise<boolean> {
    if (this.stopped || this.lost) return false;
    try {
      const result = await this.options.store.renewLease(
        this.options.ownerId,
        this.options.fencingToken,
        this.options.leaseMs,
      );
      if (this.stopped) return false;
      if (!result.renewed) {
        this.markLost();
        return false;
      }
      const parsedExpiry = result.expires_at ? Date.parse(result.expires_at) : Number.NaN;
      this.lastConfirmedExpiry = Number.isFinite(parsedExpiry)
        ? parsedExpiry
        : Date.now() + this.options.leaseMs;
      return true;
    } catch {
      if (this.stopped) return false;
      if (Date.now() >= this.lastConfirmedExpiry) {
        this.markLost();
        return false;
      }
      return true;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.runPromise?.catch(() => undefined);
  }

  private markLost(): void {
    if (this.lost || this.stopped) return;
    this.lost = true;
    this.options.onLost();
  }

  private async run(): Promise<void> {
    while (!this.stopped && !this.lost) {
      if (!await this.wait()) break;
      if (!await this.refreshNow()) break;
    }
  }

  private wait(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (continueRunning: boolean): void => {
        if (settled) return;
        settled = true;
        this.timer = undefined;
        this.wake = undefined;
        resolve(continueRunning);
      };
      this.timer = setTimeout(() => finish(true), this.intervalMs);
      this.timer.unref();
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        finish(false);
      };
    });
  }
}

export function backgroundOptionsFromEnv(): BackgroundLifecycleOptions {
  const intervalMs = boundedInt(process.env.HERMES_REFLECTION_BACKGROUND_INTERVAL_MS, 15 * 60_000, 60_000, 24 * 60 * 60_000);
  return {
    enabled: truthy(process.env.HERMES_REFLECTION_BACKGROUND_ENABLED),
    interval_ms: intervalMs,
    idle_ms: boundedInt(process.env.HERMES_REFLECTION_BACKGROUND_IDLE_MS, 30_000, 5_000, 24 * 60 * 60_000),
    lease_ms: boundedInt(process.env.HERMES_REFLECTION_BACKGROUND_LEASE_MS, Math.max(120_000, intervalMs), 60_000, 24 * 60 * 60_000),
    max_sessions_per_run: boundedInt(process.env.HERMES_REFLECTION_BACKGROUND_MAX_SESSIONS, 4, 1, 20),
    review_mode: reviewMode(process.env.HERMES_REFLECTION_BACKGROUND_REVIEW_MODE),
    auto_apply: truthy(process.env.HERMES_REFLECTION_BACKGROUND_AUTO_APPLY),
    store: new BackgroundStateStore(join(STORE_DIR, "background_lifecycle.json")),
  };
}

export class BackgroundLifecycle {
  private readonly ownerId = `${process.pid}:${randomUUID()}`;
  private readonly review: NonNullable<BackgroundLifecycleOptions["review"]>;
  private readonly sourceState: NonNullable<BackgroundLifecycleOptions["source_state"]>;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private activeController: AbortController | undefined;
  private activeFence: number | undefined;
  private shutdownRun: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(private readonly options: BackgroundLifecycleOptions) {
    this.sourceState = options.source_state ?? ((sessionId) => getReviewSourceState(sessionId, "recent"));
    this.review = options.review ?? (async ({ session_id, signal, before_apply, with_apply_lease }) => {
      const result = await runReview({
        session_id,
        review_scope: "recent",
        review_mode: options.review_mode,
        auto_apply: options.auto_apply,
        signal,
        beforeApply: before_apply,
        withApplyLease: with_apply_lease,
      });
      return {
        success: result.success,
        source_fingerprint: result.source_fingerprint,
        outcome_class: result.success
          ? (result.auto_apply_blocked ? `blocked:${result.auto_apply_blocked}` : "success")
          : (result.error_class ?? "review_failed"),
      };
    });
  }

  summary(): BackgroundLifecycleSummary {
    return {
      enabled: this.options.enabled,
      started: this.started,
      timer_unrefed: Boolean(this.timer && !this.timer.hasRef()),
      running: Boolean(this.activeRun),
      stopping: this.stopping,
      interval_ms: this.options.interval_ms,
      idle_ms: this.options.idle_ms,
      review_mode: this.options.review_mode,
      auto_apply: this.options.auto_apply,
    };
  }

  start(): BackgroundLifecycleSummary {
    if (!this.options.enabled || this.started || this.stopping) return this.summary();
    this.started = true;
    this.timer = setInterval(() => {
      void this.runNow().catch((error) => {
        console.error("[hermes] background review cycle failed:", error instanceof Error ? error.message : "unknown error");
      });
    }, Math.max(10, this.options.interval_ms));
    this.timer.unref();
    return this.summary();
  }

  async notifyReflectionSaved(sessionId: string): Promise<void> {
    await this.options.store.markDirty(sessionId);
  }

  async notifySessionEnd(sessionId: string): Promise<void> {
    await this.options.store.markDirty(sessionId);
    if (this.options.enabled && !this.stopping) {
      void this.runNow().catch((error) => {
        console.error("[hermes] background review cycle failed:", error instanceof Error ? error.message : "unknown error");
      });
    }
  }

  runNow(): Promise<void> {
    if (!this.options.enabled || this.stopping) return Promise.resolve();
    if (this.activeRun) return this.activeRun;
    const wrapped = this.runCycle().finally(() => {
      if (this.activeRun === wrapped) this.activeRun = undefined;
    });
    this.activeRun = wrapped;
    return wrapped;
  }

  private async runCycle(): Promise<void> {
    const lease = await this.options.store.acquireLease(this.ownerId, this.options.lease_ms);
    if (!lease.acquired) return;
    this.activeFence = lease.fencing_token;
    const controller = new AbortController();
    this.activeController = controller;
    const refresher = new BackgroundLeaseRefresher({
      store: this.options.store,
      ownerId: this.ownerId,
      fencingToken: lease.fencing_token,
      leaseMs: this.options.lease_ms,
      initialExpiresAt: lease.expires_at
        ?? new Date(Date.now() + this.options.lease_ms).toISOString(),
      onLost: () => controller.abort(new Error("background_lease_lost")),
    });
    const stopRefresher = (): void => { void refresher.stop(); };
    controller.signal.addEventListener("abort", stopRefresher, { once: true });
    try {
      if (this.stopping) controller.abort(new Error("background_shutdown"));
      if (controller.signal.aborted || !await refresher.start()) return;
      const dirty = await this.options.store.dirtySessions();
      const cutoff = Date.now() - Math.max(0, this.options.idle_ms);
      const eligible = dirty
        .filter((item) => Date.parse(item.dirty_at) <= cutoff)
        .filter((item) => !item.retry_after || Date.parse(item.retry_after) <= Date.now())
        .slice(0, Math.max(1, this.options.max_sessions_per_run));
      for (const item of eligible) {
        if (controller.signal.aborted) break;
        if (!await refresher.refreshNow()) break;
        const current = await this.sourceState(item.session_id);
        if (current.reflection_count === 0 || current.source_fingerprint === item.last_reviewed_fingerprint) {
          await this.options.store.commitSession(
            this.ownerId,
            lease.fencing_token,
            item.session_id,
            current.source_fingerprint,
            current.reflection_count === 0 ? "no_reflections" : "unchanged",
            item.dirty_at,
          );
          continue;
        }
        let output: BackgroundReviewOutput;
        try {
          output = await this.review({
            session_id: item.session_id,
            signal: controller.signal,
            before_apply: () => this.options.store.isLeaseCurrent(this.ownerId, lease.fencing_token),
            with_apply_lease: (operation) => this.options.store.withCurrentLease(this.ownerId, lease.fencing_token, operation),
          });
        } catch {
          if (controller.signal.aborted) break;
          output = { success: false, source_fingerprint: current.source_fingerprint, outcome_class: "internal_error" };
        }
        if (controller.signal.aborted || output.outcome_class === "aborted") break;
        const retryAfterMs = output.success ? undefined : this.cooldownMs(output.outcome_class);
        await this.options.store.commitSession(
          this.ownerId,
          lease.fencing_token,
          item.session_id,
          output.source_fingerprint || current.source_fingerprint,
          output.outcome_class,
          item.dirty_at,
          retryAfterMs,
        );
      }
    } finally {
      controller.signal.removeEventListener("abort", stopRefresher);
      this.activeController = undefined;
      await refresher.stop();
      await this.options.store.releaseLease(this.ownerId, lease.fencing_token);
      if (this.activeFence === lease.fencing_token) this.activeFence = undefined;
    }
  }

  private cooldownMs(outcomeClass: string): number {
    if (/authentication|permission|configuration/.test(outcomeClass)) return 15 * 60_000;
    if (/quota/.test(outcomeClass)) return 60 * 60_000;
    return 5 * 60_000;
  }

  async status(): Promise<{ runtime: BackgroundLifecycleSummary; durable: BackgroundStatus }> {
    return { runtime: this.summary(), durable: await this.options.store.status() };
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    if (this.shutdownRun) return this.shutdownRun;
    this.shutdownRun = (async () => {
      this.stopping = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.activeController?.abort();
      const active = this.activeRun;
      if (active) {
        let drainTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            active.catch(() => undefined),
            new Promise<void>((resolve) => {
              drainTimer = setTimeout(resolve, Math.max(0, timeoutMs));
              drainTimer.unref();
            }),
          ]);
        } finally {
          if (drainTimer) clearTimeout(drainTimer);
        }
      }
    })();
    return this.shutdownRun;
  }
}

export const backgroundLifecycle = new BackgroundLifecycle(backgroundOptionsFromEnv());

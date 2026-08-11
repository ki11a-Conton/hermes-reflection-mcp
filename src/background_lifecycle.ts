import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { STORE_DIR } from "../storage.js";
import type { MemoryScope } from "../types.js";
import { BackgroundStateStore, type BackgroundStatus, type ReviewStage } from "./background_state.js";
import {
  getReviewReadinessStatus,
  getReviewSourceState,
  inFlightReview,
  reviewSingleFlightKey,
  runReviewSingleFlight,
  type ReviewEngineResult,
  type RunReviewOptions,
} from "./review_engine.js";
import { HermesError } from "./errors.js";
import { durableReviewCandidateIds } from "./review_queue.js";
import { HookInbox, hookInbox, type HookEvent } from "./hook_inbox.js";
import { HookInboxPump, type HookInboxPumpStatus } from "./hook_inbox_pump.js";
import { projectScopeRepository } from "./project_scope.js";
import {
  normalizeRequestedSessionScope,
  SessionScopeError,
  type RequestedSessionScope,
} from "./session_scope.js";
import { resolvePersistedSessionAccess } from "./session_access.js";
import { captureSessionSnapshot, releaseSessionSnapshot } from "./storage_enhanced.js";
import {
  persistCompactionReceipt,
  persistSessionEnd,
  persistSessionStart,
  resolveSessionScope,
  SESSION_STORAGE_UNAVAILABLE,
} from "../session_storage.js";

type ReviewMode = "deterministic" | "llm" | "auto";

async function internalPersistedScope(sessionId: string): Promise<MemoryScope> {
  try {
    return normalizeRequestedSessionScope(await resolveSessionScope(sessionId));
  } catch (error) {
    if (!(error instanceof SessionScopeError)
      || (error.code !== "LIFECYCLE_NOT_READY" && error.code !== "LEGACY_SCOPE_DENIED")) throw error;
    return "global";
  }
}

interface BackgroundReviewInput {
  session_id: string;
  scope: MemoryScope;
  stage: ReviewStage;
  source_fingerprint: string;
  signal: AbortSignal;
  before_apply: () => Promise<boolean>;
  with_apply_lease: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
}

interface BackgroundReviewOutput {
  success: boolean;
  source_fingerprint: string;
  outcome_class: string;
  stage?: ReviewStage;
  candidate_ids?: string[];
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
  source_state?: (sessionId: string) => Promise<{ source_fingerprint: string; reflection_count: number; scope?: MemoryScope }>;
  candidates_durable?: (candidateIds: string[]) => Promise<boolean>;
  hook_inbox?: HookInbox;
  process_hook_event?: (event: HookEvent) => Promise<void>;
}

export interface BackgroundLifecycleSummary {
  enabled: boolean;
  started: boolean;
  timer_unrefed: boolean;
  deadline_timer_unrefed: boolean;
  next_deadline_at?: string;
  running: boolean;
  stopping: boolean;
  interval_ms: number;
  idle_ms: number;
  review_mode: ReviewMode;
  auto_apply: boolean;
}

export type ManualReviewRequest = Omit<RunReviewOptions, "signal" | "beforeApply" | "withApplyLease" | "before_apply">;

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
  private readonly candidatesDurable: NonNullable<BackgroundLifecycleOptions["candidates_durable"]>;
  private readonly inbox: HookInbox;
  private readonly processHookEvent: NonNullable<BackgroundLifecycleOptions["process_hook_event"]>;
  private readonly hookPump: HookInboxPump;
  private timer: NodeJS.Timeout | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private nextDeadlineAt: string | undefined;
  private deadlineBackoffUntil = 0;
  private deadlineArmGeneration = 0;
  private deadlineRearmQueue: Promise<void> = Promise.resolve();
  private activeRun: Promise<void> | undefined;
  private activeReviewReady: { promise: Promise<void>; resolve: () => void } | undefined;
  private activeController: AbortController | undefined;
  private activeFence: number | undefined;
  private fenceClaiming = false;
  private shutdownRun: Promise<void> | undefined;
  private readonly manualRuns = new Map<string, Promise<ReviewEngineResult>>();
  private started = false;
  private stopping = false;

  constructor(private readonly options: BackgroundLifecycleOptions) {
    this.sourceState = options.source_state ?? (async (sessionId) => {
      const scope = await internalPersistedScope(sessionId);
      return getReviewSourceState(sessionId, "recent", scope);
    });
    this.candidatesDurable = options.candidates_durable ?? durableReviewCandidateIds;
    this.inbox = options.hook_inbox ?? hookInbox;
    this.processHookEvent = options.process_hook_event ?? ((event) => this.applyHookEvent(event));
    this.hookPump = new HookInboxPump(this.inbox, async (event) => {
      await this.processHookEvent(event);
      await this.rearmDeadline();
    });
    this.review = options.review ?? (async ({ session_id, scope, stage, source_fingerprint, signal, before_apply, with_apply_lease }) => {
      const result = await runReviewSingleFlight({
        session_id,
        scope,
        stage,
        source_fingerprint,
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
        stage: result.review_mode_used ?? stage,
        candidate_ids: result.candidate_heuristics.map((candidate) => candidate.id),
      };
    });
  }

  summary(): BackgroundLifecycleSummary {
    return {
      enabled: this.options.enabled,
      started: this.started,
      timer_unrefed: Boolean(this.timer && !this.timer.hasRef()),
      deadline_timer_unrefed: Boolean(this.deadlineTimer && !this.deadlineTimer.hasRef()),
      ...(this.nextDeadlineAt ? { next_deadline_at: this.nextDeadlineAt } : {}),
      running: Boolean(this.activeRun),
      stopping: this.stopping,
      interval_ms: this.options.interval_ms,
      idle_ms: this.options.idle_ms,
      review_mode: this.options.review_mode,
      auto_apply: this.options.auto_apply,
    };
  }

  private commitStage(
    ownerId: string,
    fencingToken: number,
    sessionId: string,
    stage: ReviewStage,
    fingerprint: string,
    outcomeClass: string,
    candidateIds: string[],
    expectedDirtyAt?: string,
    retryAfterMs?: number,
  ): Promise<boolean> {
    const store = this.options.store as BackgroundStateStore & {
      commitStage?: BackgroundStateStore["commitStage"];
      commitSession: BackgroundStateStore["commitSession"];
    };
    if (typeof store.commitStage === "function") {
      return store.commitStage(
        ownerId,
        fencingToken,
        sessionId,
        stage,
        fingerprint,
        outcomeClass,
        candidateIds,
        expectedDirtyAt,
        retryAfterMs,
      );
    }
    return store.commitSession(
      ownerId,
      fencingToken,
      sessionId,
      fingerprint,
      outcomeClass,
      expectedDirtyAt,
      retryAfterMs,
    );
  }

  start(): BackgroundLifecycleSummary {
    this.hookPump.start();
    if (!this.options.enabled || this.started || this.stopping) return this.summary();
    this.started = true;
    this.timer = setInterval(() => {
      void this.runNow().catch((error) => {
        console.error("[hermes] background review cycle failed:", error instanceof Error ? error.message : "unknown error");
      });
    }, Math.max(10, this.options.interval_ms));
    this.timer.unref();
    void this.rearmDeadline().catch(() => undefined);
    return this.summary();
  }

  async notifyReflectionSaved(sessionId: string): Promise<void> {
    await this.options.store.markDirty(sessionId);
    await this.rearmDeadline();
  }

  async notifySessionEnd(sessionId: string): Promise<void> {
    await this.options.store.markDirty(sessionId);
    await this.rearmDeadline();
    if (this.options.enabled && !this.stopping) {
      void this.runNow().catch((error) => {
        console.error("[hermes] background review cycle failed:", error instanceof Error ? error.message : "unknown error");
      });
    }
  }

  runNow(): Promise<void>;
  runNow(request: ManualReviewRequest): Promise<ReviewEngineResult>;
  runNow(request?: ManualReviewRequest): Promise<void> | Promise<ReviewEngineResult> {
    if (request) {
      const key = reviewSingleFlightKey(request);
      const current = this.manualRuns.get(key);
      if (current) return current;
      const started = this.runManualReview(request).finally(() => {
        if (this.manualRuns.get(key) === started) this.manualRuns.delete(key);
      });
      this.manualRuns.set(key, started);
      return started;
    }
    if (!this.options.enabled || this.stopping) return Promise.resolve();
    if (this.activeRun) return this.activeRun;
    let resolveReady!: () => void;
    const ready = {
      promise: new Promise<void>((resolve) => { resolveReady = resolve; }),
      resolve: () => resolveReady(),
    };
    this.activeReviewReady = ready;
    const wrapped = this.runCycle().finally(() => {
      ready.resolve();
      if (this.activeReviewReady === ready) this.activeReviewReady = undefined;
      if (this.activeRun === wrapped) this.activeRun = undefined;
      void this.rearmDeadline();
    });
    this.activeRun = wrapped;
    return wrapped;
  }

  private async applyHookEvent(event: HookEvent): Promise<void> {
    switch (event.event) {
      case "SessionStart":
        if (!await persistSessionStart(event.session_id, {
          scope: (event.project_key ?? event.scope_intent) as RequestedSessionScope,
          start_event_id: event.event_id,
          started_at: event.occurred_at,
        })) {
          throw new Error(SESSION_STORAGE_UNAVAILABLE);
        }
        await projectScopeRepository.bind(event.session_id, event.project_key);
        await captureSessionSnapshot(event.session_id);
        break;
      case "Stop":
      case "SessionEnd":
        if (event.event === "SessionEnd") {
          const boundScope = await projectScopeRepository.active(event.session_id);
          if (!await persistSessionEnd(event.session_id, {
            scope: (event.project_key ?? boundScope ?? "global") as RequestedSessionScope,
            end_reason: "SessionEnd Hook",
            ended_at: event.occurred_at,
          })) throw new Error(SESSION_STORAGE_UNAVAILABLE);
        }
        releaseSessionSnapshot(event.session_id);
        await this.options.store.markDirty(event.session_id, event.occurred_at);
        await projectScopeRepository.release(event.session_id);
        break;
      case "PreCompact":
        await captureSessionSnapshot(event.session_id);
        break;
      case "PostCompact":
        {
          const scope = await resolvePersistedSessionAccess(event.session_id, event.project_key);
          if (!await persistCompactionReceipt(event.session_id, event.metadata!, scope)) {
            throw new Error(SESSION_STORAGE_UNAVAILABLE);
          }
        }
        await captureSessionSnapshot(event.session_id);
        break;
    }
  }

  async consumeInboxNow(): Promise<{ processed: number; skipped: number }> {
    return this.hookPump.poke();
  }

  private rearmDeadline(): Promise<void> {
    const run = this.deadlineRearmQueue.then(() => this.armDeadlineNow());
    this.deadlineRearmQueue = run.catch(() => undefined);
    return run;
  }

  private async armDeadlineNow(): Promise<void> {
    const generation = ++this.deadlineArmGeneration;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.nextDeadlineAt = undefined;
    if (!this.options.enabled || this.stopping) return;
    const dirty = await this.options.store.dirtySessions();
    if (generation !== this.deadlineArmGeneration) return;
    if (dirty.length === 0) return;
    const earliest = dirty.reduce((minimum, item) => {
      const idleAt = Date.parse(item.dirty_at) + Math.max(0, this.options.idle_ms);
      const retryAt = item.retry_after ? Date.parse(item.retry_after) : 0;
      return Math.min(minimum, Math.max(idleAt, retryAt));
    }, Number.POSITIVE_INFINITY);
    const deadline = Math.max(earliest, this.deadlineBackoffUntil);
    if (!Number.isFinite(deadline)) return;
    this.nextDeadlineAt = new Date(deadline).toISOString();
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      this.nextDeadlineAt = undefined;
      void this.runNow().catch((error) => {
        console.error("[hermes] deadline review cycle failed:", error instanceof Error ? error.message : "unknown error");
      });
    }, Math.max(0, deadline - Date.now()));
    this.deadlineTimer.unref();
  }

  private async runManualReview(request: ManualReviewRequest): Promise<ReviewEngineResult> {
    if (this.stopping) {
      throw new HermesError("REVIEW_IN_PROGRESS", "Background lifecycle is shutting down.", true, "Retry in a fresh MCP process.");
    }
    const current = inFlightReview(request);
    if (current) return current;
    const scheduled = this.activeRun;
    if (scheduled) {
      const ready = this.activeReviewReady;
      if (ready) await ready.promise;
      const joined = inFlightReview(request);
      if (joined) return joined;
      throw new HermesError(
        "REVIEW_IN_PROGRESS",
        "A scheduled background review is already using the lifecycle lease.",
        true,
        "Retry after the scheduled review completes.",
      );
    }
    if (this.activeFence !== undefined || this.fenceClaiming) {
      throw new HermesError(
        "REVIEW_IN_PROGRESS",
        "Another fenced background review is already running.",
        true,
        "Retry after the current review completes.",
      );
    }

    this.fenceClaiming = true;
    let lease;
    try {
      lease = await this.options.store.acquireLease(this.ownerId, this.options.lease_ms);
    } finally {
      this.fenceClaiming = false;
    }
    const joined = inFlightReview(request);
    if (joined) {
      if (lease.acquired) await this.options.store.releaseLease(this.ownerId, lease.fencing_token);
      return joined;
    }
    if (!lease.acquired) {
      throw new HermesError(
        "REVIEW_IN_PROGRESS",
        "Another process owns the background review lease.",
        true,
        "Retry after the current review lease is released.",
      );
    }
    const ownsLease = this.activeFence === undefined;
    if (!ownsLease) {
      const active = inFlightReview(request);
      if (active) return active;
      throw new HermesError(
        "REVIEW_IN_PROGRESS",
        "Another local background review started first.",
        true,
        "Retry after the current review completes.",
      );
    }
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
      if (controller.signal.aborted || !await refresher.start()) {
        throw new HermesError(
          "REVIEW_IN_PROGRESS",
          "The manual review lease was lost before provider work started.",
          true,
          "Retry after the current review lease is available.",
        );
      }
      const result = await runReviewSingleFlight({
        ...request,
        signal: controller.signal,
        beforeApply: () => this.options.store.isLeaseCurrent(this.ownerId, lease.fencing_token),
        withApplyLease: (operation) => this.options.store.withCurrentLease(this.ownerId, lease.fencing_token, operation),
      });
      const candidateIds = result.candidate_heuristics.map((candidate) => candidate.id);
      if (result.success && !await this.candidatesDurable(candidateIds)) {
        throw new Error("Review candidates were not durably persisted");
      }
      const dirty = (await this.options.store.dirtySessions()).find((item) => item.session_id === request.session_id);
      const outcomeClass = result.success
        ? (result.auto_apply_blocked ? `blocked:${result.auto_apply_blocked}` : "success")
        : (result.error_class ?? "review_failed");
      if (controller.signal.aborted || !await refresher.refreshNow()) {
        throw new HermesError(
          "REVIEW_IN_PROGRESS",
          "The manual review lease was lost before stage commit.",
          true,
          "Retry so the durable candidates can be reviewed under a current lease.",
        );
      }
      const committed = await this.commitStage(
        this.ownerId,
        lease.fencing_token,
        request.session_id,
        result.review_mode_used ?? request.stage,
        result.source_fingerprint || request.source_fingerprint,
        outcomeClass,
        candidateIds,
        dirty?.dirty_at,
        result.success ? undefined : this.cooldownMs(outcomeClass),
      );
      if (!committed) {
        throw new HermesError(
          "REVIEW_IN_PROGRESS",
          "The manual review stage could not be committed under the current lease.",
          true,
          "Retry so the durable candidates and stage fingerprint can be reconciled.",
        );
      }
      return result;
    } finally {
      controller.signal.removeEventListener("abort", stopRefresher);
      this.activeController = undefined;
      await refresher.stop();
      await this.options.store.releaseLease(this.ownerId, lease.fencing_token);
      if (this.activeFence === lease.fencing_token) this.activeFence = undefined;
      void this.rearmDeadline();
    }
  }

  private async runCycle(): Promise<void> {
    await this.hookPump.drainNow();
    if (this.activeFence !== undefined || this.fenceClaiming) return;
    this.fenceClaiming = true;
    let lease;
    try {
      lease = await this.options.store.acquireLease(this.ownerId, this.options.lease_ms);
    } finally {
      this.fenceClaiming = false;
    }
    if (!lease.acquired) {
      this.deadlineBackoffUntil = Date.now() + 1_000;
      return;
    }
    this.deadlineBackoffUntil = 0;
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
        const requestedStage: ReviewStage = this.options.review_mode === "deterministic"
          ? "deterministic"
          : (getReviewReadinessStatus().ready ? "llm" : "deterministic");
        const reviewedFingerprint = item[requestedStage]?.fingerprint;
        if (current.reflection_count === 0 || current.source_fingerprint === reviewedFingerprint) {
          await this.commitStage(
            this.ownerId,
            lease.fencing_token,
            item.session_id,
            requestedStage,
            current.source_fingerprint,
            current.reflection_count === 0 ? "no_reflections" : "unchanged",
            [],
            item.dirty_at,
          );
          continue;
        }
        let output: BackgroundReviewOutput;
        try {
          const review = this.review({
            session_id: item.session_id,
            scope: current.scope ?? "global",
            stage: requestedStage,
            source_fingerprint: current.source_fingerprint,
            signal: controller.signal,
            before_apply: () => this.options.store.isLeaseCurrent(this.ownerId, lease.fencing_token),
            with_apply_lease: (operation) => this.options.store.withCurrentLease(this.ownerId, lease.fencing_token, operation),
          });
          this.activeReviewReady?.resolve();
          output = await review;
        } catch {
          if (controller.signal.aborted) break;
          output = {
            success: false,
            source_fingerprint: current.source_fingerprint,
            outcome_class: "internal_error",
            stage: requestedStage,
            candidate_ids: [],
          };
        }
        if (controller.signal.aborted || output.outcome_class === "aborted") break;
        const candidateIds = output.candidate_ids ?? [];
        const completedStage = output.stage ?? requestedStage;
        if (output.success && !await this.candidatesDurable(candidateIds)) {
          output = {
            ...output,
            success: false,
            outcome_class: "candidate_persistence_unverified",
          };
        }
        const retryAfterMs = output.success ? undefined : this.cooldownMs(output.outcome_class);
        await this.commitStage(
          this.ownerId,
          lease.fencing_token,
          item.session_id,
          completedStage,
          output.source_fingerprint || current.source_fingerprint,
          output.outcome_class,
          candidateIds,
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

  async status(scope?: MemoryScope): Promise<{ runtime: BackgroundLifecycleSummary; durable: BackgroundStatus; hook_inbox: HookInboxPumpStatus }> {
    let durable = await this.options.store.status();
    if (scope !== undefined) {
      const dirty = await this.options.store.dirtySessions();
      const sessionIds = [...new Set([
        ...dirty.map((item) => item.session_id),
        ...durable.recent_runs.map((item) => item.session_id),
      ])];
      const scopes = new Map(await Promise.all(sessionIds.map(async (sessionId) => [
        sessionId,
        await internalPersistedScope(sessionId),
      ] as const)));
      const visibleDirty = dirty.filter((item) => scopes.get(item.session_id) === scope);
      durable = {
        ...durable,
        dirty_session_count: visibleDirty.length,
        retrying_session_count: visibleDirty
          .filter((item) => item.retry_after && Date.parse(item.retry_after) > Date.now()).length,
        dirty_session_ids: visibleDirty.map((item) => item.session_id),
        recent_runs: durable.recent_runs.filter((item) => scopes.get(item.session_id) === scope),
      };
    }
    return {
      runtime: this.summary(),
      durable,
      hook_inbox: await this.hookPump.status(),
    };
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    if (this.shutdownRun) return this.shutdownRun;
    this.shutdownRun = (async () => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const remaining = (): number => Math.max(0, deadline - Date.now());
      this.stopping = true;
      await this.hookPump.shutdown(remaining());
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.deadlineArmGeneration += 1;
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
      this.nextDeadlineAt = undefined;
      this.activeController?.abort();
      const active = [
        ...(this.activeRun ? [this.activeRun] : []),
        ...this.manualRuns.values(),
      ];
      const drainTimeout = remaining();
      if (drainTimeout > 0) {
        let drainTimer: NodeJS.Timeout | undefined;
        try {
          const drainActiveAndRearms = (async () => {
            if (active.length > 0) await Promise.allSettled(active);
            // Active runs enqueue their final deadline rearm from `finally`.
            // Read the queue only after they settle so shutdown also drains
            // those file-backed reads without allocating a second timeout.
            await this.deadlineRearmQueue;
          })();
          await Promise.race([
            drainActiveAndRearms,
            new Promise<void>((resolve) => {
              drainTimer = setTimeout(resolve, drainTimeout);
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

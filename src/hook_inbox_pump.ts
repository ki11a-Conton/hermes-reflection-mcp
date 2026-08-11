import { HookInbox, type HookEvent, type HookInboxStatus } from "./hook_inbox.js";

export interface HookInboxPumpStatus extends HookInboxStatus {
  abandoned: number;
  running: boolean;
  started: boolean;
  stopping: boolean;
  timer_unrefed: boolean;
  poll_ms: number;
  last_successful_drain_at?: string;
  last_error?: string;
}

export class HookInboxPump {
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<{ processed: number; skipped: number }> | undefined;
  private shutdownRun: Promise<void> | undefined;
  private started = false;
  private stopping = false;
  private claimed = 0;
  private abandoned = 0;
  private lastSuccessfulDrainAt: string | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly inbox: HookInbox,
    private readonly handler: (event: HookEvent) => Promise<void>,
    pollMs = 1_000,
  ) {
    const bounded = Number.isFinite(pollMs) ? Math.floor(pollMs) : 1_000;
    this.pollMs = Math.max(100, Math.min(5_000, bounded));
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    void this.drainNow().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.drainNow().catch(() => undefined);
    }, this.pollMs);
    this.timer.unref();
  }

  poke(): Promise<{ processed: number; skipped: number }> {
    return this.drainNow();
  }

  drainNow(): Promise<{ processed: number; skipped: number }> {
    if (this.flight) return this.flight;
    if (this.stopping) return Promise.resolve({ processed: 0, skipped: 0 });
    const run = this.inbox.consume(this.handler, {
      onClaimed: () => { this.claimed += 1; },
      onSettled: () => { this.claimed = Math.max(0, this.claimed - 1); },
    })
      .then((result) => {
        this.lastSuccessfulDrainAt = new Date().toISOString();
        this.lastError = undefined;
        return result;
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        if (this.flight === run) this.flight = undefined;
      });
    this.flight = run;
    return run;
  }

  async status(): Promise<HookInboxPumpStatus> {
    return {
      ...await this.inbox.status(),
      abandoned: this.abandoned,
      running: Boolean(this.flight),
      started: this.started,
      stopping: this.stopping,
      timer_unrefed: Boolean(this.timer && !this.timer.hasRef()),
      poll_ms: this.pollMs,
      ...(this.lastSuccessfulDrainAt ? { last_successful_drain_at: this.lastSuccessfulDrainAt } : {}),
      ...(this.lastError ? { last_error: this.lastError } : {}),
    };
  }

  shutdown(deadlineMs = 2_000): Promise<void> {
    if (this.shutdownRun) return this.shutdownRun;
    this.shutdownRun = (async () => {
      this.stopping = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      const active = this.flight;
      if (!active) return;

      let drainTimer: NodeJS.Timeout | undefined;
      let completed = false;
      try {
        await Promise.race([
          active.then(
            () => { completed = true; },
            () => { completed = true; },
          ),
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, Math.max(0, deadlineMs));
          }),
        ]);
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
      }
      if (!completed) this.abandoned += this.claimed;
    })();
    return this.shutdownRun;
  }
}

export class HookInboxPump {
    inbox;
    handler;
    pollMs;
    timer;
    flight;
    shutdownRun;
    started = false;
    stopping = false;
    claimed = 0;
    abandoned = 0;
    lastSuccessfulDrainAt;
    lastError;
    constructor(inbox, handler, pollMs = 1_000) {
        this.inbox = inbox;
        this.handler = handler;
        const bounded = Number.isFinite(pollMs) ? Math.floor(pollMs) : 1_000;
        this.pollMs = Math.max(100, Math.min(5_000, bounded));
    }
    start() {
        if (this.started || this.stopping)
            return;
        this.started = true;
        void this.drainNow().catch(() => undefined);
        this.timer = setInterval(() => {
            void this.drainNow().catch(() => undefined);
        }, this.pollMs);
        this.timer.unref();
    }
    poke() {
        return this.drainNow();
    }
    drainNow() {
        if (this.flight)
            return this.flight;
        if (this.stopping)
            return Promise.resolve({ processed: 0, skipped: 0 });
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
            if (this.flight === run)
                this.flight = undefined;
        });
        this.flight = run;
        return run;
    }
    async status() {
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
    shutdown(deadlineMs = 2_000) {
        if (this.shutdownRun)
            return this.shutdownRun;
        this.shutdownRun = (async () => {
            this.stopping = true;
            if (this.timer)
                clearInterval(this.timer);
            this.timer = undefined;
            const active = this.flight;
            if (!active)
                return;
            let drainTimer;
            let completed = false;
            try {
                await Promise.race([
                    active.then(() => { completed = true; }, () => { completed = true; }),
                    new Promise((resolve) => {
                        drainTimer = setTimeout(resolve, Math.max(0, deadlineMs));
                    }),
                ]);
            }
            finally {
                if (drainTimer)
                    clearTimeout(drainTimer);
            }
            if (!completed)
                this.abandoned += this.claimed;
        })();
        return this.shutdownRun;
    }
}

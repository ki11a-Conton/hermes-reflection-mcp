// ============================================================
// Async Lock - Read/Write Lock for Concurrent Control
// ============================================================

/**
 * Async read-write lock for managing concurrent access.
 * - Multiple readers can acquire read lock simultaneously
 * - Write lock is exclusive (no other readers or writers)
 * - Writers wait for all readers to finish
 */
export class AsyncLock {
  private writeChain: Promise<void> = Promise.resolve();
  private currentRelease: (() => void) | null = null;
  private readCount = 0;
  // A16: activeWrite is for debugging only (getState()); mutual exclusion
  // relies entirely on the writeChain promise chain, not this flag.
  private activeWrite = false;
  // G7-fix: resolver notified when readCount drops to 0, replacing 10ms polling
  private readersDrained: (() => void) | null = null;

  /**
   * Acquire a lock (read or write).
   * B4-fix: Each writer chains on the previous writer's promise and stores its
   * own release function in currentRelease. When the current holder calls
   * release(), it resolves its own promise, unblocking the next writer.
   */
  async acquire(type: "read" | "write"): Promise<void> {
    if (type === "write") {
      const previousWrite = this.writeChain;
      let releaseMe!: () => void;
      const myWritePromise = new Promise<void>((resolve) => {
        releaseMe = resolve;
      });
      this.writeChain = myWritePromise;

      await previousWrite;
      await this.waitForReaders();
      this.activeWrite = true;
      // Store the CURRENT holder's release (only one writer holds at a time).
      this.currentRelease = releaseMe;
    } else {
      await this.writeChain;
      this.readCount++;
    }
  }

  /**
   * Release a lock (read or write).
   */
  release(type: "read" | "write"): void {
    if (type === "write") {
      this.activeWrite = false;
      if (this.currentRelease) {
        const release = this.currentRelease;
        this.currentRelease = null;
        release();
      }
    } else {
      this.readCount--;
      if (this.readCount < 0) {
        this.readCount = 0; // Safety guard
      }
      // G7-fix: notify waiting writer when all readers are done
      if (this.readCount === 0 && this.readersDrained) {
        const cb = this.readersDrained;
        this.readersDrained = null;
        cb();
      }
    }
  }

  /**
   * Wait for all active readers to finish.
   * G7-fix: use Promise notification instead of 10ms polling.
   */
  private async waitForReaders(): Promise<void> {
    if (this.readCount === 0) return;
    await new Promise<void>((resolve) => {
      this.readersDrained = resolve;
    });
  }

  /**
   * Get current lock state (for debugging).
   */
  getState(): { readCount: number; activeWrite: boolean } {
    return {
      readCount: this.readCount,
      activeWrite: this.activeWrite,
    };
  }
}

/**
 * Helper to execute a function with read lock.
 * Automatically acquires and releases the lock.
 */
export async function withReadLock<T>(
  lock: AsyncLock,
  fn: () => Promise<T>
): Promise<T> {
  await lock.acquire("read");
  try {
    return await fn();
  } finally {
    lock.release("read");
  }
}

/**
 * Helper to execute a function with write lock.
 * Automatically acquires and releases the lock.
 */
export async function withWriteLock<T>(
  lock: AsyncLock,
  fn: () => Promise<T>
): Promise<T> {
  await lock.acquire("write");
  try {
    return await fn();
  } finally {
    lock.release("write");
  }
}

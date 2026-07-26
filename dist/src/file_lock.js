import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function errorCode(error) {
    return error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
}
export function isRetryableLockContention(code, platform = process.platform) {
    return code === "EEXIST"
        || (platform === "win32" && (code === "EACCES" || code === "EPERM"));
}
function isProcessAlive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but this process cannot signal it.
        return errorCode(error) === "EPERM";
    }
}
async function quarantineStaleLock(lockPath, staleMs) {
    try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs <= staleMs)
            return false;
        try {
            const metadata = JSON.parse(await readFile(lockPath, "utf8"));
            if (isProcessAlive(metadata.pid))
                return false;
        }
        catch {
            // Missing/invalid metadata can still be quarantined after the age and
            // second-stat checks below.
        }
        // A heartbeat may have refreshed the file after the first stat. Recheck
        // immediately before rename so that observation cannot evict a live owner.
        const latest = await stat(lockPath);
        if (latest.mtimeMs > info.mtimeMs || Date.now() - latest.mtimeMs <= staleMs)
            return false;
        const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        await rename(lockPath, quarantine);
        await rm(quarantine, { force: true });
        return true;
    }
    catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes(errorCode(error) ?? ""))
            return false;
        throw error;
    }
}
/**
 * Serialize a read-modify-write transaction across MCP server processes.
 * The `wx` open is the atomic ownership decision; existence checks are never
 * used as the lock acquisition primitive.
 */
export async function withFileLock(filePath, fn, options = {}) {
    const lockPath = `${filePath}.lock`;
    const timeoutMs = options.timeout_ms ?? 10_000;
    const retryMs = options.retry_ms ?? 25;
    const staleMs = options.stale_ms ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    const ownerToken = randomUUID();
    await mkdir(dirname(lockPath), { recursive: true });
    let handle = null;
    while (!handle) {
        try {
            const candidate = await open(lockPath, "wx", 0o600);
            try {
                await candidate.writeFile(JSON.stringify({
                    pid: process.pid,
                    token: ownerToken,
                    created_at: new Date().toISOString(),
                }), "utf8");
                handle = candidate;
            }
            catch (error) {
                await candidate.close().catch(() => undefined);
                await rm(lockPath, { force: true }).catch(() => undefined);
                throw error;
            }
        }
        catch (error) {
            if (!isRetryableLockContention(errorCode(error)))
                throw error;
            if (await quarantineStaleLock(lockPath, staleMs))
                continue;
            if (Date.now() >= deadline) {
                let owner = "unknown";
                try {
                    owner = (await readFile(lockPath, "utf8")).slice(0, 200);
                }
                catch {
                    // Diagnostic only. The lock may have been released concurrently.
                }
                throw new Error(`Timed out waiting for storage lock ${basename(lockPath)} after ${timeoutMs}ms (owner: ${owner})`);
            }
            await delay(retryMs);
        }
    }
    const ownedHandle = handle;
    const heartbeatMs = Math.max(10, Math.floor(staleMs / 3));
    const heartbeat = setInterval(() => {
        const now = new Date();
        void ownedHandle.utimes(now, now).catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref();
    try {
        return await fn();
    }
    finally {
        clearInterval(heartbeat);
        await ownedHandle.close().catch(() => undefined);
        // A stale-lock quarantine may have replaced the path while this callback
        // was running. Only remove the path when it still names our token.
        let stillOwned = false;
        try {
            const metadata = JSON.parse(await readFile(lockPath, "utf8"));
            stillOwned = metadata.token === ownerToken;
        }
        catch {
            // Missing/unreadable means the path is no longer provably ours.
        }
        if (stillOwned) {
            await rm(lockPath, { force: true }).catch(() => undefined);
        }
    }
}

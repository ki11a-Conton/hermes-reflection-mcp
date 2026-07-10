// ============================================================
// Storage enhancements: in-process coordination and frozen snapshots
// ============================================================
import { AsyncLock, withReadLock, withWriteLock } from "./async_lock.js";
import { captureMemorySnapshot, getMemorySnapshot, isCapturePending, markPendingCapture, releaseMemorySnapshot } from "./memory_snapshot.js";
import { getRawMemoryStores, memoryBoardRead as _memoryBoardRead, memoryBoardWrite as _memoryBoardWrite, memoryBoardBatchWrite as _memoryBoardBatchWrite, userProfileRead as _userProfileRead, userProfileWrite as _userProfileWrite, userProfileBatchWrite as _userProfileBatchWrite, } from "../storage.js";
/**
 * Global locks for storage operations.
 */
export const storageLock = new AsyncLock();
/**
 * Memory board read with snapshot support.
 *
 * @param sessionId - Optional session ID for snapshot mode
 * @param snapshotMode - If true, return frozen snapshot (for system prompt)
 */
export async function memoryBoardReadEnhanced(sessionId, snapshotMode = false) {
    return withReadLock(storageLock, async () => {
        if (snapshotMode) {
            if (!sessionId)
                throw new Error("session_id is required when mode is snapshot.");
            const snapshot = getMemorySnapshot(sessionId);
            if (!snapshot)
                throw new Error(`No active snapshot found for session ${sessionId}`);
            return {
                content: snapshot.memory_board,
                source: "snapshot",
                captured_at: new Date(snapshot.captured_at).toISOString(),
            };
        }
        // Live mode: return current state
        const liveContent = await _memoryBoardRead();
        return {
            content: liveContent,
            source: "live",
        };
    });
}
/**
 * User profile read with snapshot support.
 */
export async function userProfileReadEnhanced(sessionId, snapshotMode = false) {
    return withReadLock(storageLock, async () => {
        if (snapshotMode) {
            if (!sessionId)
                throw new Error("session_id is required when mode is snapshot.");
            const snapshot = getMemorySnapshot(sessionId);
            if (!snapshot)
                throw new Error(`No active snapshot found for session ${sessionId}`);
            return {
                content: snapshot.user_profile,
                source: "snapshot",
                captured_at: new Date(snapshot.captured_at).toISOString(),
            };
        }
        const liveContent = await _userProfileRead();
        return {
            content: liveContent,
            source: "live",
        };
    });
}
/**
 * Memory board write with lock protection.
 */
export async function memoryBoardWriteEnhanced(action, content, oldText, operationName) {
    return withWriteLock(storageLock, async () => {
        return _memoryBoardWrite(action, content, oldText, operationName);
    });
}
/**
 * Memory board batch write with lock protection.
 */
export async function memoryBoardBatchWriteEnhanced(operations, operationName) {
    return withWriteLock(storageLock, async () => {
        return _memoryBoardBatchWrite(operations, operationName);
    });
}
/**
 * User profile write with lock protection.
 */
export async function userProfileWriteEnhanced(action, content, oldText, operationName) {
    return withWriteLock(storageLock, async () => {
        return _userProfileWrite(action, content, oldText, operationName);
    });
}
/**
 * User profile batch write with lock protection.
 */
export async function userProfileBatchWriteEnhanced(operations, operationName) {
    return withWriteLock(storageLock, async () => {
        return _userProfileBatchWrite(operations, operationName);
    });
}
/**
 * Session lifecycle: Capture snapshot at session start.
 */
export async function captureSessionSnapshot(sessionId) {
    return withReadLock(storageLock, async () => {
        markPendingCapture(sessionId);
        const raw = await getRawMemoryStores();
        const snapshot = captureMemorySnapshot(sessionId, raw.memory_board, raw.user_profile);
        return {
            success: true,
            message: `Snapshot captured for session ${sessionId}`,
            snapshot_info: {
                memory_board_chars: raw.memory_board.used_chars,
                user_profile_chars: raw.user_profile.used_chars,
                captured_at: new Date(snapshot.captured_at).toISOString(),
            },
        };
    });
}
/**
 * Session lifecycle: Release snapshot at session end.
 */
export function releaseSessionSnapshot(sessionId) {
    // G5-fix: check if snapshot exists before claiming success
    const existing = getMemorySnapshot(sessionId);
    const captureInProgress = isCapturePending(sessionId); // J4-fix: check for in-progress capture
    releaseMemorySnapshot(sessionId); // J4-fix: defers release if capture is pending
    if (existing) {
        return {
            success: true,
            message: `Snapshot released for session ${sessionId}`,
        };
    }
    if (captureInProgress) {
        // J4-fix: capture was in progress, release deferred — will be cleaned up when capture completes
        return {
            success: true,
            message: `Snapshot release deferred (capture in progress) for session ${sessionId}`,
        };
    }
    return {
        success: false,
        message: `No active snapshot found for session ${sessionId}`,
    };
}

// ============================================================
// Storage enhancements: in-process coordination and frozen snapshots
// ============================================================

import { AsyncLock, withReadLock, withWriteLock } from "./async_lock.js";
import {
  cancelPendingCapture,
  captureMemorySnapshot,
  getMemorySnapshot,
  isCapturePending,
  markPendingCapture,
  memorySnapshotFingerprints,
  releaseMemorySnapshot,
} from "./memory_snapshot.js";
import {
  getRawMemoryStores,
  memoryBoardRead as _memoryBoardRead,
  memoryBoardWrite as _memoryBoardWrite,
  memoryBoardBatchWrite as _memoryBoardBatchWrite,
  userProfileRead as _userProfileRead,
  userProfileWrite as _userProfileWrite,
  userProfileBatchWrite as _userProfileBatchWrite,
} from "../storage.js";

// MemoryBoardOperation type (from storage.ts)
type MemoryBoardOperation = {
  action: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
};

/**
 * Global locks for storage operations.
 */
export const storageLock = new AsyncLock();

/**
 * Enhanced memory board write result with snapshot info.
 */
export interface EnhancedMemoryBoardResult {
  success: boolean;
  error?: string;
  entries?: any[];
  used_chars?: number;
  char_limit?: number;
  snapshot_frozen?: boolean;
  snapshot_captured_at?: string;
  note?: string;
}

/**
 * Memory board read with snapshot support.
 * 
 * @param sessionId - Optional session ID for snapshot mode
 * @param snapshotMode - If true, return frozen snapshot (for system prompt)
 */
export async function memoryBoardReadEnhanced(
  sessionId?: string,
  snapshotMode = false
): Promise<{
  content: string;
  source: "snapshot" | "live";
  captured_at?: string;
  captured_fingerprint?: string;
  live_fingerprint?: string;
  captured_combined_fingerprint?: string;
  live_combined_fingerprint?: string;
  live_changed_since_capture?: boolean;
}> {
  return withReadLock(storageLock, async () => {
    if (snapshotMode) {
      if (!sessionId) throw new Error("session_id is required when mode is snapshot.");
      const snapshot = getMemorySnapshot(sessionId);
      if (!snapshot) throw new Error(`No active snapshot found for session ${sessionId}`);
      const live = await getRawMemoryStores();
      const liveFingerprints = memorySnapshotFingerprints(live.memory_board, live.user_profile);
      return {
        content: snapshot.memory_board,
        source: "snapshot" as const,
        captured_at: new Date(snapshot.captured_at).toISOString(),
        captured_fingerprint: snapshot.fingerprints.memory_board,
        live_fingerprint: liveFingerprints.memory_board,
        captured_combined_fingerprint: snapshot.fingerprints.combined,
        live_combined_fingerprint: liveFingerprints.combined,
        live_changed_since_capture: snapshot.fingerprints.combined !== liveFingerprints.combined,
      };
    }

    // Live mode: return current state
    const liveContent = await _memoryBoardRead();
    return {
      content: liveContent,
      source: "live" as const,
    };
  });
}

/**
 * User profile read with snapshot support.
 */
export async function userProfileReadEnhanced(
  sessionId?: string,
  snapshotMode = false
): Promise<{
  content: string;
  source: "snapshot" | "live";
  captured_at?: string;
  captured_fingerprint?: string;
  live_fingerprint?: string;
  captured_combined_fingerprint?: string;
  live_combined_fingerprint?: string;
  live_changed_since_capture?: boolean;
}> {
  return withReadLock(storageLock, async () => {
    if (snapshotMode) {
      if (!sessionId) throw new Error("session_id is required when mode is snapshot.");
      const snapshot = getMemorySnapshot(sessionId);
      if (!snapshot) throw new Error(`No active snapshot found for session ${sessionId}`);
      const live = await getRawMemoryStores();
      const liveFingerprints = memorySnapshotFingerprints(live.memory_board, live.user_profile);
      return {
        content: snapshot.user_profile,
        source: "snapshot" as const,
        captured_at: new Date(snapshot.captured_at).toISOString(),
        captured_fingerprint: snapshot.fingerprints.user_profile,
        live_fingerprint: liveFingerprints.user_profile,
        captured_combined_fingerprint: snapshot.fingerprints.combined,
        live_combined_fingerprint: liveFingerprints.combined,
        live_changed_since_capture: snapshot.fingerprints.combined !== liveFingerprints.combined,
      };
    }

    const liveContent = await _userProfileRead();
    return {
      content: liveContent,
      source: "live" as const,
    };
  });
}

/**
 * Memory board write with lock protection.
 */
export async function memoryBoardWriteEnhanced(
  action: "add" | "replace" | "remove",
  content?: string,
  oldText?: string,
  operationName?: string
): Promise<any> {
  return withWriteLock(storageLock, async () => {
    return _memoryBoardWrite(action, content, oldText, operationName);
  });
}

/**
 * Memory board batch write with lock protection.
 */
export async function memoryBoardBatchWriteEnhanced(
  operations: MemoryBoardOperation[],
  operationName?: string
): Promise<any> {
  return withWriteLock(storageLock, async () => {
    return _memoryBoardBatchWrite(operations, operationName);
  });
}

/**
 * User profile write with lock protection.
 */
export async function userProfileWriteEnhanced(
  action: "add" | "replace" | "remove",
  content?: string,
  oldText?: string,
  operationName?: string
): Promise<any> {
  return withWriteLock(storageLock, async () => {
    return _userProfileWrite(action, content, oldText, operationName);
  });
}

/**
 * User profile batch write with lock protection.
 */
export async function userProfileBatchWriteEnhanced(
  operations: MemoryBoardOperation[],
  operationName?: string
): Promise<any> {
  return withWriteLock(storageLock, async () => {
    return _userProfileBatchWrite(operations, operationName);
  });
}

/**
 * Session lifecycle: Capture snapshot at session start.
 */
export async function captureSessionSnapshot(
  sessionId: string,
): Promise<{
  success: boolean;
  message: string;
  snapshot_info: {
    memory_board_chars: number;
    user_profile_chars: number;
    captured_at: string;
    fingerprints: { memory_board: string; user_profile: string; combined: string };
  };
}> {
  return withReadLock(storageLock, async () => {
    markPendingCapture(sessionId);
    try {
      const raw = await getRawMemoryStores();
      const snapshot = captureMemorySnapshot(sessionId, raw.memory_board, raw.user_profile);
      return {
        success: true,
        message: `Snapshot captured for session ${sessionId}`,
        snapshot_info: {
          memory_board_chars: raw.memory_board.used_chars,
          user_profile_chars: raw.user_profile.used_chars,
          captured_at: new Date(snapshot.captured_at).toISOString(),
          fingerprints: { ...snapshot.fingerprints },
        },
      };
    } catch (error) {
      cancelPendingCapture(sessionId);
      throw error;
    }
  });
}

/**
 * Session lifecycle: Release snapshot at session end.
 */
export function releaseSessionSnapshot(sessionId: string): { success: boolean; message: string } {
  // G5-fix: check if snapshot exists before claiming success
  const existing = getMemorySnapshot(sessionId);
  const captureInProgress = isCapturePending(sessionId);  // J4-fix: check for in-progress capture
  releaseMemorySnapshot(sessionId);  // J4-fix: defers release if capture is pending
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

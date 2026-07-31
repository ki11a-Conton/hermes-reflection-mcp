export type HermesErrorCode =
  | "CURSOR_STALE"
  | "STORE_CORRUPT"
  | "SCOPE_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "REVIEW_IN_PROGRESS"
  | "OUTPUT_BUDGET_EXHAUSTED"
  | "TRANSFER_PATH_DENIED"
  | "CONFLICT_PENDING_APPROVAL";

export class HermesError extends Error {
  constructor(
    readonly code: HermesErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly next_step: string,
  ) {
    super(message);
    this.name = "HermesError";
  }
}

export function errorPayload(error: HermesError) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      reason: error.message,
      retryable: error.retryable,
      next_step: error.next_step,
    },
  };
}

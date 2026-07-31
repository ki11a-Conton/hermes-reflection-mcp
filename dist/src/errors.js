export class HermesError extends Error {
    code;
    retryable;
    next_step;
    constructor(code, message, retryable, next_step) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.next_step = next_step;
        this.name = "HermesError";
    }
}
export function errorPayload(error) {
    return {
        ok: false,
        error: {
            code: error.code,
            reason: error.message,
            retryable: error.retryable,
            next_step: error.next_step,
        },
    };
}

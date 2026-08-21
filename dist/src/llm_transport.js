import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { canonicalizeStable } from "./stable_order.js";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CONTRACT_REQUEST_CHARS = 64_000;
const MAX_CONTRACT_RESPONSE_BYTES = 256 * 1024;
const MAX_CONTRACT_COMPLETION_TOKENS = 4_096;
const ChatResponseSchema = z.object({
    choices: z.array(z.object({
        message: z.object({ content: z.string() }).passthrough(),
    }).passthrough()).min(1),
}).passthrough();
function truthy(value) {
    return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}
function isLoopback(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalized === "localhost" || normalized === "::1")
        return true;
    return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}
function resolveEndpoint(baseUrl) {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password)
        throw new Error("LLM base URL must not contain credentials.");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
        throw new Error("LLM base URL must use HTTPS; loopback HTTP is allowed only for a local provider.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("LLM base URL must use HTTP or HTTPS.");
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
    parsed.search = "";
    parsed.hash = "";
    return parsed;
}
function readConfig() {
    const enabled = truthy(process.env.HERMES_REFLECTION_LLM_ENABLED);
    if (!enabled) {
        return {
            readiness: {
                state: "waiting_for_provider",
                enabled: false,
                ready: false,
                error: "Automatic LLM review is disabled.",
            },
        };
    }
    const baseUrl = process.env.HERMES_REFLECTION_LLM_BASE_URL?.trim();
    const model = process.env.HERMES_REFLECTION_LLM_MODEL?.trim();
    const apiKey = process.env.HERMES_REFLECTION_LLM_API_KEY?.trim();
    if (!baseUrl || !model || !apiKey) {
        return {
            readiness: {
                state: "waiting_for_provider",
                enabled: true,
                ready: false,
                error: "Set dedicated LLM base URL, model, and API key environment variables.",
            },
        };
    }
    if (model.length > 200) {
        return {
            readiness: {
                state: "configuration_error",
                enabled: true,
                ready: false,
                error: "LLM model name exceeds 200 characters.",
            },
        };
    }
    try {
        const endpoint = resolveEndpoint(baseUrl);
        const rawTimeout = Number(process.env.HERMES_REFLECTION_LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
        const timeoutMs = Number.isFinite(rawTimeout)
            ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(rawTimeout)))
            : DEFAULT_TIMEOUT_MS;
        return {
            config: { endpoint, model, apiKey, timeoutMs },
            readiness: {
                state: "ready",
                enabled: true,
                ready: true,
                provider_host: endpoint.host,
                model,
                timeout_ms: timeoutMs,
            },
        };
    }
    catch (error) {
        return {
            readiness: {
                state: "configuration_error",
                enabled: true,
                ready: false,
                error: error instanceof Error ? error.message : "Invalid LLM configuration.",
            },
        };
    }
}
export function getLlmRuntimeReadiness() {
    return readConfig().readiness;
}
export function getLlmRuntimeSemanticFingerprint(contract) {
    const { config, readiness } = readConfig();
    const provider = config
        ? {
            endpoint_origin: config.endpoint.origin,
            endpoint_path: config.endpoint.pathname,
            model: config.model,
        }
        : { readiness: readiness.state, enabled: readiness.enabled };
    return createHash("sha256").update(JSON.stringify(canonicalizeStable({ provider, contract })), "utf8").digest("hex");
}
function validPositiveInteger(value, maximum) {
    return Number.isInteger(value) && value > 0 && value <= maximum;
}
function validateContract(contract) {
    if (!contract.task_version.trim() || contract.task_version.length > 200)
        throw new Error("Invalid task version.");
    if (!contract.prompt_version.trim() || contract.prompt_version.length > 200)
        throw new Error("Invalid prompt version.");
    if (!contract.system_prompt.trim() || contract.system_prompt.length > 8_000)
        throw new Error("Invalid system prompt.");
    if (!validPositiveInteger(contract.max_request_chars, MAX_CONTRACT_REQUEST_CHARS))
        throw new Error("Invalid request bound.");
    if (!validPositiveInteger(contract.max_response_bytes, MAX_CONTRACT_RESPONSE_BYTES))
        throw new Error("Invalid response bound.");
    if (!validPositiveInteger(contract.max_completion_tokens, MAX_CONTRACT_COMPLETION_TOKENS))
        throw new Error("Invalid completion bound.");
}
function buildRequest(contract, model) {
    validateContract(contract);
    const body = JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: contract.max_completion_tokens,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: contract.system_prompt },
            { role: "user", content: JSON.stringify(contract.input) },
        ],
    });
    if (Array.from(body).length > contract.max_request_chars) {
        throw new Error("Bounded LLM request exceeds the contract size limit.");
    }
    return body;
}
async function retryDelay(attempt, signal) {
    const milliseconds = Math.min(2_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            if (error)
                reject(error);
            else
                resolve();
        };
        const timer = setTimeout(() => finish(), milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            finish(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}
async function readResponseBody(response, maximumBytes) {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maximumBytes)
        throw new Error("response_too_large");
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new Error("response_too_large");
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}
function failed(startedAt, readiness, errorClass, error) {
    return {
        success: false,
        readiness,
        duration_ms: Date.now() - startedAt,
        error_class: errorClass,
        error,
    };
}
export async function runBoundedJsonTask(contract, options = {}) {
    const startedAt = Date.now();
    const { config, readiness } = readConfig();
    if (!config) {
        return failed(startedAt, readiness, "configuration", readiness.error ?? "LLM provider is not configured.");
    }
    let body;
    try {
        body = buildRequest(contract, config.model);
    }
    catch {
        return failed(startedAt, readiness, "configuration", "Unable to build a bounded LLM request.");
    }
    const controller = new AbortController();
    let externallyAborted = false;
    const onExternalAbort = () => {
        externallyAborted = true;
        controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted)
        onExternalAbort();
    const timer = setTimeout(() => controller.abort(new Error("llm_timeout")), config.timeoutMs);
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let response;
            try {
                response = await fetch(config.endpoint, {
                    method: "POST",
                    redirect: "manual",
                    signal: controller.signal,
                    headers: {
                        authorization: `Bearer ${config.apiKey}`,
                        "content-type": "application/json",
                        accept: "application/json",
                    },
                    body,
                });
            }
            catch {
                if (controller.signal.aborted) {
                    return failed(startedAt, readiness, externallyAborted ? "aborted" : "timeout", externallyAborted ? "LLM task was cancelled." : "LLM task timed out.");
                }
                return failed(startedAt, readiness, "network", "LLM provider could not be reached.");
            }
            if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel().catch(() => undefined);
                return failed(startedAt, readiness, "provider_rejected", "LLM provider redirects are not followed.");
            }
            if (response.status === 401) {
                await response.body?.cancel().catch(() => undefined);
                return failed(startedAt, readiness, "authentication", "LLM provider rejected the API credential.");
            }
            if (response.status === 403) {
                await response.body?.cancel().catch(() => undefined);
                return failed(startedAt, readiness, "permission", "LLM provider denied this request.");
            }
            if (response.status === 429 || response.status >= 500) {
                await response.body?.cancel().catch(() => undefined);
                if (attempt === 0) {
                    try {
                        await retryDelay(attempt, controller.signal);
                    }
                    catch {
                        return failed(startedAt, readiness, externallyAborted ? "aborted" : "timeout", externallyAborted ? "LLM task was cancelled." : "LLM task timed out.");
                    }
                    continue;
                }
                if (response.status === 429) {
                    return failed(startedAt, readiness, "quota", "LLM provider quota remained unavailable after one retry.");
                }
                return failed(startedAt, readiness, "provider_unavailable", "LLM provider remained unavailable after one retry.");
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                return failed(startedAt, readiness, "provider_rejected", `LLM provider rejected the request with HTTP ${response.status}.`);
            }
            try {
                const responseText = await readResponseBody(response, contract.max_response_bytes);
                const envelope = ChatResponseSchema.parse(JSON.parse(responseText));
                const content = envelope.choices[0].message.content.trim();
                if (content.startsWith("```"))
                    throw new Error("fenced_json_not_allowed");
                const output = contract.output_schema.parse(JSON.parse(content));
                return {
                    success: true,
                    readiness,
                    output,
                    duration_ms: Date.now() - startedAt,
                };
            }
            catch {
                return failed(startedAt, readiness, "invalid_response", "LLM provider returned invalid or oversized structured output.");
            }
        }
        return failed(startedAt, readiness, "provider_unavailable", "LLM provider was unavailable.");
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);
    }
}

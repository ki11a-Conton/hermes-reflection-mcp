import type { ReflectionStore } from "../types.js";

export const REFLECTION_RESOURCE_NAMES = [
  "reflections",
  "store_index",
  "resolved_questions",
] as const;

export type ReflectionResourceName = typeof REFLECTION_RESOURCE_NAMES[number];

export interface SerializedReflectionResources {
  reflections: string;
  store_index: string;
  resolved_questions: string;
}

/** Pure, deterministic serialization. Coordination, durability and recovery live in operation_journal.ts. */
export function serializeReflectionResources(
  store: ReflectionStore,
  resolvedQuestions?: Record<string, unknown>,
): SerializedReflectionResources {
  const normalized = structuredClone(store);
  const overlay: Record<string, unknown> = resolvedQuestions ?? {};
  if (resolvedQuestions === undefined) {
    normalized.reflections = normalized.reflections.map((reflection) => ({
      ...reflection,
      open_questions: reflection.open_questions.map((question, index) => {
        if (question.resolved === true) {
          overlay[`${reflection.id}:${index}`] = {
            resolved_at: question.resolved_at ?? reflection.timestamp,
            ...(question.resolved_by ? { resolved_by: question.resolved_by } : {}),
          };
          const { resolved: _resolved, resolved_at: _resolvedAt, resolved_by: _resolvedBy, ...rest } = question;
          return rest;
        }
        return question;
      }),
    }));
  }
  const indexStore = { ...normalized, reflections: undefined };
  const reflectionLines = normalized.reflections.map((reflection) => JSON.stringify(reflection)).join("\n");
  return {
    reflections: reflectionLines ? `${reflectionLines}\n` : "",
    store_index: `${JSON.stringify(indexStore, null, 2)}\n`,
    resolved_questions: `${JSON.stringify(overlay, null, 2)}\n`,
  };
}

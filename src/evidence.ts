import { createHash } from "node:crypto";
import type { HeuristicEvidence, HeuristicFeedback } from "../types.js";

export function normalizedLesson(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function lessonContentHash(lesson: string): string {
  return createHash("sha256").update(normalizedLesson(lesson), "utf8").digest("hex");
}

export function evidenceId(source: string, lesson: string): string {
  return createHash("sha256")
    .update(`${source}\0${normalizedLesson(lesson)}`, "utf8")
    .digest("hex");
}

export function evidenceSignal(items: HeuristicEvidence[]): number {
  return Math.min(new Set(items.map((item) => item.id)).size / 5, 1);
}

export function feedbackSignal(items: HeuristicFeedback[]): number {
  let helpful = 0;
  let harmful = 0;
  let irrelevant = 0;
  for (const item of items) {
    if (item.value === "helpful") helpful += 1;
    else if (item.value === "harmful") harmful += 1;
    else irrelevant += 1;
  }
  return (helpful - harmful - 0.5 * irrelevant) / (helpful + harmful + irrelevant + 2);
}

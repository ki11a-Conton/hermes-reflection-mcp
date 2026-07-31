import { createHash } from "node:crypto";
export function normalizedLesson(value) {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
}
export function lessonContentHash(lesson) {
    return createHash("sha256").update(normalizedLesson(lesson), "utf8").digest("hex");
}
export function evidenceId(source, lesson) {
    return createHash("sha256")
        .update(`${source}\0${normalizedLesson(lesson)}`, "utf8")
        .digest("hex");
}
export function evidenceSignal(items) {
    return Math.min(new Set(items.map((item) => item.id)).size / 5, 1);
}
export function feedbackSignal(items) {
    let helpful = 0;
    let harmful = 0;
    let irrelevant = 0;
    for (const item of items) {
        if (item.value === "helpful")
            helpful += 1;
        else if (item.value === "harmful")
            harmful += 1;
        else
            irrelevant += 1;
    }
    return (helpful - harmful - 0.5 * irrelevant) / (helpful + harmful + irrelevant + 2);
}

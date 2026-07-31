import { z } from "zod";

export type ResponseMode = "compact" | "full";

export const ResponseModeSchema = z.enum(["compact", "full"]).default("compact");

export const RESPONSE_MODE_JSON_SCHEMA = {
  type: "string",
  enum: ["compact", "full"],
  default: "compact",
  description: "Compact is context-efficient; full returns complete diagnostic detail.",
} as const;

export function isFullResponse(mode: ResponseMode): boolean {
  return mode === "full";
}

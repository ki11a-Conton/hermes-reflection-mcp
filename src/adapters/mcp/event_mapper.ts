import type { CompactionMetadata } from "../../compaction_handoff.js";
import type { CanonicalLifecycleEvent, LifecycleHostMetadata } from "../../lifecycle/events.js";
import { parseCanonicalLifecycleEvent } from "../../lifecycle/validation.js";
import type { RequestedSessionScope } from "../../session_scope.js";

export interface McpLifecycleEventInput {
  event: "start" | "end" | "postcompact";
  session_id: string;
  scope: RequestedSessionScope;
  occurred_at?: string;
  host_metadata?: LifecycleHostMetadata;
  compaction_metadata?: CompactionMetadata;
}

export function mapMcpLifecycleEvent(input: McpLifecycleEventInput): CanonicalLifecycleEvent {
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  const common = {
    schema_version: 1 as const,
    host: { name: "mcp" },
    session_id: input.session_id,
    occurred_at: occurredAt,
    occurred_at_source: "received" as const,
    scope: input.scope,
    ...(input.host_metadata ? { host_metadata: input.host_metadata } : {}),
  };

  switch (input.event) {
    case "start":
      return parseCanonicalLifecycleEvent({
        ...common,
        type: "session_start",
        identity: { key: `mcp:start:${input.session_id}`, source: "generated" },
        payload: { kind: "session_start" },
      });
    case "end":
      return parseCanonicalLifecycleEvent({
        ...common,
        type: "session_end",
        identity: { key: `mcp:end:${input.session_id}`, source: "generated" },
        payload: { kind: "session_end", reason: "client_end" },
      });
    case "postcompact":
      if (!input.compaction_metadata) {
        throw new Error("MCP_POSTCOMPACT_METADATA_REQUIRED: trusted compaction metadata is required");
      }
      return parseCanonicalLifecycleEvent({
        ...common,
        type: "post_compact",
        identity: {
          key: `mcp:postcompact:${input.session_id}:${input.compaction_metadata.generation}`,
          source: "derived",
        },
        payload: {
          kind: "post_compact",
          trusted_receipt: input.compaction_metadata,
        },
      });
  }
}

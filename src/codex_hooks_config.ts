import { win32 } from "node:path";

const DEFAULT_EVENTS = ["SessionStart", "SessionEnd", "PreCompact", "PostCompact"] as const;
const CAPTURE_EVENTS = ["UserPromptSubmit", "Stop"] as const;
const KNOWN_HERMES_HOOK_SUFFIX = "/dist/src/codex_hook_cli.js";

export interface HermesHookInstallOptions {
  node_path: string;
  hook_cli_path: string;
  capture_enabled: boolean;
}

type JsonObject = Record<string, unknown>;

function plainObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function normalizedPath(value: string): string {
  return win32.normalize(value.trim().replace(/^\\\\\?\\/, "")).replace(/\\/g, "/").toLowerCase();
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s&]+)/g;
  for (const match of command.matchAll(pattern)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (token && token !== "&") tokens.push(token.replace(/\\"/g, '"'));
  }
  return tokens;
}

function hookTarget(command: string): string | undefined {
  return commandTokens(command).find((token) => normalizedPath(token).endsWith(KNOWN_HERMES_HOOK_SUFFIX));
}

export function isHermesHookCommand(command: string, hookCliPath?: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const target = hookTarget(command);
  if (!target) return false;
  const normalizedTarget = normalizedPath(target);
  return hookCliPath === undefined
    ? /\/hermes-reflection-mcp(?:-v?\d+(?:\.\d+){1,2})?\/dist\/src\/codex_hook_cli\.js$/.test(normalizedTarget)
    : normalizedTarget === normalizedPath(hookCliPath);
}

function validateOptions(options: HermesHookInstallOptions): HermesHookInstallOptions {
  if (!options || typeof options !== "object") throw new Error("install options must be an object");
  if (typeof options.node_path !== "string" || !options.node_path.trim()) throw new Error("node_path must be a non-empty string");
  if (typeof options.hook_cli_path !== "string" || !options.hook_cli_path.trim()) {
    throw new Error("hook_cli_path must be a non-empty string");
  }
  if (typeof options.capture_enabled !== "boolean") throw new Error("capture_enabled must be boolean");
  if (!normalizedPath(options.hook_cli_path).endsWith(KNOWN_HERMES_HOOK_SUFFIX)) {
    throw new Error("hook_cli_path must target dist/src/codex_hook_cli.js");
  }
  return options;
}

function validateAndStripEvent(
  eventName: string,
  rawGroups: unknown,
  options: HermesHookInstallOptions,
): JsonObject[] {
  if (!Array.isArray(rawGroups)) throw new Error(`hooks.${eventName} must be an array`);
  const groups: JsonObject[] = [];
  for (const [groupIndex, rawGroup] of rawGroups.entries()) {
    const group = structuredClone(plainObject(rawGroup, `hooks.${eventName}[${groupIndex}]`));
    if (!Array.isArray(group.hooks)) throw new Error(`hooks.${eventName}[${groupIndex}].hooks must be an array`);
    const kept: JsonObject[] = [];
    for (const [hookIndex, rawHook] of group.hooks.entries()) {
      const hook = plainObject(rawHook, `hooks.${eventName}[${groupIndex}].hooks[${hookIndex}]`);
      if (hook.type === "command") {
        if (typeof hook.command !== "string" || !hook.command.trim()) {
          throw new Error(`hooks.${eventName}[${groupIndex}].hooks[${hookIndex}].command must be a non-empty string`);
        }
        if (isHermesHookCommand(hook.command, options.hook_cli_path) || isHermesHookCommand(hook.command)) continue;
      }
      kept.push(structuredClone(hook));
    }
    if (kept.length > 0) groups.push({ ...group, hooks: kept });
  }
  return groups;
}

function powershellQuoted(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}

function hermesHook(options: HermesHookInstallOptions): JsonObject {
  return {
    type: "command",
    command: `& ${powershellQuoted(options.node_path)} ${powershellQuoted(options.hook_cli_path)}`,
    timeout: 3,
  };
}

export function mergeCodexHooks(
  input: unknown,
  rawOptions: HermesHookInstallOptions,
): Record<string, unknown> {
  const options = validateOptions(rawOptions);
  const root = structuredClone(plainObject(input, "Codex hooks configuration"));
  const hooks = root.hooks === undefined ? {} : plainObject(root.hooks, "hooks");
  const mergedHooks: JsonObject = {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    const stripped = validateAndStripEvent(eventName, groups, options);
    if (stripped.length > 0) mergedHooks[eventName] = stripped;
  }
  const enabled = new Set<string>([
    ...DEFAULT_EVENTS,
    ...(options.capture_enabled ? CAPTURE_EVENTS : []),
  ]);
  for (const eventName of enabled) {
    const groups = Array.isArray(mergedHooks[eventName]) ? mergedHooks[eventName] as JsonObject[] : [];
    groups.push({ hooks: [hermesHook(options)] });
    mergedHooks[eventName] = groups;
  }
  root.hooks = mergedHooks;
  return JSON.parse(canonicalCodexHooksJson(root)) as Record<string, unknown>;
}

export function canonicalCodexHooksJson(value: unknown): string {
  return `${JSON.stringify(plainObject(value, "Codex hooks configuration"), null, 2)}\n`;
}

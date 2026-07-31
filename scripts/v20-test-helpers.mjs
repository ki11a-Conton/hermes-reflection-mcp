import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export { assert };

export async function withTempHome(name, fn) {
  const home = await mkdtemp(join(tmpdir(), `hermes-v20-${name}-`));
  try {
    return await fn(home);
  } finally {
    const absolute = resolve(home);
    assert.ok(absolute.startsWith(resolve(tmpdir())), `unsafe temp path: ${absolute}`);
    await rm(absolute, { recursive: true, force: true });
  }
}

export async function startMcp(home, extraEnv = {}) {
  const client = new Client({ name: "hermes-v20-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export function resultText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

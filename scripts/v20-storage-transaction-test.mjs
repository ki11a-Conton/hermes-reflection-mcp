import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startMcp, withTempHome } from "./v20-test-helpers.mjs";
import {
  assertOperationPhaseTransition,
  decodeOperationJournal,
} from "../dist/src/operation_journal.js";

const execFileAsync = promisify(execFile);

const FAILPOINTS = [
  ["after_prepare", "before"],
  ["after_json_stage", "before"],
  ["after_sqlite_stage", "before"],
  ["after_json_commit", "after"],
  ["after_sqlite_commit", "after"],
];

function payload(result) {
  return result.structuredContent ?? {};
}

function text(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${text(result)}`);
  return result;
}

async function seedBeforeState(home) {
  const server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    await callOk(server.client, "add_heuristic", {
      domain: "journal-test",
      heuristic: "before-json-marker",
      source_task: "seed recoverable transaction fixture",
      confidence: 0.8,
      tags: ["before"],
    });
    await callOk(server.client, "append_session_turn", {
      session_id: "before-sqlite-session",
      role: "user",
      content: "before-sqlite-marker",
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}

async function writeReplaceImport(home) {
  const imports = join(home, ".hermes-reflection", "transfers", "imports");
  await mkdir(imports, { recursive: true });
  await writeFile(join(imports, "replace.json"), JSON.stringify({
    heuristics: [{
      id: "after-json-id",
      domain: "journal-test",
      heuristic: "after-json-marker",
      source_task: "replace recoverable transaction fixture",
      confidence: 0.9,
      tags: ["after"],
    }],
  }), "utf8");
}

async function inspectState(home) {
  const server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const heuristics = payload(await callOk(server.client, "list_heuristics", {
      domain: "journal-test",
      limit: 20,
      response_mode: "full",
    })).items ?? [];
    const sessions = payload(await callOk(server.client, "search_sessions", {
      query: "before-sqlite-marker",
      limit: 20,
      response_mode: "full",
    })).items ?? [];
    return {
      beforeJson: heuristics.some((item) => item.heuristic === "before-json-marker"),
      afterJson: heuristics.some((item) => item.heuristic === "after-json-marker"),
      beforeSqlite: sessions.some((item) => item.session_id === "before-sqlite-session"),
    };
  } finally {
    await server.close().catch(() => undefined);
  }
}

function assertConverged(operation, expected, state) {
  if (expected === "before") {
    assert.equal(state.beforeJson, true, `${operation} must roll back JSON before commit`);
    assert.equal(state.afterJson, false, `${operation} rollback must not retain staged JSON`);
    assert.equal(state.beforeSqlite, true, `${operation} must roll back SQLite before commit`);
    return;
  }
  assert.equal(state.beforeJson, false, `${operation} committed JSON must not retain before-state`);
  assert.equal(state.beforeSqlite, false, `${operation} committed SQLite must not retain before-state`);
  assert.equal(state.afterJson, operation === "replace_import", `${operation} JSON after-state mismatch`);
}

async function assertJournalPrepared(home, operation, failpoint) {
  const journalPath = join(home, ".hermes-reflection", "operation_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(journal.schema_version, 1);
  assert.equal(journal.operation, operation);
  assert.match(journal.before.json, /^[a-f0-9]{64}$/);
  assert.match(journal.before.sqlite, /^[a-f0-9]{64}$/);
  assert.match(journal.after.json, /^[a-f0-9]{64}$/);
  assert.match(journal.after.sqlite, /^[a-f0-9]{64}$/);
  const expectedPhase = {
    after_prepare: "prepared",
    after_json_stage: "json_staged",
    after_sqlite_stage: "sqlite_staged",
    after_json_commit: "committing",
    after_sqlite_commit: "committing",
  }[failpoint];
  assert.equal(journal.phase, expectedPhase);
}

async function runInterruptedCase(operation, failpoint, expected) {
  await withTempHome(`${operation}-${failpoint}`, async (home) => {
    await seedBeforeState(home);
    if (operation === "replace_import") await writeReplaceImport(home);

    const failedServer = await startMcp(home, {
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      HERMES_TEST_OPERATION_FAILPOINT: failpoint,
    });
    try {
      const result = operation === "clear"
        ? await failedServer.client.callTool({
            name: "clear_data",
            arguments: { collection: "all", confirm: true },
          })
        : await failedServer.client.callTool({
            name: "import_data",
            arguments: { input_path: "replace.json", mode: "replace" },
          });
      assert.equal(result.isError, true, `${operation}/${failpoint} must interrupt before API success`);
      assert.match(text(result), /failpoint|interrupted|operation/i);
    } finally {
      await failedServer.close().catch(() => undefined);
    }

    await assertJournalPrepared(home, operation, failpoint);
    const recovered = await inspectState(home);
    assertConverged(operation, expected, recovered);

    const journalPath = resolve(home, ".hermes-reflection", "operation_journal.json");
    await assert.rejects(readFile(journalPath, "utf8"), /ENOENT/, "completed recovery must remove journal");
  });
}

async function runSuccessfulCase(operation) {
  await withTempHome(`${operation}-success`, async (home) => {
    await seedBeforeState(home);
    if (operation === "replace_import") await writeReplaceImport(home);
    const server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    try {
      const result = operation === "clear"
        ? await server.client.callTool({
            name: "clear_data",
            arguments: { collection: "all", confirm: true },
          })
        : await server.client.callTool({
            name: "import_data",
            arguments: { input_path: "replace.json", mode: "replace" },
          });
      assert.notEqual(result.isError, true, `${operation} success failed: ${text(result)}`);
    } finally {
      await server.close().catch(() => undefined);
    }
    assertConverged(operation, "after", await inspectState(home));
    await assert.rejects(
      readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"),
      /ENOENT/,
      "successful operation must remove its journal only after verification",
    );
  });
}

function testStrictJournalDecoder() {
  const id = "12345678-1234-4123-8123-123456789abc";
  const valid = {
    schema_version: 1,
    id,
    operation: "clear",
    phase: "prepared",
    created_at: "2026-07-29T00:00:00.000Z",
    before: { json: "a".repeat(64), sqlite: "b".repeat(64) },
    after: { json: "c".repeat(64), sqlite: "d".repeat(64) },
    staged_paths: [`operations/${id}/after-json.json`, `operations/${id}/after-sqlite.json`],
    backup_paths: [`operations/${id}/before-json.json`, `operations/${id}/before-sqlite.json`],
  };
  assert.deepEqual(decodeOperationJournal(valid), valid);
  assert.throws(() => decodeOperationJournal({ ...valid, unknown: true }), /unknown|missing/i);
  assert.throws(() => decodeOperationJournal({ ...valid, schema_version: 2 }), /schema_version/i);
  assert.throws(() => decodeOperationJournal({
    ...valid,
    staged_paths: ["../after-json.json", valid.staged_paths[1]],
  }), /path|unsafe/i);
  assert.throws(() => decodeOperationJournal({
    ...valid,
    after: { ...valid.after, json: "not-a-hash" },
  }), /SHA-256/i);
  assert.doesNotThrow(() => assertOperationPhaseTransition("prepared", "json_staged"));
  assert.throws(() => assertOperationPhaseTransition("prepared", "committing"), /non-monotonic/i);
  assert.throws(() => assertOperationPhaseTransition("committing", "sqlite_staged"), /non-monotonic/i);
}

async function enableWriteApproval(home) {
  const path = join(home, ".hermes-reflection", "store.json");
  const store = JSON.parse(await readFile(path, "utf8"));
  store.metadata.write_approval = true;
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function pendingItems(client) {
  return payload(await callOk(client, "list_pending_mutations", { response_mode: "full" })).items ?? [];
}

async function runApprovalReplayCase(interrupted) {
  await withTempHome(`approval-${interrupted ? "interrupted" : "success"}`, async (home) => {
    await seedBeforeState(home);
    await enableWriteApproval(home);
    let server = await startMcp(home, {
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      ...(interrupted ? { HERMES_TEST_OPERATION_FAILPOINT: "after_json_commit" } : {}),
    });
    let mutationId;
    try {
      const queued = await server.client.callTool({
        name: "clear_data",
        arguments: { collection: "all", confirm: true },
      });
      assert.equal(queued.isError, true, "write approval must queue clear instead of starting a journal");
      assert.match(text(queued), /queued for approval/i);
      await assert.rejects(
        readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"),
        /ENOENT/,
        "journal must begin only after typed approval",
      );
      const pending = await pendingItems(server.client);
      assert.equal(pending.length, 1);
      mutationId = pending[0].id;
      const approved = await server.client.callTool({
        name: "approve_pending_mutation",
        arguments: { mutation_id: mutationId, decision: "approve" },
      });
      if (interrupted) {
        assert.equal(approved.isError, true, "interrupted replay must not report approval success");
        assert.match(text(approved), /failpoint|interrupted/i);
      } else {
        assert.notEqual(approved.isError, true, text(approved));
        assert.equal((await pendingItems(server.client)).length, 0, "completed replay must remove approval");
      }
    } finally {
      await server.close().catch(() => undefined);
    }

    if (interrupted) {
      await assertJournalPrepared(home, "clear", "after_json_commit");
      server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
      try {
        const pending = await pendingItems(server.client);
        assert.equal(pending.length, 1, "failed replay approval must survive recovery");
        assert.equal(pending[0].id, mutationId);
        assert.equal(pending[0].state, "pending");
        const replayed = await server.client.callTool({
          name: "approve_pending_mutation",
          arguments: { mutation_id: mutationId, decision: "approve" },
        });
        assert.notEqual(replayed.isError, true, text(replayed));
        assert.equal((await pendingItems(server.client)).length, 0, "approval is removed only after completed replay");
      } finally {
        await server.close().catch(() => undefined);
      }
    }
    assertConverged("clear", "after", await inspectState(home));
  });
}

async function testJournalBypassIsAsyncLocal() {
  await withTempHome("journal-bypass", async (home) => {
    await seedBeforeState(home);
    await writeFile(join(home, ".hermes-reflection", "operation_journal.json"), "{}\n", "utf8");
    const storageUrl = new URL("../dist/storage.js", import.meta.url).href;
    const script = `
      const storage = await import(${JSON.stringify(storageUrl)});
      let release;
      const held = storage.withOperationJournalStoreMutation(async () => {
        await new Promise((resolve) => { release = resolve; });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      let blocked = false;
      try {
        await storage.upsertHeuristic({
          domain: "journal-test",
          heuristic: "unrelated write must remain blocked",
          source_task: "async-local journal bypass test",
          confidence: 0.8,
        });
      } catch (error) {
        blocked = /pending startup recovery|temporarily blocked/i.test(String(error));
      } finally {
        release();
        await held;
      }
      if (!blocked) throw new Error("unrelated async write inherited operation-journal bypass");
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  });
}

async function testConcurrentPartialReplaceImports() {
  await withTempHome("concurrent-replace", async (home) => {
    await seedBeforeState(home);
    const imports = join(home, ".hermes-reflection", "transfers", "imports");
    await mkdir(imports, { recursive: true });
    await writeFile(join(imports, "replace-heuristics.json"), JSON.stringify({
      heuristics: [{
        id: "concurrent-after-heuristic",
        domain: "journal-test",
        heuristic: "concurrent-after-json-marker",
        source_task: "concurrent partial replace",
        confidence: 0.9,
      }],
    }), "utf8");
    await writeFile(join(imports, "replace-board.json"), JSON.stringify({
      memory_board: {
        entries: [{
          id: "concurrent-board-entry",
          content: "concurrent-board-marker",
          created_at: "2026-07-29T00:00:00.000Z",
          updated_at: "2026-07-29T00:00:00.000Z",
        }],
        char_limit: 2200,
        used_chars: 23,
      },
    }), "utf8");
    const first = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    const second = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    try {
      const [heuristicResult, boardResult] = await Promise.all([
        first.client.callTool({
          name: "import_data",
          arguments: { input_path: "replace-heuristics.json", mode: "replace" },
        }),
        second.client.callTool({
          name: "import_data",
          arguments: { input_path: "replace-board.json", mode: "replace" },
        }),
      ]);
      assert.notEqual(heuristicResult.isError, true, text(heuristicResult));
      assert.notEqual(boardResult.isError, true, text(boardResult));
    } finally {
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
    }
    const verifier = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    try {
      const heuristics = payload(await callOk(verifier.client, "list_heuristics", {
        domain: "journal-test",
        limit: 20,
        response_mode: "full",
      })).items ?? [];
      const board = payload(await callOk(verifier.client, "memory_board_read", {
        response_mode: "full",
      }));
      assert.ok(
        heuristics.some((item) => item.heuristic === "concurrent-after-json-marker"),
        "concurrent partial replace lost the other operation's heuristic collection",
      );
      assert.ok(
        (board.items ?? board.entries ?? []).some((item) => item.content.includes("concurrent-board-marker")),
        `concurrent partial replace lost the other operation's Memory Board collection: ${JSON.stringify(board)}`,
      );
    } finally {
      await verifier.close().catch(() => undefined);
    }
  });
}

testStrictJournalDecoder();
await testJournalBypassIsAsyncLocal();
await testConcurrentPartialReplaceImports();
for (const [failpoint, expected] of FAILPOINTS) {
  await runInterruptedCase("clear", failpoint, expected);
  await runInterruptedCase("replace_import", failpoint, expected);
}
await runSuccessfulCase("clear");
await runSuccessfulCase("replace_import");
await runApprovalReplayCase(false);
await runApprovalReplayCase(true);

console.log("Hermes v20 recoverable cross-store transaction tests passed.");

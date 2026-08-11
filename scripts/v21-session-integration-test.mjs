import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { resultText, startMcp, withTempHome } from "./v20-test-helpers.mjs";

const SECRET_URL = "https://user:pass@example.test";

function visible(result) {
  return JSON.stringify(result);
}

function expectOk(result, label) {
  assert.equal(result.isError, undefined, `${label}: ${resultText(result)}`);
}

function expectScopeError(result, code, label) {
  assert.equal(result.isError, true, `${label} unexpectedly succeeded: ${visible(result)}`);
  assert.match(resultText(result), new RegExp(code), `${label} returned the wrong error`);
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

async function verifyProjectIsolationAndRestart(home) {
  let peer = await startMcp(home);
  try {
    expectOk(await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: "beta-session", project_key: "beta",
    }), "beta lifecycle start");
    expectOk(await call(peer.client, "append_session_turn", {
      session_id: "beta-session",
      role: "user",
      content: `beta_scope_probe ${SECRET_URL} ${"x".repeat(9000)}`,
      project_key: "beta",
    }), "beta append");
    for (let index = 0; index < 30; index += 1) {
      expectOk(await call(peer.client, "append_session_turn", {
        session_id: "beta-session",
        role: index % 2 === 0 ? "assistant" : "user",
        content: `beta_scope_probe cursor_${index} ${"y".repeat(4000)}`,
        project_key: "beta",
      }), `beta cursor fixture ${index}`);
    }

    const activeBound = await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "beta-session:0", section: "content",
    });
    expectOk(activeBound, "active exact binding without project_key");

    expectOk(await call(peer.client, "session_lifecycle_hook", {
      event: "end", session_id: "beta-session", project_key: "beta",
    }), "beta lifecycle end");
  } finally {
    await peer.close();
  }

  peer = await startMcp(home);
  try {
    const alphaDetail = await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "beta-session:0", project_key: "alpha",
    });
    expectScopeError(alphaDetail, "SCOPE_MISMATCH", "alpha detail read");

    const alphaScroll = await call(peer.client, "scroll_session_context", {
      session_id: "beta-session", around_turn_index: 0, window: 2, project_key: "alpha",
    });
    expectScopeError(alphaScroll, "SCOPE_MISMATCH", "alpha scroll");

    const alphaSearch = await call(peer.client, "search_sessions", {
      query: "beta_scope_probe", limit: 10, project_key: "alpha",
    });
    expectOk(alphaSearch, "alpha search");
    assert.deepEqual(alphaSearch.structuredContent?.items ?? [], [], "alpha search returned beta data");

    const alphaCompact = await call(peer.client, "compact_session_context", {
      session_id: "beta-session", project_key: "alpha",
    });
    expectScopeError(alphaCompact, "SCOPE_MISMATCH", "alpha compact");

    const missingScope = await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "beta-session:0",
    });
    expectScopeError(missingScope, "SCOPE_REQUIRED", "released project session without scope");

    const betaDetail = await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "beta-session:0", section: "content", project_key: "beta",
    });
    expectOk(betaDetail, "beta detail read");
    assert.doesNotMatch(visible(betaDetail), /user:pass/, "session detail leaked credential URL userinfo");
    assert.doesNotMatch(visible(betaDetail), /https:\/\/user:pass@example\.test/, "session detail leaked secret URL");

    const betaScroll = await call(peer.client, "scroll_session_context", {
      session_id: "beta-session", around_turn_index: 0, window: 2, project_key: "beta",
    });
    expectOk(betaScroll, "beta scroll");
    assert.doesNotMatch(visible(betaScroll), /user:pass/, "scroll leaked credential URL userinfo");
    const wideScroll = await call(peer.client, "scroll_session_context", {
      session_id: "beta-session", around_turn_index: 15, window: 50, project_key: "beta",
    });
    expectOk(wideScroll, "wide beta scroll");
    assert.ok(wideScroll.structuredContent?.next_cursor, "wide scroll did not produce a cursor");
    const wrongScrollContext = await call(peer.client, "scroll_session_context", {
      session_id: "beta-session", around_turn_index: 14, window: 50, project_key: "beta",
      cursor: wideScroll.structuredContent.next_cursor,
    });
    assert.equal(wrongScrollContext.isError, true, "scroll cursor crossed anchor context");
    assert.match(resultText(wrongScrollContext), /CURSOR_STALE|SCOPE_/);

    const betaSearch = await call(peer.client, "search_sessions", {
      query: "beta_scope_probe", limit: 100, project_key: "beta",
    });
    expectOk(betaSearch, "beta search");
    assert.equal(betaSearch.structuredContent?.items?.[0]?.session_id, "beta-session");
    assert.doesNotMatch(visible(betaSearch), /user:pass/, "search leaked credential URL userinfo");
    assert.ok(betaSearch.structuredContent?.next_cursor, "session search did not produce a cursor");
    const wrongSearchQuery = await call(peer.client, "search_sessions", {
      query: "different_query", limit: 10, project_key: "beta",
      cursor: betaSearch.structuredContent.next_cursor,
    });
    assert.equal(wrongSearchQuery.isError, true, "search cursor crossed query context");
    assert.match(resultText(wrongSearchQuery), /CURSOR_STALE|SCOPE_/);

    const betaCompact = await call(peer.client, "compact_session_context", {
      session_id: "beta-session", project_key: "beta", max_chars: 10000,
    });
    expectOk(betaCompact, "beta compact");
    assert.doesNotMatch(visible(betaCompact), /user:pass/, "compact leaked credential URL userinfo");
    assert.ok(betaCompact.structuredContent?.next_cursor, "compact context did not produce a cursor");
    const betaCompactNext = await call(peer.client, "compact_session_context", {
      session_id: "beta-session", project_key: "beta", max_chars: 10000,
      cursor: betaCompact.structuredContent.next_cursor,
    });
    expectOk(betaCompactNext, "beta compact continuation");
    assert.doesNotMatch(visible(betaCompactNext), /user:pass/, "compact continuation leaked credential URL userinfo");
    const wrongCompactContext = await call(peer.client, "compact_session_context", {
      session_id: "beta-session", project_key: "beta", max_chars: 5000,
      cursor: betaCompact.structuredContent.next_cursor,
    });
    assert.equal(wrongCompactContext.isError, true, "compact cursor crossed compaction context");
    assert.match(resultText(wrongCompactContext), /CURSOR_STALE|SCOPE_/);

    const firstPage = betaDetail.structuredContent;
    assert.equal(firstPage?.has_more, true, "long session detail did not produce a cursor");
    assert.ok(firstPage?.next_cursor, "long session detail omitted next_cursor");
    const wrongScopeCursor = await call(peer.client, "get_memory_item", {
      kind: "session_turn",
      id: "beta-session:0",
      section: "content",
      project_key: "alpha",
      cursor: firstPage.next_cursor,
    });
    assert.equal(wrongScopeCursor.isError, true, "cursor crossed resolved scope");
    assert.match(resultText(wrongScopeCursor), /SCOPE_MISMATCH|CURSOR_STALE/);

    const globalBypass = await call(peer.client, "scroll_session_context", {
      session_id: "beta-session", around_turn_index: 0, window: 1,
    });
    expectScopeError(globalBypass, "SCOPE_REQUIRED", "global/default project bypass");
  } finally {
    await peer.close();
  }
}

async function verifyAppendCompatibilityAndReuse(home) {
  let peer = await startMcp(home);
  try {
    expectOk(await call(peer.client, "append_session_turn", {
      session_id: "direct-global", role: "user", content: "explicit_global_probe",
    }), "unknown direct append defaults explicitly global");

    expectOk(await call(peer.client, "append_session_turn", {
      session_id: "direct-project", role: "user", content: "direct_project_probe", project_key: "alpha",
    }), "unknown direct append persists explicit project scope");

    expectOk(await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: "reused-session", project_key: "alpha",
    }), "reuse alpha start");
    const reused = await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: "reused-session", project_key: "beta",
    });
    expectScopeError(reused, "SCOPE_MISMATCH", "session id reused in another project");
    expectOk(await call(peer.client, "session_lifecycle_hook", {
      event: "end", session_id: "reused-session", project_key: "alpha",
    }), "reuse alpha end");
  } finally {
    await peer.close();
  }

  peer = await startMcp(home);
  try {
    expectOk(await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "direct-global:0",
    }), "persisted explicit global append after restart");
    const missingProject = await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "direct-project:0",
    });
    expectScopeError(missingProject, "SCOPE_REQUIRED", "direct project append missing scope after restart");
    expectOk(await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "direct-project:0", project_key: "alpha",
    }), "direct project append exact scope after restart");
    expectScopeError(await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: "reused-session", project_key: "beta",
    }), "SCOPE_MISMATCH", "ended session id reused after restart");
    expectOk(await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: "reused-session", project_key: "alpha",
    }), "failed reuse did not poison the exact persisted scope");
  } finally {
    await peer.close();
  }
}

async function verifyLegacyDenied(home) {
  let peer = await startMcp(home);
  expectOk(await call(peer.client, "search_sessions", { query: "" }), "initialize legacy fixture storage");
  await peer.close();

  const db = new Database(join(home, ".hermes-reflection", "sessions.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO session_meta
      (session_id, started_at, turn_count, last_turn_at, scope, updated_at, compaction_generation)
      VALUES (?, ?, 1, ?, 'legacy-unscoped', ?, 0)`).run("legacy-session", now, now, now);
    db.prepare(`INSERT INTO sessions_fts
      (session_id, turn_index, role, content, timestamp) VALUES (?, 0, 'user', ?, ?)`)
      .run("legacy-session", "legacy_scope_probe", now);
  } finally {
    db.close();
  }

  peer = await startMcp(home);
  try {
    for (const [name, args] of [
      ["get_memory_item", { kind: "session_turn", id: "legacy-session:0" }],
      ["scroll_session_context", { session_id: "legacy-session", around_turn_index: 0, window: 1 }],
      ["compact_session_context", { session_id: "legacy-session" }],
    ]) {
      expectScopeError(await call(peer.client, name, args), "LEGACY_SCOPE_DENIED", `legacy ${name}`);
    }
    const search = await call(peer.client, "search_sessions", { query: "legacy_scope_probe" });
    expectOk(search, "legacy search denial");
    assert.deepEqual(search.structuredContent?.items ?? [], [], "legacy data appeared in default search");
  } finally {
    await peer.close();
  }
}

async function verifyActiveCapacity(home) {
  const peer = await startMcp(home);
  try {
    for (let index = 0; index < 100; index += 1) {
      expectOk(await call(peer.client, "session_lifecycle_hook", {
        event: "start", session_id: `active-${index}`, project_key: "alpha",
      }), `active binding ${index}`);
    }
    const overflow = await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: "active-overflow", project_key: "alpha",
    });
    assert.equal(overflow.isError, true, "active binding capacity silently evicted an active session");
    assert.match(resultText(overflow), /capacity|active/i, "capacity error is not actionable");

    expectScopeError(await call(peer.client, "append_session_turn", {
      session_id: "active-overflow", role: "user", content: "must_not_default_global",
    }), "SCOPE_REQUIRED", "capacity failure retained authoritative project provenance");
    expectOk(await call(peer.client, "append_session_turn", {
      session_id: "active-overflow", role: "user", content: "overflow_project_probe", project_key: "alpha",
    }), "capacity failure retained exact persisted scope");

    expectOk(await call(peer.client, "append_session_turn", {
      session_id: "active-0", role: "user", content: "oldest_active_probe",
    }), "oldest active binding remained exact");
    expectOk(await call(peer.client, "get_memory_item", {
      kind: "session_turn", id: "active-0:0", project_key: "alpha",
    }), "oldest active turn remained in project scope");
  } finally {
    await peer.close();
  }
}

async function verifyScopeFilterBeforeLimit(home) {
  let peer = await startMcp(home);
  expectOk(await call(peer.client, "search_sessions", { query: "" }), "initialize scope-limit fixture storage");
  await peer.close();

  const db = new Database(join(home, ".hermes-reflection", "sessions.db"));
  try {
    const now = new Date().toISOString();
    const insertMeta = db.prepare(`INSERT INTO session_meta
      (session_id, started_at, turn_count, last_turn_at, scope, updated_at, compaction_generation)
      VALUES (?, ?, 1, ?, ?, ?, 0)`);
    const insertTurn = db.prepare(`INSERT INTO sessions_fts
      (session_id, turn_index, role, content, timestamp) VALUES (?, 0, 'user', 'scope_limit_probe', ?)`);
    const seed = db.transaction(() => {
      for (let index = 0; index < 105; index += 1) {
        const sessionId = `beta-limit-${index}`;
        insertMeta.run(sessionId, now, now, "project:beta", now);
        insertTurn.run(sessionId, now);
      }
      for (let index = 0; index < 5; index += 1) {
        const sessionId = `legacy-limit-${index}`;
        insertMeta.run(sessionId, now, now, "legacy-unscoped", now);
        insertTurn.run(sessionId, now);
      }
      insertMeta.run("alpha-after-limit", now, now, "project:alpha", now);
      insertTurn.run("alpha-after-limit", now);
    });
    seed();
  } finally {
    db.close();
  }

  peer = await startMcp(home);
  try {
    const alpha = await call(peer.client, "search_sessions", {
      query: "scope_limit_probe", limit: 10, project_key: "alpha",
    });
    expectOk(alpha, "scope filter before SQL limit");
    assert.deepEqual(
      alpha.structuredContent?.items?.map((item) => item.session_id) ?? [],
      ["alpha-after-limit"],
      "other scopes exhausted the global candidate limit before alpha filtering",
    );
  } finally {
    await peer.close();
  }
}

await withTempHome("v21-session-isolation", verifyProjectIsolationAndRestart);
await withTempHome("v21-session-append", verifyAppendCompatibilityAndReuse);
await withTempHome("v21-session-legacy", verifyLegacyDenied);
await withTempHome("v21-session-capacity", verifyActiveCapacity);
await withTempHome("v21-session-scope-limit", verifyScopeFilterBeforeLimit);
console.log("[PASS] v21 public session scope integration");

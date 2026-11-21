import { describe, expect, test } from "bun:test";
import {
  listMemoRevisions,
  mapMemoRevision,
  restoreMemoRevision,
  shouldSnapshotMemoRevision,
  trimMemoRevisionsStatement,
} from "./memo-revision-service.ts";

const current = {
  id: "memo_1",
  revision: 3,
  title: "Current",
  tags_json: '["tag"]',
  content_json: '{"type":"doc","content":[]}',
  content_markdown: "Current body",
  content_text: "Current body",
  content_hash: "current-hash",
};

const revision = {
  id: "revision_1",
  memo_id: "memo_1",
  revision: 2,
  title: "Previous",
  tags_json: '["old"]',
  content_json: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Previous body"}]}]}',
  content_markdown: "Previous body",
  content_text: "Previous body",
  content_hash: "previous-hash",
  created_by: "Owner",
  created_at: "2026-08-29T00:00:00.000Z",
};

const createStatement = (sql, firstValue = null, allResults = []) => ({
  sql,
  bindings: [],
  bind(...bindings) {
    this.bindings = bindings;
    return this;
  },
  async first() {
    return firstValue;
  },
  async all() {
    return { success: true, meta: {}, results: allResults };
  },
  async run() {
    return { success: true, meta: {}, results: [] };
  },
});

describe("memo revision service", () => {
  test("maps stored revision rows into the public contract", () => {
    expect(mapMemoRevision(revision)).toEqual({
      id: "revision_1",
      memoId: "memo_1",
      revision: 2,
      title: "Previous",
      tags: ["old"],
      contentMarkdown: "Previous body",
      contentText: "Previous body",
      contentHash: "previous-hash",
      createdBy: "Owner",
      createdByType: "user",
      createdByName: "Owner",
      createdAt: "2026-08-29T00:00:00.000Z",
    });
  });

  test("maps prefixed actors to a resolved display name and type", () => {
    expect(mapMemoRevision({
      ...revision,
      created_by: "user:usr_1",
      actor_name: "Ada Lovelace",
    })).toMatchObject({
      createdByType: "user",
      createdByName: "Ada Lovelace",
    });

    expect(mapMemoRevision({
      ...revision,
      created_by: "agent:tok_1",
      actor_name: "Claude Desktop",
    })).toMatchObject({
      createdByType: "agent",
      createdByName: "Claude Desktop",
    });

    expect(mapMemoRevision({
      ...revision,
      created_by: "user:deleted",
      actor_name: null,
    })).toMatchObject({
      createdByType: "user",
      createdByName: null,
    });
  });

  test("trims revisions beyond the per-memo retention limit", () => {
    const statement = createStatement("DELETE FROM memo_revisions");
    const database = { prepare: () => statement };

    trimMemoRevisionsStatement(database, "memo_1");

    expect(statement.sql).toContain("DELETE FROM memo_revisions");
    expect(statement.bindings).toEqual(["memo_1", "memo_1", 100]);
  });

  test("does not query revision history when the memo is unchanged", async () => {
    const database = {
      prepare: () => {
        throw new Error("Revision history should not be queried");
      },
    };

    await expect(shouldSnapshotMemoRevision(
      database,
      current,
      current.title,
      current.tags_json,
      current.content_hash,
      "2026-08-29T01:00:00.000Z",
    )).resolves.toBe(false);
  });

  test("lists revisions only after confirming memo visibility", async () => {
    const statement = createStatement("SELECT revisions", null, [revision]);
    const database = { prepare: () => statement };
    const visibilityChecks = [];

    const result = await listMemoRevisions(
      database,
      "workspace_1",
      "memo_1",
      25,
      async (_db, workspaceId, memoId, includeDeleted) => {
        visibilityChecks.push({ workspaceId, memoId, includeDeleted });
        return { id: memoId };
      },
      false,
    );

    expect(result).toEqual([mapMemoRevision(revision)]);
    expect(visibilityChecks).toEqual([{
      workspaceId: "workspace_1",
      memoId: "memo_1",
      includeDeleted: false,
    }]);
    expect(statement.bindings).toEqual(["memo_1", 25]);
  });

  test("restores a revision through one service-owned batch", async () => {
    const prepared = [];
    let batch = [];
    const database = {
      prepare: (sql) => {
        const statement = createStatement(sql, sql.includes("FROM memo_revisions mr") ? revision : null);
        prepared.push(statement);
        return statement;
      },
      batch: async (statements) => {
        batch = statements;
        return statements.map(() => ({ success: true, meta: {}, results: [] }));
      },
    };
    const restoredMemo = { id: "memo_1", revision: 4, title: "Previous" };

    const result = await restoreMemoRevision(
      database,
      "workspace_1",
      "memo_1",
      "revision_1",
      { actorType: "user", actorId: "user_1" },
      "Owner",
      {
        getMemoDetailRow: async () => current,
        getMemoDetail: async () => restoredMemo,
      },
    );

    expect(result).toBe(restoredMemo);
    expect(batch).toHaveLength(6);
    expect(prepared.some(({ sql }) => sql.includes("INSERT INTO memo_revisions"))).toBe(true);
    expect(prepared.some(({ sql }) => sql.includes("DELETE FROM memo_revisions"))).toBe(true);
    expect(prepared.some(({ sql }) => sql.includes("UPDATE memo_contents"))).toBe(true);
  });

  test("snapshots on an editor switch even inside the five-minute window", async () => {
    const latest = {
      ...revision,
      revision: 3,
      title: "Old title",
      tags_json: '["old"]',
      content_hash: "older-hash",
      created_by: "user:alice",
      created_at: "2026-08-29T00:59:00.000Z",
    };
    const database = { prepare: () => createStatement("SELECT latest", latest) };
    const now = "2026-08-29T01:00:00.000Z";

    await expect(shouldSnapshotMemoRevision(
      database,
      current,
      current.title,
      current.tags_json,
      "next-hash",
      now,
      "user:alice",
    )).resolves.toBe(false);

    await expect(shouldSnapshotMemoRevision(
      database,
      current,
      current.title,
      current.tags_json,
      "next-hash",
      now,
      "Owner",
    )).resolves.toBe(true);

    await expect(shouldSnapshotMemoRevision(
      database,
      current,
      current.title,
      current.tags_json,
      "next-hash",
      now,
      "user:bob",
    )).resolves.toBe(true);
  });

  test("pauses and refreshes an open collaboration room around a restore", async () => {
    const database = {
      prepare: (sql) => createStatement(sql, sql.includes("FROM memo_revisions mr") ? revision : null),
      batch: async (statements) => statements.map(() => ({ success: true, meta: {}, results: [] })),
    };
    const restoredMemo = { id: "memo_1", revision: 4, title: "Previous" };
    const order = [];
    let applied = null;

    await restoreMemoRevision(
      database,
      "workspace_1",
      "memo_1",
      "revision_1",
      { actorType: "user", actorId: "user_1" },
      "Owner",
      {
        getMemoDetailRow: async () => current,
        getMemoDetail: async () => restoredMemo,
      },
      {
        begin: async (memoId) => { order.push(["begin", memoId]); return null; },
        prepare: async (memoId, content) => ({
          statement: createStatement("INSERT INTO memo_collab_documents"),
          apply: async () => {
            order.push(["apply", memoId]);
            applied = content;
          },
        }),
        end: async (memoId) => order.push(["end", memoId]),
      },
    );

    expect(order).toEqual([["begin", "memo_1"], ["apply", "memo_1"], ["end", "memo_1"]]);
    expect(applied.contentJson.content[0].content[0].text).toBe("Previous body");
    expect(typeof applied.contentHash).toBe("string");
  });

  test("does not apply a live restore when the atomic collaboration write fails", async () => {
    const order = [];
    const collabStatement = createStatement("INSERT INTO memo_collab_documents");
    const database = {
      prepare: (sql) => createStatement(sql, sql.includes("FROM memo_revisions mr") ? revision : null),
      batch: async (statements) => {
        expect(statements).toHaveLength(7);
        expect(statements).toContain(collabStatement);
        order.push("batch");
        throw new Error("collaboration write failed");
      },
    };
    await expect(restoreMemoRevision(
      database, "workspace_1", "memo_1", "revision_1",
      { actorType: "user", actorId: "user_1" }, "Owner",
      { getMemoDetailRow: async () => current, getMemoDetail: async () => null },
      {
        begin: async () => { order.push("begin"); return null; },
        prepare: async () => ({ statement: collabStatement, apply: async () => { order.push("apply"); } }),
        end: async () => { order.push("end"); },
      },
    )).rejects.toThrow("collaboration write failed");
    expect(order).toEqual(["begin", "batch", "end"]);
  });

  test("resumes the room when reading the current memo fails", async () => {
    const order = [];
    await expect(restoreMemoRevision(
      { prepare: () => createStatement("SELECT"), batch: async () => [] },
      "workspace_1",
      "memo_1",
      "revision_1",
      { actorType: "user", actorId: "user_1" },
      "Owner",
      {
        getMemoDetailRow: async () => { throw new Error("database offline"); },
        getMemoDetail: async () => null,
      },
      {
        begin: async () => { order.push("begin"); return null; },
        prepare: async () => { throw new Error("Should not prepare a missing memo"); },
        end: async () => order.push("end"),
      },
    )).rejects.toThrow("database offline");

    expect(order).toEqual(["begin", "end"]);
  });

  test("filters archived versions before they leave the API", async () => {
    const archived = {
      ...revision,
      content_json: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "secret plan" }] }],
      }),
      content_markdown: "secret plan",
      content_text: "secret plan",
    };
    const database = { prepare: () => createStatement("SELECT revisions", null, [archived]) };

    const result = await listMemoRevisions(
      database,
      "workspace_1",
      "memo_1",
      10,
      async () => ({ id: "memo_1" }),
      false,
      () => ({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hidden by policy" }] }],
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].contentMarkdown).toBe("hidden by policy");
    expect(result[0].contentText).toBe("hidden by policy");
    expect(JSON.stringify(result[0])).not.toContain("secret plan");
  });
});

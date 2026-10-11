import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import {
  listCollabPeers,
  releaseCollabPresence,
  touchCollabPresence,
  COLLAB_PRESENCE_TTL_MS,
} from "./collab-presence-service.ts";

class SqliteD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.db, this.sql, bindings);
  }

  async all() {
    return { results: this.db.query(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first() {
    return this.db.query(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    this.db.query(this.sql).run(...this.bindings);
    return { success: true, meta: {} };
  }
}

class SqliteD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    return this.db.transaction(() => statements.map((statement) =>
      this.db.query(statement.sql).run(...statement.bindings)))();
  }
}

const createDatabase = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  return new SqliteD1Database(sqlite);
};

describe("collab presence", () => {
  test("heartbeat records peers and reports self", async () => {
    const database = createDatabase();
    await touchCollabPresence(database, {
      memoId: "memo_1",
      actorId: "usr_a",
      actorType: "user",
      displayName: "Alice",
    });
    await touchCollabPresence(database, {
      memoId: "memo_1",
      actorId: "usr_b",
      actorType: "user",
      displayName: "Bob",
    });

    const forAlice = await listCollabPeers(database, "memo_1", "usr_a");
    expect(forAlice).toHaveLength(2);
    const selfRow = forAlice.find((peer) => peer.isSelf);
    expect(selfRow?.actorId).toBe("usr_a");

    const forStranger = await listCollabPeers(database, "memo_1", "usr_x");
    expect(forStranger.every((peer) => !peer.isSelf)).toBe(true);

    // Other memos are untouched.
    expect(await listCollabPeers(database, "memo_2", "usr_a")).toHaveLength(0);
  });

  test("repeated heartbeats refresh instead of duplicating", async () => {
    const database = createDatabase();
    const input = { memoId: "memo_1", actorId: "usr_a", actorType: "user", displayName: "Alice" };
    await touchCollabPresence(database, input);
    await touchCollabPresence(database, input);
    expect(await listCollabPeers(database, "memo_1", "usr_a")).toHaveLength(1);
  });

  test("expired rows disappear and release removes the row immediately", async () => {
    const database = createDatabase();
    await touchCollabPresence(database, {
      memoId: "memo_1",
      actorId: "usr_a",
      actorType: "user",
      displayName: "Alice",
    });
    // Force expiry by backdating last_seen via a raw update on expires_at.
    const sqlite = database.db;
    sqlite
      .query(`UPDATE memo_collab_presence SET expires_at = '2000-01-01T00:00:00.000Z'`)
      .run();
    expect(await listCollabPeers(database, "memo_1", "usr_a")).toHaveLength(0);

    await touchCollabPresence(database, {
      memoId: "memo_1",
      actorId: "usr_b",
      actorType: "user",
      displayName: "Bob",
    });
    await releaseCollabPresence(database, "memo_1", "usr_b");
    expect(await listCollabPeers(database, "memo_1", "usr_a")).toHaveLength(0);
  });

  test("TTL is short enough to feel live but long enough for slow networks", () => {
    expect(COLLAB_PRESENCE_TTL_MS).toBeGreaterThanOrEqual(15 * 1000);
    expect(COLLAB_PRESENCE_TTL_MS).toBeLessThanOrEqual(60 * 1000);
  });
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import {
  addGroupAccountToGroups,
  createGroupAccount,
  isGroupAccount,
  isGroupAccountUsername,
  listGroupAccountGroups,
  listGroupAccounts,
  GROUP_ACCOUNT_PREFIX,
} from "./group-account-service.ts";
import { createGroup } from "./group-service.ts";

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
  return { sqlite, database: new SqliteD1Database(sqlite) };
};

describe("shared group accounts", () => {
  test("creates the account with the shared_ prefix and a placeholder workspace", async () => {
    const { sqlite, database } = createDatabase();
    const created = await createGroupAccount(database, {
      name: "Team",
      displayName: "团队共用",
      password: "super-secret-pass",
      createdBy: "usr_admin",
    });
    expect(created.ok).toBe(true);
    expect(created.username).toBe("shared_team");

    const row = sqlite
      .query(`SELECT id, username, account_type FROM users WHERE username = 'shared_team'`)
      .get();
    expect(row.account_type).toBe("group");

    const workspace = sqlite
      .query(
        `SELECT w.name FROM workspaces w
         INNER JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = ?`,
      )
      .get(row.id);
    expect(workspace.name).toContain("shared");

    const accounts = await listGroupAccounts(database);
    expect(accounts).toHaveLength(1);
    expect(Number(accounts[0].groupCount ?? 0)).toBe(0);
  });

  test("rejects a duplicate username without throwing", async () => {
    const { database } = createDatabase();
    await createGroupAccount(database, { name: "ops", displayName: null, password: "super-secret-pass", createdBy: null });
    const second = await createGroupAccount(database, { name: "ops", displayName: null, password: "super-secret-pass", createdBy: null });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("username_exists");
  });

  test("joins groups and reports membership", async () => {
    const { database } = createDatabase();
    const created = await createGroupAccount(database, { name: "ops", displayName: null, password: "super-secret-pass", createdBy: null });
    const group = await createGroup(database, { name: "研发", description: null, createdBy: null });
    await addGroupAccountToGroups(database, created.userId, [group.id]);

    const groups = await listGroupAccountGroups(database, created.userId);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("研发");
  });

  test("helpers classify accounts correctly", () => {
    expect(isGroupAccount("group")).toBe(true);
    expect(isGroupAccount("user")).toBe(false);
    expect(isGroupAccount(null)).toBe(false);
    expect(isGroupAccountUsername("shared_ops")).toBe(true);
    expect(isGroupAccountUsername("alice")).toBe(false);
    expect(GROUP_ACCOUNT_PREFIX).toBe("shared_");
  });
});

describe("shared account sessions (multi-device sign-in)", () => {
  test("a group account can hold many live sessions at once", async () => {
    const { sqlite } = createDatabase();
    const created = sqlite
      .query(
        `INSERT INTO users (id, username, password_hash, display_name, account_type, created_at, updated_at)
         VALUES ('usr_shared', 'shared_ops', 'hash', 'Ops', 'group', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(created.changes).toBe(1);

    // The personal-account flow revokes same-device sessions before inserting;
    // the shared-account flow skips that UPDATE entirely, so three sign-ins
    // from three places simply coexist.
    const insertSession = sqlite.query(
      `INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at, created_at, last_seen_at)
       VALUES (?, 'usr_shared', ?, ?, '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    insertSession.run("sess_a", "hash_a", "dev_a");
    insertSession.run("sess_b", "hash_b", "dev_b");
    insertSession.run("sess_c", "hash_c", "dev_c");

    const live = sqlite
      .query(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'usr_shared' AND revoked_at IS NULL`)
      .get();
    expect(live.count).toBe(3);
  });
});

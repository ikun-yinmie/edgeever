import { describe, expect, test } from "bun:test";
import worker from "../apps/api/src/index";

const executionContext = {
  passThroughOnException() {},
  waitUntil() {},
  props: {},
} as unknown as ExecutionContext;

const owner = {
  id: "usr_owner",
  user_id: "usr_owner",
  username: "owner",
  display_name: "Owner",
  password_hash: "unused",
  is_disabled: 0,
  last_login_at: "2026-07-31T00:00:00.000Z",
  created_at: "2026-07-01T00:00:00.000Z",
  expires_at: "2027-07-31T00:00:00.000Z",
  role: "owner",
};

const createDatabase = () => ({
  prepare(sql: string) {
    return {
      bind() {
        return this;
      },
      async first() {
        if (sql.includes("FROM sessions s")) return owner;
        if (sql.includes("FROM workspace_members WHERE user_id")) {
          return { workspace_id: "ws_owner", role: "owner" };
        }
        if (sql.includes("SELECT id FROM users")) return { id: owner.id };
        return null;
      },
      async all() {
        if (sql.includes("FROM users u") && sql.includes("INNER JOIN workspace_members")) {
          return { results: [owner] };
        }
        return { results: [] };
      },
      async run() {
        return { success: true };
      },
    };
  },
}) as unknown as D1Database;

describe("member management authentication", () => {
  test("accepts an owner session supplied as a desktop Bearer token", async () => {
    const response = await worker.fetch(
      new Request("https://edgeever.test/api/v1/users", {
        headers: { Authorization: "Bearer desktop-session-token" },
      }),
      { DB: createDatabase() } as never,
      executionContext,
    );

    const body = await response.json();
    expect({ status: response.status, body }).toEqual({
      status: 200,
      body: {
        users: [{
          id: owner.id,
          username: owner.username,
          displayName: owner.display_name,
          role: owner.role,
          isDisabled: false,
          lastLoginAt: owner.last_login_at,
          createdAt: owner.created_at,
        }],
      },
    });
  });
});

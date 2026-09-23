import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import {
  addGroupMembers,
  createGroup,
  createGroupShare,
  listGroupMembers,
  listGroupShares,
  listGroupsForUser,
  listSharedNotebookMemos,
  listSharedWithMe,
  resolveMemoAccess,
  resolveNotebookAccess,
  revokeGroupShare,
  updateGroupShare,
} from "./group-service.ts";

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

const createEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  const database = new SqliteD1Database(sqlite);

  const seedUser = (id, username) => {
    sqlite
      .query(
        `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, 'hash', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, username, username);
    sqlite
      .query(
        `INSERT INTO workspaces (id, name, is_personal, created_at, updated_at)
         VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(`ws_${id}`, `${username} workspace`);
    sqlite
      .query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', '2026-01-01T00:00:00.000Z')`)
      .run(`ws_${id}`, id);
  };

  const seedNotebook = (id, workspaceId, parentId = null) => {
    sqlite
      .query(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'notebook', '#000', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, workspaceId, parentId, id, id);
  };

  const seedMemo = (id, workspaceId, notebookId, isDeleted = 0) => {
    sqlite
      .query(
        `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt, tags_json, is_pinned,
            is_archived, is_deleted, source_memo_ids, merge_source_count, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '[]', 0, 0, ?, '[]', 0, 'user', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, workspaceId, notebookId, id, isDeleted);
  };

  return { sqlite, database, seedUser, seedNotebook, seedMemo };
};

describe("group administration", () => {
  test("adds the creator as a group manager and lists the group for them", async () => {
    const { database, seedUser } = createEnvironment();
    seedUser("usr_owner", "owner");

    const group = await createGroup(database, { name: "家庭", description: null, createdBy: "usr_owner" });
    expect(group).toMatchObject({ name: "家庭" });

    const members = await listGroupMembers(database, group.id);
    expect(members).toEqual([
      expect.objectContaining({ user_id: "usr_owner", role: "manager", username: "owner" }),
    ]);

    const groups = await listGroupsForUser(database, "usr_owner");
    expect(groups).toEqual([
      expect.objectContaining({ id: group.id, my_role: "manager", member_count: 1, share_count: 0 }),
    ]);
  });

  test("adds members idempotently", async () => {
    const { database, seedUser } = createEnvironment();
    seedUser("usr_owner", "owner");
    seedUser("usr_a", "alice");
    const group = await createGroup(database, { name: "家庭", description: null, createdBy: "usr_owner" });

    await addGroupMembers(database, group.id, ["usr_a"]);
    await addGroupMembers(database, group.id, ["usr_a"]);

    const members = await listGroupMembers(database, group.id);
    expect(members.map((member) => member.user_id).sort()).toEqual(["usr_a", "usr_owner"]);
  });
});

describe("shared notebook access", () => {
  const setup = async () => {
    const environment = createEnvironment();
    const { database, seedUser, seedNotebook, seedMemo } = environment;
    seedUser("usr_owner", "owner");
    seedUser("usr_a", "alice");
    seedUser("usr_b", "bob");
    seedUser("usr_c", "carol");

    seedNotebook("nb_root", "ws_usr_owner");
    seedNotebook("nb_child", "ws_usr_owner", "nb_root");
    seedNotebook("nb_other", "ws_usr_owner");
    seedMemo("memo_root", "ws_usr_owner", "nb_root");
    seedMemo("memo_child", "ws_usr_owner", "nb_child");
    seedMemo("memo_outside", "ws_usr_owner", "nb_other");

    const group = await createGroup(database, { name: "家庭", description: null, createdBy: "usr_owner" });
    await addGroupMembers(database, group.id, ["usr_a", "usr_b", "usr_c"]);
    return { ...environment, group };
  };

  const shareNotebook = async (database, groupId, editMode, editorUserIds = []) =>
    createGroupShare(database, {
      groupId,
      targetType: "notebook",
      targetId: "nb_root",
      sourceWorkspaceId: "ws_usr_owner",
      editMode,
      editorUserIds,
      note: null,
      createdBy: "usr_owner",
    });

  test("lets every member read the notebook and everything nested inside it", async () => {
    const { database, group } = await setup();
    await shareNotebook(database, group.id, "author");

    const child = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_child",
    });
    expect(child).toMatchObject({
      canRead: true,
      canEdit: false,
      isOwner: false,
      workspaceId: "ws_usr_owner",
      groupName: "家庭",
      editMode: "author",
    });

    const notebook = await resolveNotebookAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      notebookId: "nb_child",
    });
    expect(notebook).toMatchObject({ canRead: true, canEdit: false });
  });

  test("keeps unrelated notes and non-members out", async () => {
    const { database, group } = await setup();
    await shareNotebook(database, group.id, "group");

    const outside = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_outside",
    });
    expect(outside).toMatchObject({ canRead: false, canEdit: false });

    const stranger = await resolveMemoAccess(database, {
      userId: "usr_outsider",
      ownWorkspaceId: "ws_usr_outsider",
      memoId: "memo_root",
    });
    expect(stranger).toMatchObject({ canRead: false, canEdit: false });
  });

  test("gives everyone in the group edit rights when no editor list is set", async () => {
    const { database, group } = await setup();
    await shareNotebook(database, group.id, "group");

    const access = await resolveMemoAccess(database, {
      userId: "usr_b",
      ownWorkspaceId: "ws_usr_b",
      memoId: "memo_root",
    });
    expect(access).toMatchObject({ canRead: true, canEdit: true, editMode: "group" });
  });

  test("narrows editing to the listed members", async () => {
    const { database, group } = await setup();
    await shareNotebook(database, group.id, "group", ["usr_a"]);

    const allowed = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_root",
    });
    const denied = await resolveMemoAccess(database, {
      userId: "usr_b",
      ownWorkspaceId: "ws_usr_b",
      memoId: "memo_root",
    });
    expect(allowed).toMatchObject({ canRead: true, canEdit: true });
    expect(denied).toMatchObject({ canRead: true, canEdit: false });
  });

  test("hides deleted notes, revoked shares and keeps the owner untouched", async () => {
    const environment = await setup();
    const { database, group, seedMemo } = environment;
    await shareNotebook(database, group.id, "group");
    seedMemo("memo_trashed", "ws_usr_owner", "nb_root", 1);

    const trashed = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_trashed",
    });
    expect(trashed).toMatchObject({ canRead: false, canEdit: false });

    const owner = await resolveMemoAccess(database, {
      userId: "usr_owner",
      ownWorkspaceId: "ws_usr_owner",
      memoId: "memo_trashed",
    });
    expect(owner).toMatchObject({ isOwner: true, canRead: true, canEdit: true });

    const [share] = await listGroupShares(database, group.id);
    await revokeGroupShare(database, share.id);
    const afterRevoke = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_root",
    });
    expect(afterRevoke).toMatchObject({ canRead: false, canEdit: false });
  });

  test("shares a single note without exposing its notebook", async () => {
    const { database, group } = await setup();
    await createGroupShare(database, {
      groupId: group.id,
      targetType: "memo",
      targetId: "memo_child",
      sourceWorkspaceId: "ws_usr_owner",
      editMode: "group",
      editorUserIds: [],
      note: null,
      createdBy: "usr_owner",
    });

    const shared = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_child",
    });
    const sibling = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_root",
    });
    expect(shared).toMatchObject({ canRead: true, canEdit: true });
    expect(sibling).toMatchObject({ canRead: false, canEdit: false });
  });
});

describe("shared with me overview", () => {
  test("groups what is shared towards me and lists the notes inside a shared notebook", async () => {
    const environment = createEnvironment();
    const { database, seedUser, seedNotebook, seedMemo } = environment;
    seedUser("usr_owner", "owner");
    seedUser("usr_a", "alice");
    seedNotebook("nb_root", "ws_usr_owner");
    seedNotebook("nb_child", "ws_usr_owner", "nb_root");
    seedMemo("memo_root", "ws_usr_owner", "nb_root");
    seedMemo("memo_child", "ws_usr_owner", "nb_child");
    seedMemo("memo_shared", "ws_usr_owner", "nb_root");
    const family = await createGroup(database, { name: "家庭", description: null, createdBy: "usr_owner" });
    await addGroupMembers(database, family.id, ["usr_a"]);
    await createGroupShare(database, {
      groupId: family.id,
      targetType: "notebook",
      targetId: "nb_root",
      sourceWorkspaceId: "ws_usr_owner",
      editMode: "group",
      editorUserIds: ["usr_a"],
      note: "项目资料",
      createdBy: "usr_owner",
    });

    const shared = await listSharedWithMe(database, { userId: "usr_a", ownWorkspaceId: "ws_usr_a" });
    expect(shared.groups).toEqual([
      expect.objectContaining({ id: family.id, name: "家庭", shareCount: 1, memberCount: 2 }),
    ]);
    expect(shared.notebooks).toEqual([
      expect.objectContaining({ id: "nb_root", name: "nb_root", canEdit: true, memoCount: 3, groupName: "家庭" }),
    ]);
    expect(shared.memos).toEqual([]);

    const memos = await listSharedNotebookMemos(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      notebookId: "nb_root",
    });
    expect(memos.map((memo) => memo.id).sort()).toEqual(["memo_child", "memo_root", "memo_shared"]);
    expect(memos.every((memo) => memo.canEdit)).toBe(true);
  });

  test("does not list my own content as shared with me", async () => {
    const { database, seedUser, seedNotebook, seedMemo } = createEnvironment();
    seedUser("usr_owner", "owner");
    seedNotebook("nb_root", "ws_usr_owner");
    seedMemo("memo_root", "ws_usr_owner", "nb_root");
    const group = await createGroup(database, { name: "家庭", description: null, createdBy: "usr_owner" });
    await createGroupShare(database, {
      groupId: group.id,
      targetType: "notebook",
      targetId: "nb_root",
      sourceWorkspaceId: "ws_usr_owner",
      editMode: "author",
      editorUserIds: [],
      note: null,
      createdBy: "usr_owner",
    });

    const shared = await listSharedWithMe(database, { userId: "usr_owner", ownWorkspaceId: "ws_usr_owner" });
    expect(shared.notebooks).toEqual([]);
    expect(shared.groups).toEqual([
      expect.objectContaining({ id: group.id, shareCount: 0 }),
    ]);
  });

  test("updates the editing policy of an existing share", async () => {
    const { database, seedUser, seedNotebook, seedMemo } = createEnvironment();
    seedUser("usr_owner", "owner");
    seedUser("usr_a", "alice");
    seedNotebook("nb_root", "ws_usr_owner");
    seedMemo("memo_root", "ws_usr_owner", "nb_root");
    const group = await createGroup(database, { name: "家庭", description: null, createdBy: "usr_owner" });
    await addGroupMembers(database, group.id, ["usr_a"]);
    const shareId = await createGroupShare(database, {
      groupId: group.id,
      targetType: "notebook",
      targetId: "nb_root",
      sourceWorkspaceId: "ws_usr_owner",
      editMode: "author",
      editorUserIds: [],
      note: null,
      createdBy: "usr_owner",
    });

    await updateGroupShare(database, shareId, { editMode: "group", editorUserIds: ["usr_a"] });

    const access = await resolveMemoAccess(database, {
      userId: "usr_a",
      ownWorkspaceId: "ws_usr_a",
      memoId: "memo_root",
    });
    expect(access).toMatchObject({ canRead: true, canEdit: true, editMode: "group" });

    const [share] = await listGroupShares(database, group.id);
    expect(share).toMatchObject({ editMode: "group", editorUserIds: ["usr_a"] });
  });
});

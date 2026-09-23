import {
  GroupCreateSchema,
  GroupMembersAddSchema,
  GroupShareCreateSchema,
  GroupShareUpdateSchema,
  GroupUpdateSchema,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { auditStatement } from "./audit";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { apiError, forbidden, notFound, unauthorized } from "./http-errors";
import {
  addGroupMembers,
  createGroup,
  createGroupShare,
  deleteGroup,
  getGroupRow,
  getGroupShareRow,
  isGroupMember,
  listGroupMembers,
  listGroupShares,
  listGroupsForUser,
  listSharedNotebookMemos,
  listSharedWithMe,
  listSharesCreatedBy,
  removeGroupMember,
  resolveMemoAccess,
  resolveNotebookAccess,
  revokeGroupShare,
  updateGroup,
  updateGroupShare,
} from "./group-service";
import { getWorkspaceId, requireOwner } from "./request-auth";
import type { DatabaseAdapter } from "./storage-contract";

type GroupRouteDependencies = {
  authenticateRequest: (context: AppContext, touch: boolean) => Promise<AuthContext | null>;
};

export const registerGroupRoutes = (
  app: Hono<AppEnv>,
  dependencies: GroupRouteDependencies,
) => {
  const requireUserRequest = async (context: AppContext) => {
    const auth = await dependencies.authenticateRequest(context, true);
    if (!auth) return unauthorized(context, "Authentication required.");
    context.set("auth", auth);
    return null;
  };

  const requireAdministrator = async (context: AppContext) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    return requireOwner(context);
  };

  const loadGroupOr404 = async (context: AppContext, database: DatabaseAdapter) => {
    const group = await getGroupRow(database, String(context.req.param("groupId") ?? ""));
    if (!group) return { group: null, response: notFound(context, "Group not found") };
    return { group, response: null };
  };

  /** Members manage their own shares; administrators manage every group. */
  const canManageGroup = async (database: DatabaseAdapter, groupId: string, auth: AuthContext) => {
    if (auth.role === "owner") return true;
    return (await isGroupMember(database, groupId, auth.actorId ?? "")) === "manager";
  };

  // --- Groups (assembled by the administrator) ---

  app.get("/api/v1/groups", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const groups = await listGroupsForUser(context.env.storage.db, auth.actorId ?? "");
    return context.json({
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        createdBy: group.created_by,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
        memberCount: group.member_count,
        shareCount: group.share_count,
        myRole: group.my_role,
      })),
    });
  });

  app.post("/api/v1/groups", zValidator("json", GroupCreateSchema), async (context) => {
    const denied = await requireAdministrator(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const input = context.req.valid("json");
    const database = context.env.storage.db;

    const group = await createGroup(database, {
      name: input.name,
      description: input.description ?? null,
      createdBy: auth.actorId,
    });
    if (group) {
      await database.batch([
        auditStatement(database, "user", auth.actorId, "group.create", "group", group.id, {
          name: input.name,
        }),
      ]);
    }

    return context.json({ group }, 201);
  });

  app.patch("/api/v1/groups/:groupId", zValidator("json", GroupUpdateSchema), async (context) => {
    const denied = await requireAdministrator(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const { group, response } = await loadGroupOr404(context, database);
    if (!group) return response;

    const updated = await updateGroup(database, group.id, context.req.valid("json"));
    return context.json({ group: updated });
  });

  app.delete("/api/v1/groups/:groupId", async (context) => {
    const denied = await requireAdministrator(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const { group, response } = await loadGroupOr404(context, database);
    if (!group) return response;

    await deleteGroup(database, group.id);
    return context.json({ ok: true });
  });

  app.get("/api/v1/groups/:groupId/members", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const { group, response } = await loadGroupOr404(context, database);
    if (!group) return response;
    const auth = context.get("auth")!;
    if (!(await canManageGroup(database, group.id, auth)) && !(await isGroupMember(database, group.id, auth.actorId ?? ""))) {
      return forbidden(context, "You are not a member of this group.");
    }

    const members = await listGroupMembers(database, group.id);
    return context.json({
      members: members.map((member) => ({
        userId: member.user_id,
        role: member.role,
        username: member.username,
        displayName: member.display_name,
        createdAt: member.created_at,
      })),
    });
  });

  app.post(
    "/api/v1/groups/:groupId/members",
    zValidator("json", GroupMembersAddSchema),
    async (context) => {
      const denied = await requireAdministrator(context);
      if (denied) return denied;
      const database = context.env.storage.db;
      const { group, response } = await loadGroupOr404(context, database);
      if (!group) return response;

      const { userIds } = context.req.valid("json");
      await addGroupMembers(database, group.id, userIds);
      const members = await listGroupMembers(database, group.id);
      return context.json({
        members: members.map((member) => ({
          userId: member.user_id,
          role: member.role,
          username: member.username,
          displayName: member.display_name,
          createdAt: member.created_at,
        })),
      });
    },
  );

  app.delete("/api/v1/groups/:groupId/members/:userId", async (context) => {
    const denied = await requireAdministrator(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const { group, response } = await loadGroupOr404(context, database);
    if (!group) return response;

    await removeGroupMember(database, group.id, context.req.param("userId"));
    return context.json({ ok: true });
  });

  // --- Shares (created by the member who owns the notebook or note) ---

  app.get("/api/v1/groups/:groupId/shares", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const { group, response } = await loadGroupOr404(context, database);
    if (!group) return response;
    const auth = context.get("auth")!;
    if (!(await isGroupMember(database, group.id, auth.actorId ?? ""))) {
      return forbidden(context, "You are not a member of this group.");
    }

    return context.json({ shares: await listGroupShares(database, group.id) });
  });

  app.post(
    "/api/v1/groups/:groupId/shares",
    zValidator("json", GroupShareCreateSchema),
    async (context) => {
      const denied = await requireUserRequest(context);
      if (denied) return denied;
      const auth = context.get("auth")!;
      const database = context.env.storage.db;
      const { group, response } = await loadGroupOr404(context, database);
      if (!group) return response;
      if (!(await isGroupMember(database, group.id, auth.actorId ?? ""))) {
        return forbidden(context, "You are not a member of this group.");
      }

      const input = context.req.valid("json");
      const workspaceId = getWorkspaceId(context);

      // Only content the actor owns can be shared, so nobody can publish
      // someone else's notes into a group.
      if (input.targetType === "notebook") {
        const notebook = await database
          .prepare(`SELECT id FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 0`)
          .bind(input.targetId, workspaceId)
          .first();
        if (!notebook) return notFound(context, "Notebook not found");
      } else {
        const memo = await database
          .prepare(`SELECT id FROM memos WHERE id = ? AND workspace_id = ? AND is_deleted = 0`)
          .bind(input.targetId, workspaceId)
          .first();
        if (!memo) return notFound(context, "Memo not found");
      }

      const members = await listGroupMembers(database, group.id);
      const memberIds = new Set(members.map((member) => member.user_id));
      const editors = input.editorUserIds.filter((userId) => memberIds.has(userId));

      try {
        const shareId = await createGroupShare(database, {
          groupId: group.id,
          targetType: input.targetType,
          targetId: input.targetId,
          sourceWorkspaceId: workspaceId,
          editMode: input.editMode,
          editorUserIds: input.editMode === "group" ? editors : [],
          note: input.note ?? null,
          createdBy: auth.actorId,
        });
        return context.json({ share: { id: shareId } }, 201);
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          return apiError(context, "already_shared", "This item is already shared with this group.", 409);
        }
        throw error;
      }
    },
  );

  app.patch(
    "/api/v1/groups/:groupId/shares/:shareId",
    zValidator("json", GroupShareUpdateSchema),
    async (context) => {
      const denied = await requireUserRequest(context);
      if (denied) return denied;
      const auth = context.get("auth")!;
      const database = context.env.storage.db;
      const share = await getGroupShareRow(database, context.req.param("shareId"));
      if (!share || share.group_id !== context.req.param("groupId")) {
        return notFound(context, "Share not found");
      }
      if (!(await canManageGroup(database, share.group_id, auth)) && share.created_by !== auth.actorId) {
        return forbidden(context, "Only the person who shared this item or an administrator can change it.");
      }

      const input = context.req.valid("json");
      const members = await listGroupMembers(database, share.group_id);
      const memberIds = new Set(members.map((member) => member.user_id));
      await updateGroupShare(database, share.id, {
        editMode: input.editMode,
        editorUserIds: input.editorUserIds
          ? input.editorUserIds.filter((userId) => memberIds.has(userId))
          : undefined,
        note: input.note,
      });
      return context.json({ ok: true });
    },
  );

  app.delete("/api/v1/groups/:groupId/shares/:shareId", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const database = context.env.storage.db;
    const share = await getGroupShareRow(database, context.req.param("shareId"));
    if (!share || share.group_id !== context.req.param("groupId")) {
      return notFound(context, "Share not found");
    }
    if (!(await canManageGroup(database, share.group_id, auth)) && share.created_by !== auth.actorId) {
      return forbidden(context, "Only the person who shared this item or an administrator can remove it.");
    }

    await revokeGroupShare(database, share.id);
    return context.json({ ok: true });
  });

  // --- What is shared with me / by me ---

  app.get("/api/v1/shared-with-me", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const database = context.env.storage.db;
    const [shared, mine] = await Promise.all([
      listSharedWithMe(database, {
        userId: auth.actorId ?? "",
        ownWorkspaceId: getWorkspaceId(context),
      }),
      listSharesCreatedBy(database, auth.actorId ?? ""),
    ]);
    return context.json({ ...shared, sharedByMe: mine });
  });

  app.get("/api/v1/shared-with-me/notebooks/:notebookId/memos", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const database = context.env.storage.db;
    const notebookId = context.req.param("notebookId");

    const access = await resolveNotebookAccess(database, {
      userId: auth.actorId ?? "",
      ownWorkspaceId: getWorkspaceId(context),
      notebookId,
    });
    if (!access) return notFound(context, "Notebook not found");
    if (!access.canRead) return forbidden(context, "This notebook is not shared with you.");

    const memos = await listSharedNotebookMemos(database, {
      userId: auth.actorId ?? "",
      ownWorkspaceId: getWorkspaceId(context),
      notebookId,
    });
    return context.json({ memos, canEdit: access.canEdit, groupName: access.groupName });
  });

  app.get("/api/v1/shared-with-me/memos/:memoId", async (context) => {
    const denied = await requireUserRequest(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const database = context.env.storage.db;
    const access = await resolveMemoAccess(database, {
      userId: auth.actorId ?? "",
      ownWorkspaceId: getWorkspaceId(context),
      memoId: context.req.param("memoId"),
    });
    if (!access) return notFound(context, "Memo not found");
    if (!access.canRead) return forbidden(context, "This note is not shared with you.");
    return context.json({
      access: {
        canRead: access.canRead,
        canEdit: access.canEdit,
        groupId: access.groupId,
        groupName: access.groupName,
        editMode: access.editMode,
        workspaceId: access.workspaceId,
      },
    });
  });

};


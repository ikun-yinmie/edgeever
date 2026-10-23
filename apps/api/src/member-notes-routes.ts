import { MemberNotesAccessUpdateSchema } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { notFound } from "./http-errors";
import { getMemoDetail } from "./memo-service";
import { listMemos } from "./memo-list-service";
import {
  getMemberNotesAccessSettings,
  listMemberNotesMembers,
  resolveMemberNotesTarget,
  updateMemberNotesAccess,
} from "./member-notes-service";
import { requireOwner } from "./request-auth";
import type { AppContext, AppEnv } from "./api-context";

const DEFAULT_MEMBER_NOTES_PAGE_SIZE = 100;
const MAX_MEMBER_NOTES_PAGE_SIZE = 200;

const getPageSize = (value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MEMBER_NOTES_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_MEMBER_NOTES_PAGE_SIZE);
};

const resolveTargetOrRespond = async (
  context: AppContext,
  ownerUserId: string,
  targetUserId: string,
) => {
  const target = await resolveMemberNotesTarget(
    context.env.storage.db,
    ownerUserId,
    targetUserId,
  );
  if (!target) {
    return {
      response: context.json(
        {
          error: {
            code: "member_notes_forbidden",
            message: "This member's notes are not available to the site owner.",
          },
        },
        403,
      ),
    };
  }
  return { target };
};

export const registerMemberNotesRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/v1/admin/member-notes/access", async (context) => {
    const denied = requireOwner(context);
    if (denied) return denied;

    const settings = await getMemberNotesAccessSettings(context.env.storage.db);
    return context.json({ settings });
  });

  app.patch(
    "/api/v1/admin/member-notes/access",
    zValidator("json", MemberNotesAccessUpdateSchema),
    async (context) => {
      const denied = requireOwner(context);
      if (denied) return denied;

      const auth = context.get("auth");
      const settings = await updateMemberNotesAccess(context.env.storage.db, {
        ...context.req.valid("json"),
        actorId: auth?.actorId ?? null,
      });
      return context.json({ settings });
    },
  );

  app.get("/api/v1/admin/member-notes/members", async (context) => {
    const denied = requireOwner(context);
    if (denied) return denied;

    const auth = context.get("auth");
    const result = await listMemberNotesMembers(
      context.env.storage.db,
      auth?.actorId ?? "",
    );
    return context.json(result);
  });

  app.get("/api/v1/admin/member-notes/:userId/memos", async (context) => {
    const denied = requireOwner(context);
    if (denied) return denied;

    const auth = context.get("auth");
    const resolved = await resolveTargetOrRespond(
      context,
      auth?.actorId ?? "",
      context.req.param("userId"),
    );
    if ("response" in resolved) return resolved.response;

    const result = await listMemos(context.env.storage.db, {
      workspaceId: resolved.target.workspaceId,
      query: context.req.query("q"),
      filter: context.req.query("filter"),
      sort: context.req.query("sort"),
      cursor: context.req.query("cursor"),
      limit: getPageSize(context.req.query("limit")),
    });

    return context.json({
      ...result,
      member: {
        id: resolved.target.id,
        username: resolved.target.username,
        displayName: resolved.target.displayName,
      },
    });
  });

  app.get("/api/v1/admin/member-notes/:userId/memos/:memoId", async (context) => {
    const denied = requireOwner(context);
    if (denied) return denied;

    const auth = context.get("auth");
    const resolved = await resolveTargetOrRespond(
      context,
      auth?.actorId ?? "",
      context.req.param("userId"),
    );
    if ("response" in resolved) return resolved.response;

    const memo = await getMemoDetail(
      context.env.storage.db,
      resolved.target.workspaceId,
      context.req.param("memoId"),
    );
    if (!memo) return notFound(context, "Memo not found");

    return context.json({
      memo,
      member: {
        id: resolved.target.id,
        username: resolved.target.username,
        displayName: resolved.target.displayName,
      },
    });
  });
};

import { AccountEmailCodeRequestSchema, AccountEmailVerifySchema } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono, MiddlewareHandler } from "hono";
import {
  getAccountEmailStatus,
  requestAccountEmailCode,
  verifyAccountEmail,
  type AccountEmailDependencies,
} from "./account-email-service";
import type { AppContext, AppEnv, AuthContext, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { apiError, forbidden, unauthorized } from "./http-errors";

type Dependencies = AccountEmailDependencies & {
  authenticateSession: (context: AppContext, touch: boolean) => Promise<AuthContext | null>;
  isDemoEnvironment: (environment: Bindings) => boolean;
};

const requestDetails = (context: AppContext) => ({
  // HTTP callers can forge forwarding headers on a directly exposed server.
  // Cloudflare's request.cf is runtime metadata, not an incoming header. Until
  // self-hosted ingress supplies trusted peer metadata, use account budgets
  // there and do not combine unrelated clients into a shared 'unknown IP'.
  ip: context.req.raw.cf && typeof context.req.raw.cf === "object"
    ? context.req.header("CF-Connecting-IP")?.trim() || null
    : null,
  locale: context.req.header("accept-language") ?? null,
});

export const registerAccountEmailRoutes = (app: Hono<AppEnv>, dependencies: Dependencies) => {
  // Explicit cookie-session authentication runs before validation on every
  // endpoint. Never fall back to API tokens or the unauthenticated local owner.
  const requirePersonalSession: MiddlewareHandler<AppEnv> = async (context, next) => {
    const auth = await dependencies.authenticateSession(context, true);
    if (!auth || auth.kind !== "user" || auth.actorType !== "user" || !auth.actorId || !auth.sessionId || auth.tokenId) {
      return unauthorized(context, "An interactive user session is required.");
    }
    if (dependencies.isDemoEnvironment(context.env) || auth.accountType === "group" || auth.actorId === "local") {
      return forbidden(context, "Only a personal account outside the demo environment can manage its email.");
    }
    context.set("auth", auth);
    await next();
  };
  const respond = async (context: AppContext, operation: () => Promise<Response>) => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return apiError(context, error.code, error.message, error.status);
    }
  };

  app.get("/api/v1/auth/email", requirePersonalSession, (context) => respond(context, async () =>
    context.json({ accountEmail: await getAccountEmailStatus(context.env, context.get("auth").actorId!) })));

  app.post("/api/v1/auth/email/code", requirePersonalSession, zValidator("json", AccountEmailCodeRequestSchema), (context) => respond(context, async () =>
    context.json(await requestAccountEmailCode(
      context.env, context.get("auth").actorId!, context.req.valid("json"), requestDetails(context), dependencies,
    ))));

  app.post("/api/v1/auth/email/verify", requirePersonalSession, zValidator("json", AccountEmailVerifySchema), (context) => respond(context, async () =>
    context.json({ accountEmail: await verifyAccountEmail(
      context.env, context.get("auth").actorId!, context.req.valid("json"), requestDetails(context),
    ) })));

};

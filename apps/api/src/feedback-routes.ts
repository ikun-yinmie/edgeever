import { FeedbackSubmitSchema } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { FeedbackError, getPublicFeedback, submitFeedback, type FeedbackDependencies } from "./feedback-service";
import { apiError, forbidden, unauthorized } from "./http-errors";

type FeedbackRouteDependencies = FeedbackDependencies & {
  authenticateRequest: (context: AppContext, touch: boolean) => Promise<AuthContext | null>;
};

// Register before the global /api/v1/* middleware so GET stays public. POST
// authenticates explicitly, before body validation, instead of trusting order.
export const registerFeedbackRoutes = (app: Hono<AppEnv>, dependencies: FeedbackRouteDependencies) => {
  app.get("/api/v1/public/feedback", async (context) =>
    context.json({ feedback: await getPublicFeedback(context.env) }));

  app.post("/api/v1/feedback", async (context, next) => {
    const auth = await dependencies.authenticateRequest(context, true);
    if (!auth) return unauthorized(context, "Authentication required.");
    if (auth.kind !== "user" || auth.actorType !== "user") {
      return forbidden(context, "Only a signed-in account can submit feedback.");
    }
    if (!auth.actorId) return unauthorized(context, "A signed-in account is required.");
    context.set("auth", auth);
    await next();
  }, zValidator("json", FeedbackSubmitSchema), async (context) => {
    try {
      await submitFeedback(context.env, context.get("auth").actorId!, context.req.valid("json"), dependencies);
      return context.json({ ok: true });
    } catch (error) {
      if (!(error instanceof FeedbackError)) throw error;
      if (error.details.retryAfterSeconds !== undefined) {
        context.header("Retry-After", String(error.details.retryAfterSeconds));
      }
      return apiError(context, error.code, error.message, error.status, error.details);
    }
  });
};

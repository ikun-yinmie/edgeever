import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasBootstrapCredential } from "../apps/api/src/auth-bootstrap.ts";
import { isUnauthenticatedAccessEnabled } from "../apps/api/src/auth-state.ts";
import { createMemoCollaborationService } from "../apps/api/src/memo-collaboration-service.ts";
import { fetchEdgeEverApp } from "../apps/api/src/index.ts";
import { nodePublicFetch } from "../apps/api/src/node-public-network.ts";
import { createSelfHostedStorageAdapter } from "../apps/api/src/self-hosted-storage-adapter.ts";
import { resolveSelfHostedConfig } from "./self-hosted-config.mjs";
import { ensureSelfHostedCredentialSecrets, loadSelfHostedEnvironment } from "./self-hosted-secrets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeEnvironment = await loadSelfHostedEnvironment(process.env);
const config = resolveSelfHostedConfig(runtimeEnvironment, projectRoot);
const { dataDirectory, databaseFile, resourcesDirectory, webDirectory } = config;

await mkdir(dataDirectory, { recursive: true });
await mkdir(resourcesDirectory, { recursive: true });
await ensureSelfHostedCredentialSecrets(dataDirectory, runtimeEnvironment);
const sqlite = new Database(databaseFile, { create: true });
sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");

const migrationFiles = (await readdir(join(projectRoot, "migrations")))
  .filter((name) => name.endsWith(".sql"))
  .sort();

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS _edgeever_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`);

const appliedMigrations = new Set(
  sqlite.query("SELECT name FROM _edgeever_migrations").all().map((row) => row.name),
);

for (const name of migrationFiles) {
  if (appliedMigrations.has(name)) {
    continue;
  }

  const sql = await readFile(join(projectRoot, "migrations", name), "utf8");
  sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite.query("INSERT INTO _edgeever_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
  })();
  console.log(`[self-hosted] applied migration ${name}`);
}

const existingUser = sqlite.query("SELECT id FROM users WHERE is_disabled = 0 LIMIT 1").get();
if (
  !existingUser
  && !hasBootstrapCredential(runtimeEnvironment.EDGE_EVER_AUTH_PASSWORD, runtimeEnvironment.EDGE_EVER_AUTH_PASSWORD_HASH)
  && !isUnauthenticatedAccessEnabled(runtimeEnvironment.EDGE_EVER_ALLOW_UNAUTHENTICATED)
) {
  sqlite.close();
  throw new Error(
    "Authentication is not configured. Set EDGE_EVER_AUTH_PASSWORD (recommended), "
    + "EDGE_EVER_AUTH_PASSWORD_HASH, or explicitly set EDGE_EVER_ALLOW_UNAUTHENTICATED=true.",
  );
}

await ensureSelfHostedCredentialSecrets(dataDirectory, runtimeEnvironment, { generateIfMissing: true });

const storage = config.storageBackend === "s3"
  ? (
      await import("../apps/api/src/s3-compatible-storage-adapter.ts")
    ).createS3CompatibleStorageAdapter(sqlite, {
        bucket: runtimeEnvironment.EDGE_EVER_S3_BUCKET ?? "",
        region: runtimeEnvironment.EDGE_EVER_S3_REGION,
        endpoint: runtimeEnvironment.EDGE_EVER_S3_ENDPOINT,
        accessKeyId: runtimeEnvironment.EDGE_EVER_S3_ACCESS_KEY_ID,
        secretAccessKey: runtimeEnvironment.EDGE_EVER_S3_SECRET_ACCESS_KEY,
        forcePathStyle: runtimeEnvironment.EDGE_EVER_S3_FORCE_PATH_STYLE
          ? runtimeEnvironment.EDGE_EVER_S3_FORCE_PATH_STYLE === "true"
          : undefined,
      })
  : createSelfHostedStorageAdapter(sqlite, resourcesDirectory);
const env = {
  storage,
  publicNetworkFetch: nodePublicFetch,
  EDGE_EVER_AUTH_USERNAME: runtimeEnvironment.EDGE_EVER_AUTH_USERNAME ?? "admin",
  EDGE_EVER_RUNTIME: "self-hosted-bun",
  EDGE_EVER_CONTAINER_IMAGE: runtimeEnvironment.EDGE_EVER_CONTAINER_IMAGE,
  EDGE_EVER_DEPLOYMENT_TRIGGER: runtimeEnvironment.EDGE_EVER_DEPLOYMENT_TRIGGER,
  EDGE_EVER_DEPLOYMENT_METHOD: runtimeEnvironment.EDGE_EVER_DEPLOYMENT_METHOD,
  EDGE_EVER_AUTH_PASSWORD: runtimeEnvironment.EDGE_EVER_AUTH_PASSWORD,
  EDGE_EVER_AUTH_PASSWORD_HASH: runtimeEnvironment.EDGE_EVER_AUTH_PASSWORD_HASH,
  EDGE_EVER_AUTH_PASSWORD_FALLBACK: runtimeEnvironment.EDGE_EVER_AUTH_PASSWORD_FALLBACK,
  EDGE_EVER_SESSION_TTL_DAYS: runtimeEnvironment.EDGE_EVER_SESSION_TTL_DAYS ?? "400",
  EDGE_EVER_AUTH_LOGIN_WINDOW_SECONDS: runtimeEnvironment.EDGE_EVER_AUTH_LOGIN_WINDOW_SECONDS,
  EDGE_EVER_AUTH_LOGIN_USERNAME_MAX_ATTEMPTS: runtimeEnvironment.EDGE_EVER_AUTH_LOGIN_USERNAME_MAX_ATTEMPTS,
  EDGE_EVER_AUTH_LOGIN_USERNAME_COOLDOWN_SECONDS: runtimeEnvironment.EDGE_EVER_AUTH_LOGIN_USERNAME_COOLDOWN_SECONDS,
  EDGE_EVER_AUTH_LOGIN_IP_MAX_ATTEMPTS: runtimeEnvironment.EDGE_EVER_AUTH_LOGIN_IP_MAX_ATTEMPTS,
  EDGE_EVER_AUTH_LOGIN_IP_COOLDOWN_SECONDS: runtimeEnvironment.EDGE_EVER_AUTH_LOGIN_IP_COOLDOWN_SECONDS,
  // Legacy decryption fallback for credentials saved by older releases.
  EDGE_EVER_STORAGE_ENCRYPTION_KEY: runtimeEnvironment.EDGE_EVER_STORAGE_ENCRYPTION_KEY,
  EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY: runtimeEnvironment.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY,
  EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: runtimeEnvironment.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS,
  EDGE_EVER_DEMO_MODE: runtimeEnvironment.EDGE_EVER_DEMO_MODE,
  EDGE_EVER_ALLOW_UNAUTHENTICATED: runtimeEnvironment.EDGE_EVER_ALLOW_UNAUTHENTICATED,
};

const executionContext = {
  waitUntil: (promise) => Promise.resolve(promise).catch((error) => console.error("[self-hosted] background task failed", error)),
  passThroughOnException: () => undefined,
};

// --- Realtime collaboration -------------------------------------------------
// Only this runtime serves collaboration sockets; the Cloudflare worker stays
// a plain fetch handler. Authorization reuses the HTTP layer verbatim: the
// socket replays its upgrade request against the collab-session endpoint with
// the same cookie, so scopes, share permissions and the auth mode are decided
// in exactly one place.
const collaboration = createMemoCollaborationService(storage.db, {
  onError: (error, context) => console.error(
    `[collab] ${context.phase} failed for ${context.memoId}`,
    error instanceof Error ? error.message : error,
  ),
});
const collabRooms = collaboration.rooms;
env.collabRestore = collaboration.restore;

const COLLAB_SOCKET_PATH = /^\/api\/v1\/memos\/([^/]+)\/collab-ws$/;
/** ws -> { memoId, connection, opened, ready, pending } */
const collabSessions = new Map();
let collabConnectionSequence = 0;

const authorizeCollabSocket = async (request, memoId) => {
  const sessionUrl = new URL(request.url);
  sessionUrl.pathname = `/api/v1/memos/${encodeURIComponent(memoId)}/collab-session`;
  sessionUrl.search = "";

  // Only the credentials travel with the replay; upgrade handshake headers
  // (Connection/Upgrade/Sec-WebSocket-*) would confuse the HTTP layer.
  const headers = new Headers();
  for (const name of ["cookie", "authorization", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Browser websockets cannot set headers, so same-origin web clients ride on
  // the session cookie above. The desktop renderer lives on a custom scheme
  // and talks to a cross-origin API base with a Bearer session token instead;
  // it passes that token as ?token= and the replay carries it as a header,
  // where the shared auth layer accepts session tokens as bearers.
  const queryToken = new URL(request.url).searchParams.get("token");
  if (queryToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${queryToken}`);
  }

  const response = await fetchEdgeEverApp(
    new Request(sessionUrl, { method: "GET", headers }),
    env,
    executionContext,
  );
  if (!response.ok) {
    return { ok: false, status: response.status, message: "Collaboration access denied" };
  }
  const body = await response.json();
  return {
    ok: true,
    canEdit: Boolean(body?.canEdit),
    displayName: typeof body?.displayName === "string" ? body.displayName : null,
    // Verified server-side identity; never the name a client advertises.
    actorLabel: collabActorLabel(body?.actorId, body?.actorType),
  };
};

/** History attribution needs the stable id so renames still resolve a name. */
const collabActorLabel = (actorId, actorType) => {
  if (typeof actorId !== "string" || !actorId.trim()) return null;
  return actorType === "agent" ? `agent:${actorId.trim()}` : `user:${actorId.trim()}`;
};

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const serveStatic = async (request) => {
  const url = new URL(request.url);
  const requestedPath = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const candidate = resolve(webDirectory, `.${requestedPath}`);
  const relativeCandidate = relative(webDirectory, candidate);

  if (relativeCandidate.startsWith("..") || relativeCandidate.includes(".." + "/")) {
    return new Response("Not Found", { status: 404 });
  }

  const file = Bun.file(candidate);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "Content-Type": contentTypes[extname(candidate)] ?? "application/octet-stream" },
    });
  }

  if (extname(requestedPath)) {
    return new Response("Not Found", { status: 404 });
  }

  const index = Bun.file(join(webDirectory, "index.html"));
  return (await index.exists())
    ? new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    : new Response("Web build not found. Run bun run build:web first.", { status: 503 });
};

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  // Model providers may take longer than Bun's 10-second default to emit the
  // first streaming token. Keep the connection alive within Bun's supported range.
  idleTimeout: config.idleTimeout,
  websocket: {
    // Frames are already-compressed Yjs updates; per-connection state lives in
    // collabSessions so a socket only carries its note id and edit rights.
    perMessageDeflate: false,
    async open(ws) {
      const connection = {
        id: ws.data.connectionId,
        canEdit: ws.data.canEdit,
        actorLabel: ws.data.actorLabel,
        send: (message) => {
          try {
            ws.send(message);
          } catch {
            // The peer vanished between frames; `close` performs the cleanup.
          }
        },
        close: (reason) => {
          try {
            ws.close(1000, reason);
          } catch {
            // Already closing.
          }
        },
      };
      const session = {
        memoId: ws.data.memoId,
        connection,
        opened: collabRooms.open(ws.data.memoId),
        ready: false,
        pending: [],
      };
      // Register before awaiting: messages can arrive while the room loads.
      collabSessions.set(ws, session);
      try {
        session.room = await session.opened;
      } catch (error) {
        // The memo vanished or the seed failed; a dead socket that never syncs
        // is worse than no socket, so close it instead of queueing forever.
        console.error(`[collab] room open failed for ${session.memoId}`, error instanceof Error ? error.message : error);
        collabSessions.delete(ws);
        try {
          ws.close(1011, "collab_unavailable");
        } catch {
          // Already closing.
        }
        return;
      }
      session.ready = true;
      session.room.connect(connection);
      for (const message of session.pending) session.room.receive(connection, message);
      session.pending.length = 0;
    },
    message(ws, message) {
      const session = collabSessions.get(ws);
      if (!session) return;
      const bytes = typeof message === "string"
        ? new TextEncoder().encode(message)
        : message instanceof ArrayBuffer
          ? new Uint8Array(message)
          : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      if (!session.ready) {
        // Bound the backlog so a client cannot grow memory while auth/load runs.
        if (session.pending.length < 512) session.pending.push(bytes);
        return;
      }
      session.room.receive(session.connection, bytes);
    },
    async close(ws) {
      const session = collabSessions.get(ws);
      collabSessions.delete(ws);
      if (!session) return;
      if (!session.ready) {
        // The socket closed mid-attach; still detach once the room resolves.
        try {
          session.room = await session.opened;
        } catch {
          return;
        }
      }
      await collabRooms.close(session.memoId, session.connection);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (process.env.EDGE_EVER_DEBUG_COLLAB) console.error("[debug] fetch", request.method, url.pathname, request.headers.get("upgrade"));
    const collabMatch = COLLAB_SOCKET_PATH.exec(url.pathname);
    if (collabMatch) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Websocket upgrade required", { status: 426 });
      }
      const memoId = decodeURIComponent(collabMatch[1]);
      const authorization = await authorizeCollabSocket(request, memoId);
      if (!authorization.ok) {
        // A websocket client cannot read a response body, so the status is the
        // whole contract: 401 signed out, 403 no write access, 404 not visible.
        return new Response(authorization.message, { status: authorization.status });
      }
      if (process.env.EDGE_EVER_DEBUG_COLLAB) console.error("[debug] collab branch", JSON.stringify({ ua: request.headers.get("user-agent"), upgrade: request.headers.get("upgrade"), ext: request.headers.get("sec-websocket-extensions"), key: request.headers.get("sec-websocket-key"), origin: request.headers.get("origin"), cookie: Boolean(request.headers.get("cookie")) }));
      const upgraded = server.upgrade(request, {
        data: {
          memoId,
          canEdit: authorization.canEdit,
          displayName: authorization.displayName,
          actorLabel: authorization.actorLabel,
          connectionId: `collab-${(collabConnectionSequence += 1)}`,
        },
      });
      return upgraded ? undefined : new Response("Websocket upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return fetchEdgeEverApp(request, env, executionContext);
    }
    return serveStatic(request);
  },
});

console.log(`[self-hosted] listening on ${server.url}`);
console.log(`[self-hosted] data directory: ${dataDirectory}`);
console.log(`[self-hosted] storage backend: ${config.storageBackend}`);
console.log(`[self-hosted] idle timeout: ${config.idleTimeout}s`);

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[self-hosted] received ${signal}; shutting down`);

  try {
    await server.stop();
    // Drain only accepted live edits. Historical collaboration cache rows may
    // be stale after successful HTTP/mobile saves and must never be replayed.
    await collaboration.shutdown();
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sqlite.close();
    console.log("[self-hosted] shutdown complete");
  } catch (error) {
    console.error("[self-hosted] shutdown failed", error);
    process.exitCode = 1;
  }
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

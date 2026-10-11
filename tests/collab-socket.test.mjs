// End-to-end cover for the realtime collaboration socket.
//
// The unit tests in apps/api/src/collab-realtime.test.mjs exercise the CRDT
// room with an in-memory transport; this file proves the parts that only exist
// in the Bun/Docker runtime: the websocket upgrade, replaying the upgrade
// request through the HTTP auth layer, driving the room from real sockets, and
// flushing the merged document to SQLite on shutdown.
//
// It spawns a real server, so it lives in test:integration instead of the
// default bulk suite.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const projectRoot = resolve(import.meta.dir, "..");
const USERNAME = "admin";
const PASSWORD = "collab-socket-e2e-password";
const STARTUP_TIMEOUT_MS = 45_000;

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const waitFor = async (predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(50);
  }
  return false;
};

/** The server config rejects port 0, so reserve a free port up front. */
const findFreePort = async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  await probe.stop();
  return port;
};

/** Boots the self-hosted runtime on a free port and reads its URL. */
const startServer = async (dataDir) => {
  const environment = {
    ...process.env,
    EDGE_EVER_DATA_DIR: dataDir,
    EDGE_EVER_WEB_DIR: join(dataDir, "web"),
    EDGE_EVER_HOST: "127.0.0.1",
    EDGE_EVER_AUTH_USERNAME: USERNAME,
    EDGE_EVER_AUTH_PASSWORD: PASSWORD,
  };
  // PORT wins over EDGE_EVER_PORT in the config, and CI runners often export a
  // placeholder like PORT=0; drop it so this test owns its own listener.
  delete environment.PORT;
  environment.EDGE_EVER_PORT = String(await findFreePort());

  const child = spawn(process.execPath, [join(projectRoot, "scripts", "self-hosted-server.mjs")], {
    cwd: projectRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  const url = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not report a URL within ${STARTUP_TIMEOUT_MS}ms:\n${log}`));
    }, STARTUP_TIMEOUT_MS);
    const inspect = (chunk) => {
      log += String(chunk);
      const match = /listening on (http:\/\/\S+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        // The logged URL carries a trailing slash; Bun's fetch normalizes the
        // resulting double slash away, but its websocket client does not, so
        // strip it here or the upgrade path never matches server-side.
        resolvePromise(match[1].replace(/\/$/, ""));
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} during startup:\n${log}`));
    });
  });

  return { child, url, log: () => log };
};

const stopServer = async (server) => {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((resolvePromise) => server.child.once("exit", resolvePromise));
  server.child.kill("SIGTERM");
  await Promise.race([exited, wait(15_000)]);
};

const login = async (url) => {
  const response = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie) throw new Error("login did not return a session cookie");
  return cookie;
};

const seedMemo = async (url, cookie, contentJson) => {
  const headers = { "content-type": "application/json", cookie };
  const notebookResponse = await fetch(`${url}/api/v1/notebooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Collab" }),
  });
  if (!notebookResponse.ok) throw new Error(`notebook create failed: ${notebookResponse.status}`);
  const { notebook } = await notebookResponse.json();

  const memoResponse = await fetch(`${url}/api/v1/memos`, {
    method: "POST",
    headers,
    body: JSON.stringify({ notebookId: notebook.id, title: "Shared", ...(contentJson ? { contentJson } : {}) }),
  });
  if (!memoResponse.ok) throw new Error(`memo create failed: ${memoResponse.status}`);
  const { memo } = await memoResponse.json();
  return memo.id;
};

const getMemoContent = async (url, cookie, memoId) => {
  const response = await fetch(`${url}/api/v1/memos/${encodeURIComponent(memoId)}`, {
    headers: { cookie },
  });
  if (!response.ok) throw new Error(`memo read failed: ${response.status}`);
  return (await response.json()).memo;
};

const socketUrl = (url, memoId) =>
  `${url.replace(/^http/, "ws")}/api/v1/memos/${encodeURIComponent(memoId)}/collab-ws`;

/**
 * Reads the "default" fragment the way the browser Collaboration extension
 * renders it: paragraphs of text, concatenated. The seed and the materialized
 * write-back both live in this fragment, so convergence here is convergence
 * in the product.
 */
const fragmentText = (doc) => {
  const parts = [];
  const walk = (type) => {
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlText) parts.push(child.toString());
      else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(doc.getXmlFragment("default"));
  return parts.join("");
};

/** Appends a paragraph to the "default" fragment, like a local keystroke. */
const insertParagraph = (doc, text) => {
  const fragment = doc.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  const content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  fragment.insert(fragment.length, [paragraph]);
};
/**
 * Opens a real Yjs client over the socket. It speaks the same frame format the
 * browser client will, so convergence here is convergence in the product.
 */
const openEditor = (url, cookie) => new Promise((resolvePromise, reject) => {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const origin = { id: "browser", canEdit: true, send: () => undefined, close: () => undefined };
  const socket = new WebSocket(url, { headers: cookie ? { cookie } : {} });
  socket.binaryType = "arraybuffer";

  const timer = setTimeout(() => reject(new Error("collaboration socket never opened")), 15_000);

  socket.addEventListener("message", (event) => {
    const bytes = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : new Uint8Array(event.data);
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
      if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
      return;
    }
    if (messageType === 1) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), origin);
    }
  });

  socket.addEventListener("open", () => {
    clearTimeout(timer);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, doc);
    socket.send(encoding.toUint8Array(encoder));

    resolvePromise({
      doc,
      awareness,
      text: () => fragmentText(doc),
      type: (value) => insertParagraph(doc, value),
      close: () => new Promise((resolveClose) => {
        socket.addEventListener("close", () => resolveClose(), { once: true });
        socket.close();
      }),
    });
  });

  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("collaboration socket errored before opening"));
  });

  doc.on("update", (update, updateOrigin) => {
    if (updateOrigin === origin) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    try {
      socket.send(encoding.toUint8Array(encoder));
    } catch {
      // The socket is closing; the reconnect path is not under test here.
    }
  });
});

/** Resolves when the upgrade is refused, rejects if it opens. */
const expectRefused = (url, cookie) => new Promise((resolvePromise, reject) => {
  const socket = new WebSocket(url, { headers: cookie ? { cookie } : {} });
  const timer = setTimeout(() => reject(new Error("socket neither opened nor refused")), 10_000);
  const settle = (opened) => {
    clearTimeout(timer);
    if (opened) {
      socket.close();
      reject(new Error("upgrade unexpectedly succeeded"));
      return;
    }
    resolvePromise(undefined);
  };
  socket.addEventListener("open", () => settle(true));
  socket.addEventListener("close", () => settle(false));
  socket.addEventListener("error", () => settle(false));
});

describe("collaboration websocket session", () => {
  let dataDir;
  let server;
  let cookie;
  let memoId;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "edgeever-collab-"));
    server = await startServer(dataDir);
    cookie = await login(server.url);
    memoId = await seedMemo(server.url, cookie);
  }, 90_000);

  afterAll(async () => {
    await stopServer(server);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  test("two editors converge over a real socket instead of overwriting", async () => {
    const alice = await openEditor(socketUrl(server.url, memoId), cookie);
    const bob = await openEditor(socketUrl(server.url, memoId), cookie);

    // Both type before either edit reaches the server.
    alice.type("from-alice ");
    bob.type("from-bob ");
    bob.type("again ");

    expect(await waitFor(() => alice.text() === bob.text())).toBe(true);
    expect(alice.text()).toContain("from-alice");
    expect(alice.text()).toContain("from-bob");
    expect(alice.text()).toContain("again");

    await alice.close();
    await bob.close();
  }, 30_000);

  test("a late joiner receives the document that is already open", async () => {
    const editor = await openEditor(socketUrl(server.url, memoId), cookie);
    editor.type("late-joiner-sees-this ");
    expect(await waitFor(() => editor.text().includes("late-joiner-sees-this"))).toBe(true);

    const latecomer = await openEditor(socketUrl(server.url, memoId), cookie);
    expect(await waitFor(() => latecomer.text().includes("late-joiner-sees-this"))).toBe(true);

    await editor.close();
    await latecomer.close();
  }, 30_000);

  test("an upgrade without a session cookie is refused", async () => {
    await expectRefused(socketUrl(server.url, memoId), "");
  }, 20_000);

  test("a plain HTTP request to the socket path is refused", async () => {
    const response = await fetch(`${server.url}/api/v1/memos/${memoId}/collab-ws`);
    expect(response.status).toBe(426);
  }, 20_000);

  test("a joiner receives the note's stored content as the initial document", async () => {
    const seededId = await seedMemo(server.url, cookie, {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Seeded title" }] },
        { type: "paragraph", content: [{ type: "text", text: "seeded intro" }] },
      ],
    });
    const editor = await openEditor(socketUrl(server.url, seededId), cookie);
    expect(await waitFor(() => editor.text().includes("seeded intro"))).toBe(true);
    expect(editor.text()).toContain("Seeded title");
    await editor.close();
  }, 30_000);

  test("edits are materialized back into the memo content", async () => {
    const seededId = await seedMemo(server.url, cookie, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "materialize me" }] }],
    });
    const before = await getMemoContent(server.url, cookie, seededId);
    const editor = await openEditor(socketUrl(server.url, seededId), cookie);
    expect(await waitFor(() => editor.text().includes("materialize me"))).toBe(true);
    editor.type("merged-by-alice ");
    expect(await waitFor(() => editor.text().includes("merged-by-alice"))).toBe(true);
    await editor.close();

    // The room flushes on a quiet period and materializes at most once per
    // interval; both must have run before the memo content converges.
    const converged = await waitFor(async () => {
      const memo = await getMemoContent(server.url, cookie, seededId);
      return JSON.stringify(memo.contentJson).includes("merged-by-alice");
    }, 15_000);
    expect(converged).toBe(true);
    const after = await getMemoContent(server.url, cookie, seededId);
    expect(JSON.stringify(after.contentJson)).toContain("materialize me");
    expect(after.revision).toBeGreaterThan(before.revision);
  }, 40_000);

  test("a desktop-style token in the query string authenticates the upgrade", async () => {
    const token = cookie.split("=").slice(1).join("=");
    expect(token.length).toBeGreaterThan(0);
    const editor = await openEditor(`${socketUrl(server.url, memoId)}?token=${encodeURIComponent(token)}`, "");
    editor.type("token-authed ");
    expect(await waitFor(() => editor.text().includes("token-authed"))).toBe(true);
    await editor.close();
  }, 30_000);

  test("a bogus token is refused like a missing cookie", async () => {
    await expectRefused(`${socketUrl(server.url, memoId)}?token=${encodeURIComponent("bogus-token")}`, "");
  }, 20_000);

  test("the merged document survives a server restart", async () => {
    const editor = await openEditor(socketUrl(server.url, memoId), cookie);
    editor.type("persisted-across-restart ");
    expect(await waitFor(() => editor.text().includes("persisted-across-restart"))).toBe(true);
    await editor.close();

    // SIGTERM runs the shutdown hook, which flushes every open room before the
    // database closes; a lost flush would show up as a missing edit below.
    await stopServer(server);
    server = await startServer(dataDir);
    cookie = await login(server.url);

    const reconnected = await openEditor(socketUrl(server.url, memoId), cookie);
    expect(await waitFor(() => reconnected.text().includes("persisted-across-restart"))).toBe(true);
    await reconnected.close();

    // The shutdown sweep materializes the final tail into memo_contents, so a
    // non-collaboration reader sees the merged content after the restart too.
    const memo = await getMemoContent(server.url, cookie, memoId);
    expect(JSON.stringify(memo.contentJson)).toContain("persisted-across-restart");
  }, 90_000);
});

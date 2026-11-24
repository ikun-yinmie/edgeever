import { describe, expect, test } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { AppError } from "./app-error.ts";
import {
  COLLAB_MESSAGE_AWARENESS,
  COLLAB_MESSAGE_SYNC,
  createCollabRoomRegistry,
} from "./collab-realtime.ts";

// --- A minimal in-memory Yjs client -------------------------------------
// It speaks the same frame format a real browser client will, so these tests
// exercise the actual sync protocol instead of calling room internals.

let connectionSequence = 0;

const createStoredState = (seed) => {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, seed);
  return Y.encodeStateAsUpdate(doc);
};

const connectClient = async (registry, memoId, options = {}) => {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ displayName: options.displayName ?? "Peer" });

  const room = await registry.open(memoId);
  /** Frames the client would push up the socket. */
  const outbound = [];
  let connection;
  let closedReason = null;

  const handleServerFrame = (message) => {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === COLLAB_MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, COLLAB_MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, connection);
      if (encoding.length(encoder) > 1) outbound.push(encoding.toUint8Array(encoder));
      return;
    }
    if (messageType === COLLAB_MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        connection,
      );
    }
  };

  connection = {
    id: options.id ?? `conn-${(connectionSequence += 1)}`,
    canEdit: options.canEdit ?? true,
    actorLabel: options.actorLabel ?? null,
    send: handleServerFrame,
    close: (reason) => { closedReason = reason ?? null; },
  };

  // Local edits travel up as sync updates, exactly like y-websocket.
  doc.on("update", (update, origin) => {
    if (origin === connection) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    outbound.push(encoding.toUint8Array(encoder));
  });

  room.connect(connection);

  // A real client opens by sending its own state vector; the server answers
  // with the missing part of the document.
  const handshakeEncoder = encoding.createEncoder();
  encoding.writeVarUint(handshakeEncoder, COLLAB_MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(handshakeEncoder, doc);
  outbound.push(encoding.toUint8Array(handshakeEncoder));

  const client = {
    doc,
    awareness,
    connection,
    room,
    text: () => doc.getText("body").toString(),
    type: (value) => doc.getText("body").insert(doc.getText("body").length, value),
    /** Push queued client frames into the room. */
    pump: () => {
      const frames = outbound.splice(0, outbound.length);
      for (const frame of frames) room.receive(connection, frame);
      return frames.length;
    },
    announcePresence: () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, COLLAB_MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
      );
      outbound.push(encoding.toUint8Array(encoder));
    },
    disconnect: async () => {
      awareness.destroy();
      doc.destroy();
      await registry.close(memoId, connection);
    },
    closeReason: () => closedReason,
  };

  // Flush whatever the initial handshake produced (sync step2 and presence).
  client.pump();
  return client;
};

/** Settle both directions until no new frames are produced. */
const settle = (clients) => {
  for (let round = 0; round < 10; round += 1) {
    const pushed = clients.reduce((total, client) => total + client.pump(), 0);
    if (pushed === 0) return;
  }
};

const createRegistry = (overrides = {}) => {
  const persisted = new Map();
  const errors = [];
  const registry = createCollabRoomRegistry({
    loadState: async (memoId) => persisted.get(memoId) ?? null,
    persistState: async (memoId, state) => {
      persisted.set(memoId, state);
    },
    persistDebounceMs: 5,
    idleEvictionMs: 20,
    onError: (error, context) => errors.push({ error, context }),
    ...overrides,
  });
  return { registry, persisted, errors };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("collab realtime rooms", () => {
  test("two editors merge concurrent edits instead of overwriting each other", async () => {
    const { registry, errors } = createRegistry();
    const alice = await connectClient(registry, "memo_shared", { displayName: "Alice" });
    const bob = await connectClient(registry, "memo_shared", { displayName: "Bob" });

    // Both type "at the same time" before either edit reaches the server.
    alice.type("alice");
    bob.type("bob");
    settle([alice, bob]);

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("alice");
    expect(alice.text()).toContain("bob");
    expect(errors).toEqual([]);

    await registry.shutdown();
  });

  test("a late joiner receives the document that is already open", async () => {
    const { registry } = createRegistry();
    const alice = await connectClient(registry, "memo_late", { displayName: "Alice" });
    alice.type("written before the second editor arrived");
    settle([alice]);

    const bob = await connectClient(registry, "memo_late", { displayName: "Bob" });
    settle([alice, bob]);

    expect(bob.text()).toBe("written before the second editor arrived");

    await registry.shutdown();
  });

  test("the merged document is persisted and replayed to a fresh room", async () => {
    const { registry, persisted } = createRegistry();
    const alice = await connectClient(registry, "memo_persist", { displayName: "Alice" });
    alice.type("durable");
    settle([alice]);

    await wait(30);
    expect(persisted.has("memo_persist")).toBe(true);
    await registry.shutdown();

    // A new process would only have the stored state to go on.
    const restarted = createRegistry();
    restarted.persisted.set("memo_persist", persisted.get("memo_persist"));
    const bob = await connectClient(restarted.registry, "memo_persist", { displayName: "Bob" });
    settle([bob]);
    expect(bob.text()).toBe("durable");

    await restarted.registry.shutdown();
  });

  test("closing an unchanged room does not republish its cached content", async () => {
    let writes = 0;
    const { registry } = createRegistry({
      loadState: async () => createStoredState("already saved"),
      persistState: async () => { writes += 1; },
    });
    const client = await connectClient(registry, "memo_clean");
    expect(client.text()).toBe("already saved");
    await client.disconnect();
    await registry.shutdown();
    expect(writes).toBe(0);
  });

  test("shutdown drains edits accepted while the previous persistence is in flight", async () => {
    const writes = [];
    let releaseFirst;
    const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
    const { registry } = createRegistry({
      persistDebounceMs: 60_000,
      persistState: async (_memoId, state, actorLabel) => {
        writes.push({ state, actorLabel });
        if (writes.length === 1) await firstWrite;
      },
    });
    const client = await connectClient(registry, "memo_tail", { actorLabel: "user:alice" });
    client.type("first");
    client.pump();
    const flushing = client.room.flush();
    expect(writes).toHaveLength(1);
    client.type(" and final tail");
    client.pump();
    const stopping = registry.shutdown();
    releaseFirst();
    await flushing;
    await stopping;
    const replay = new Y.Doc();
    try {
      Y.applyUpdate(replay, writes.at(-1).state);
      expect(replay.getText("body").toString()).toBe("first and final tail");
      expect(writes.at(-1).actorLabel).toBe("user:alice");
    } finally {
      replay.destroy();
    }
  });

  test("a read-only member cannot mutate the shared document", async () => {
    const { registry } = createRegistry();
    const editor = await connectClient(registry, "memo_readonly", { displayName: "Editor" });
    const reader = await connectClient(registry, "memo_readonly", {
      displayName: "Reader",
      canEdit: false,
    });

    reader.type("sneaky");
    settle([editor, reader]);

    // The reader's update never reaches the shared document, so nobody else
    // ever sees it -- including someone who joins afterwards.
    expect(editor.text()).toBe("");
    const latecomer = await connectClient(registry, "memo_readonly", { displayName: "Late" });
    settle([editor, reader, latecomer]);
    expect(latecomer.text()).toBe("");

    // Read-only members still receive what editors write.
    editor.type("from the editor");
    settle([editor, reader, latecomer]);
    expect(reader.text()).toContain("from the editor");
    expect(latecomer.text()).toBe("from the editor");

    await registry.shutdown();
  });

  test("disconnecting removes that member's presence", async () => {
    const { registry } = createRegistry();
    const alice = await connectClient(registry, "memo_presence", { displayName: "Alice" });
    const bob = await connectClient(registry, "memo_presence", { displayName: "Bob" });

    alice.announcePresence();
    bob.announcePresence();
    settle([alice, bob]);
    expect(alice.room.peerCount).toBe(2);

    await bob.disconnect();
    expect(alice.room.peerCount).toBe(1);
    settle([alice]);

    await alice.disconnect();
    await registry.shutdown();
  });

  test("concurrent opens share one room and an idle room is released", async () => {
    const { registry, persisted } = createRegistry();
    const [first, second] = await Promise.all([
      registry.open("memo_shared_room"),
      registry.open("memo_shared_room"),
    ]);
    expect(first).toBe(second);
    expect(registry.roomCount()).toBe(1);

    const client = await connectClient(registry, "memo_shared_room", { displayName: "Solo" });
    client.type("release me");
    settle([client]);
    await client.disconnect();

    // The room must flush before it is dropped, or the last edits are lost.
    await wait(60);
    expect(registry.roomCount()).toBe(0);
    expect(persisted.has("memo_shared_room")).toBe(true);
    const replay = new Y.Doc();
    Y.applyUpdate(replay, persisted.get("memo_shared_room"));
    expect(replay.getText("body").toString()).toBe("release me");

    await registry.shutdown();
  });

  test("a room starts from the state the store returns", async () => {
    const { registry } = createRegistry();
    const client = await connectClient(registry, "memo_seeded", { displayName: "Joined" });
    settle([client]);
    expect(client.text()).toBe("");

    const seeded = createRegistry();
    seeded.persisted.set("memo_seeded_state", createStoredState("already stored"));
    const late = await connectClient(seeded.registry, "memo_seeded_state", { displayName: "Late" });
    settle([late]);
    expect(late.text()).toBe("already stored");

    await registry.shutdown();
    await seeded.registry.shutdown();
  });
});

describe("collab attribution, pause and restore", () => {
  test("discards a failed live restore without persisting its stale room", async () => {
    const persisted = new Map([["memo_failed_restore", createStoredState("old body")]]);
    let writes = 0;
    const { registry } = createRegistry({
      loadState: async (memoId) => persisted.get(memoId) ?? null,
      persistState: async (memoId, state) => { writes += 1; persisted.set(memoId, state); },
    });
    const client = await connectClient(registry, "memo_failed_restore");
    settle([client]);
    await registry.beginRestore("memo_failed_restore");
    const writesBeforeApply = writes;
    const restored = createStoredState("committed restore");
    persisted.set("memo_failed_restore", restored);
    client.room.applyRestoredState = () => { throw new Error("live apply failed"); };
    await registry.applyRestoredState("memo_failed_restore", restored);
    await registry.endRestore("memo_failed_restore");
    expect(client.closeReason()).toBe("collab_restored");
    expect(registry.roomCount()).toBe(0);
    await client.room.flush();
    expect(writes).toBe(writesBeforeApply);
    const fresh = await connectClient(registry, "memo_failed_restore");
    settle([fresh]);
    expect(fresh.text()).toBe("committed restore");
    await registry.shutdown();
  });

  test("a rejected normal save replays edits received while the room was paused", async () => {
    const { registry, persisted } = createRegistry();
    const client = await connectClient(registry, "memo_rejected_save", { actorLabel: "user:alice" });
    client.type("before");
    client.pump();
    await registry.beginRestore("memo_rejected_save");
    client.type(" during rejected save");
    client.pump();
    await registry.endRestore("memo_rejected_save");
    expect(client.closeReason()).toBeNull();
    await registry.shutdown();
    const replay = new Y.Doc();
    try {
      Y.applyUpdate(replay, persisted.get("memo_rejected_save"));
      expect(replay.getText("body").toString()).toBe("before during rejected save");
    } finally {
      replay.destroy();
    }
  });

  test("a persistence conflict releases the stale room without flushing it again", async () => {
    let writes = 0;
    const { registry } = createRegistry({
      loadState: async () => createStoredState("fresh server body"),
      persistState: async () => {
        writes += 1;
        throw new AppError("revision_conflict", "outside save", 409);
      },
      persistDebounceMs: 60_000,
    });
    const client = await connectClient(registry, "memo_stale_room");
    client.type(" stale addition");
    client.pump();
    await client.room.flush();
    await wait(1);
    expect(client.closeReason()).toBe("collab_stale");
    expect(registry.roomCount()).toBe(0);
    expect(writes).toBe(1);
    const fresh = await connectClient(registry, "memo_stale_room");
    expect(fresh.text()).toBe("fresh server body");
    await registry.shutdown();
    expect(writes).toBe(1);
  });

  test("waits for a restore before opening a new room", async () => {
    const persisted = new Map();
    const { registry } = createRegistry({ loadState: async (memoId) => persisted.get(memoId) ?? null });
    await registry.beginRestore("memo_new_restore");
    let opened = false;
    const pending = registry.open("memo_new_restore").then((room) => { opened = true; return room; });
    await Promise.resolve();
    expect(opened).toBe(false);
    persisted.set("memo_new_restore", createStoredState("restored"));
    await registry.endRestore("memo_new_restore");
    await pending;
    expect(opened).toBe(true);
    const fresh = await connectClient(registry, "memo_new_restore");
    settle([fresh]);
    expect(fresh.text()).toBe("restored");
    await registry.shutdown();
  });

  test("persists the authenticated editor behind each flush", async () => {
    const actors = [];
    const { registry } = createRegistry({
      persistState: async (_memoId, _state, actorLabel) => {
        actors.push(actorLabel);
      },
    });
    const alice = await connectClient(registry, "memo_actor", { displayName: "Alice", actorLabel: "user:alice" });
    alice.type("alice edit");
    settle([alice]);
    await wait(30);
    expect(actors.filter(Boolean).at(-1)).toBe("user:alice");

    const bob = await connectClient(registry, "memo_actor", { displayName: "Bob", actorLabel: "user:bob" });
    bob.type("bob edit");
    settle([alice, bob]);
    await wait(30);
    expect(actors.filter(Boolean).at(-1)).toBe("user:bob");

    await registry.shutdown();
  });

  test("drops edits sent during a restore and forces those clients to reconnect", async () => {
    const initialDoc = new Y.Doc();
    initialDoc.getText("body").insert(0, "old body");
    const persisted = new Map([["memo_restore", Y.encodeStateAsUpdate(initialDoc)]]);
    const { registry } = createRegistry({
      loadState: async (memoId) => persisted.get(memoId) ?? null,
      persistState: async (memoId, state) => {
        persisted.set(memoId, state);
      },
    });

    const alice = await connectClient(registry, "memo_restore", { displayName: "Alice", actorLabel: "user:alice" });
    settle([alice]);
    expect(alice.text()).toBe("old body");

    const replacementDoc = new Y.Doc();
    Y.applyUpdate(replacementDoc, persisted.get("memo_restore"));
    const replacementText = replacementDoc.getText("body");
    replacementText.delete(0, replacementText.length);
    replacementText.insert(0, "restored body");
    const replacement = Y.encodeStateAsUpdate(replacementDoc);

    const intruder = await connectClient(registry, "memo_restore", { displayName: "Intruder", actorLabel: "user:mallory" });
    settle([alice, intruder]);
    await registry.beginRestore("memo_restore");
    intruder.type(" sneaky");
    intruder.pump();
    persisted.set("memo_restore", replacement);
    await registry.applyRestoredState("memo_restore", replacement);
    await registry.endRestore("memo_restore");
    settle([alice, intruder]);
    await wait(30);

    expect(intruder.closeReason()).toBe("collab_restored");
    expect(alice.text()).toContain("restored body");

    await registry.shutdown();
    const persistedCheck = new Y.Doc();
    Y.applyUpdate(persistedCheck, persisted.get("memo_restore"));
    expect(persistedCheck.getText("body").toString()).toBe("restored body");

    const restarted = createRegistry({
      loadState: async (memoId) => persisted.get(memoId) ?? null,
      persistState: async (memoId, state) => {
        persisted.set(memoId, state);
      },
    });
    const fresh = await connectClient(restarted.registry, "memo_restore", { displayName: "Fresh" });
    settle([fresh]);
    expect(fresh.text()).toBe("restored body");

    await restarted.registry.shutdown();
  });
});

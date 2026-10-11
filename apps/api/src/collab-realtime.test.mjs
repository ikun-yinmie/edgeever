import { describe, expect, test } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
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
    send: handleServerFrame,
    close: () => undefined,
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

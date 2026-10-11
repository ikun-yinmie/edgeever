// Realtime CRDT collaboration for shared notes.
//
// This is the runtime-agnostic core: one Yjs document per note, merged from
// every participant's updates, plus the awareness channel that carries
// "who is here / where is their caret". It deliberately knows nothing about
// sockets, HTTP or the Bun runtime — a transport feeds it decoded messages and
// receives frames to send back, which keeps it testable with a fake transport.
//
// Why a CRDT at all: the memo edit-session optimistic lock is whole-document
// last-write-wins, so two people editing the same note make one of them lose
// their work to a conflict dialog. Yjs merges concurrent edits per-character,
// which is what "Yuque-style" collaboration actually requires.
//
// Framing follows the y-websocket convention so standard Yjs clients can talk
// to it unchanged:
//
//   [ varUint messageType ][ payload ]
//
//   messageType 0 -> y-protocols/sync   (step1 / step2 / update)
//   messageType 1 -> y-protocols/awareness (incremental client states)
//
// Only the Bun/Docker runtime hosts a socket; see scripts/self-hosted-server.mjs.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const COLLAB_MESSAGE_SYNC = 0;
export const COLLAB_MESSAGE_AWARENESS = 1;

/** Coalesces bursts of keystrokes into one state write per quiet period. */
const DEFAULT_PERSIST_DEBOUNCE_MS = 400;
/**
 * An empty room stays in memory briefly so a page refresh reattaches to the
 * same document instead of racing the debounced state write.
 */
const DEFAULT_ROOM_IDLE_EVICTION_MS = 30_000;

export type CollabConnection = {
  /** Stable per-socket id; only used to route frames and clean up awareness. */
  readonly id: string;
  /** Read-only participants may pull the document but never mutate it. */
  readonly canEdit: boolean;
  send: (message: Uint8Array) => void;
  close: (reason?: string) => void;
};

export type CollabRoomOptions = {
  memoId: string;
  initialState?: Uint8Array | null;
  persistState: (memoId: string, state: Uint8Array) => Promise<void> | void;
  persistDebounceMs?: number;
  onError?: (error: unknown, phase: string) => void;
};

/**
 * Client ids inside an awareness update. Removing a disconnected peer needs
 * those ids, and the awareness module only exposes them through this encoding.
 */
const awarenessClientIds = (update: Uint8Array): number[] => {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
};

export class CollabRoom {
  readonly memoId: string;
  private readonly document: Y.Doc;
  private readonly awareness: awarenessProtocol.Awareness;
  private readonly connections = new Map<string, CollabConnection>();
  private readonly controlledIds = new Map<string, Set<number>>();
  private readonly persistDebounceMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPersist: Promise<void> | null = null;
  private destroyed = false;

  constructor(private readonly options: CollabRoomOptions) {
    this.memoId = options.memoId;
    this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
    this.document = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.document);
    // The server holds no local state, so it never shows up as a peer.
    this.awareness.setLocalState(null);

    if (options.initialState && options.initialState.byteLength > 0) {
      Y.applyUpdate(this.document, options.initialState, this);
    }

    this.document.on("update", this.handleDocumentUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  get connectionCount() {
    return this.connections.size;
  }

  get peerCount() {
    return this.awareness.getStates().size;
  }

  private report(error: unknown, phase: string) {
    this.options.onError?.(error, phase);
  }

  private handleDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const connection of this.connections.values()) {
      // The sender already applied this update to its own document.
      if (connection === origin) continue;
      try {
        connection.send(message);
      } catch (error) {
        this.report(error, "broadcast");
      }
    }
    this.schedulePersist();
  };

  private handleAwarenessUpdate = (
    _changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const changed = this.awareness.getStates();
    // Awareness frames are tiny; resend the full live set so late joins and
    // dropped frames self-heal instead of leaving a ghost caret behind.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...changed.keys()]),
    );
    const message = encoding.toUint8Array(encoder);
    for (const connection of this.connections.values()) {
      if (connection === origin) continue;
      try {
        connection.send(message);
      } catch (error) {
        this.report(error, "awareness-broadcast");
      }
    }
  };

  private schedulePersist() {
    if (this.destroyed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, this.persistDebounceMs);
    // Never hold the process open just for a pending collaboration write.
    (this.persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Write the merged state now; concurrent calls share one write. */
  async flush(): Promise<void> {
    if (this.pendingPersist) return this.pendingPersist;
    const state = Y.encodeStateAsUpdate(this.document);
    this.pendingPersist = Promise.resolve(this.options.persistState(this.memoId, state))
      .catch((error) => {
        this.report(error, "persist");
      })
      .finally(() => {
        this.pendingPersist = null;
      });
    return this.pendingPersist;
  }

  connect(connection: CollabConnection) {
    this.connections.set(connection.id, connection);
    this.controlledIds.set(connection.id, new Set());

    // Hand the joiner the current document...
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, COLLAB_MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.document);
    connection.send(encoding.toUint8Array(syncEncoder));

    // ...and everyone else's presence, so the collaborator bar is populated
    // before the first heartbeat instead of after it.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, COLLAB_MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      connection.send(encoding.toUint8Array(awarenessEncoder));
    }
  }

  receive(connection: CollabConnection, message: Uint8Array) {
    if (this.destroyed) return;
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === COLLAB_MESSAGE_SYNC) {
      const syncType = decoding.peekVarUint(decoder);
      // Read-only members may ask for the document but must not mutate it.
      // Enforced here, not in the client, so a modified client cannot bypass it.
      if (!connection.canEdit && syncType !== syncProtocol.messageYjsSyncStep1) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, COLLAB_MESSAGE_SYNC);
      try {
        syncProtocol.readSyncMessage(decoder, encoder, this.document, connection);
      } catch (error) {
        this.report(error, "read-sync-message");
        connection.close("collab_sync_error");
        return;
      }
      if (encoding.length(encoder) > 1) connection.send(encoding.toUint8Array(encoder));
      return;
    }

    if (messageType === COLLAB_MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      const owned = this.controlledIds.get(connection.id);
      if (owned) {
        for (const clientId of awarenessClientIds(update)) owned.add(clientId);
      }
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, connection);
    }
  }

  /** Drops the connection and its presence; returns how many remain. */
  disconnect(connection: CollabConnection): number {
    const controlled = this.controlledIds.get(connection.id);
    this.controlledIds.delete(connection.id);
    this.connections.delete(connection.id);
    if (controlled && controlled.size > 0) {
      // removeAwarenessStates expects an origin it can compare against; null is
      // the documented "server decided this client is gone" origin.
      awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
    }
    return this.connections.size;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // Final write before the document disappears: the debounce may still be
    // holding the last edits.
    await this.flush();
    this.destroyed = true;
    this.document.off("update", this.handleDocumentUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    for (const connection of [...this.connections.values()]) {
      this.disconnect(connection);
    }
    this.awareness.destroy();
    this.document.destroy();
  }
}

export type CollabRoomRegistryOptions = {
  loadState: (memoId: string) => Promise<Uint8Array | null>;
  persistState: (memoId: string, state: Uint8Array) => Promise<void> | void;
  idleEvictionMs?: number;
  persistDebounceMs?: number;
  onError?: (error: unknown, context: { memoId: string; phase: string }) => void;
};

export type CollabRoomRegistry = {
  /** Opens (or reuses) the room for a note; concurrent callers share one room. */
  open: (memoId: string) => Promise<CollabRoom>;
  /** Detaches a connection and schedules eviction once the room is empty. */
  close: (memoId: string, connection: CollabConnection) => Promise<void>;
  roomCount: () => number;
  /** Flushes and releases every room; used on process shutdown. */
  shutdown: () => Promise<void>;
};

export const createCollabRoomRegistry = (
  options: CollabRoomRegistryOptions,
): CollabRoomRegistry => {
  const rooms = new Map<string, Promise<CollabRoom>>();
  const evictions = new Map<string, ReturnType<typeof setTimeout>>();
  const idleEvictionMs = options.idleEvictionMs ?? DEFAULT_ROOM_IDLE_EVICTION_MS;

  const clearEviction = (memoId: string) => {
    const timer = evictions.get(memoId);
    if (!timer) return;
    clearTimeout(timer);
    evictions.delete(memoId);
  };

  const evict = async (memoId: string) => {
    const pending = rooms.get(memoId);
    if (!pending) return;
    // Remove first: a reconnecting client must not attach to a room that is
    // already shutting down.
    rooms.delete(memoId);
    clearEviction(memoId);
    try {
      const room = await pending;
      await room.destroy();
    } catch (error) {
      options.onError?.(error, { memoId, phase: "evict" });
    }
  };

  return {
    open: async (memoId) => {
      clearEviction(memoId);
      const existing = rooms.get(memoId);
      if (existing) return existing;

      const pending = (async () => {
        const initialState = await options.loadState(memoId);
        return new CollabRoom({
          memoId,
          initialState,
          persistState: options.persistState,
          persistDebounceMs: options.persistDebounceMs,
          onError: (error, phase) => options.onError?.(error, { memoId, phase }),
        });
      })();
      rooms.set(memoId, pending);
      pending.catch(() => {
        rooms.delete(memoId);
      });
      return pending;
    },

    close: async (memoId, connection) => {
      const pending = rooms.get(memoId);
      if (!pending) return;
      let room: CollabRoom | null = null;
      try {
        room = await pending;
      } catch {
        return;
      }
      if (room.disconnect(connection) > 0) return;
      // Keep the empty room warm for a moment so a refresh reattaches to the
      // same in-memory document, then flush and release it.
      clearEviction(memoId);
      const timer = setTimeout(() => {
        void evict(memoId);
      }, idleEvictionMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      evictions.set(memoId, timer);
    },

    roomCount: () => rooms.size,

    shutdown: async () => {
      for (const memoId of [...rooms.keys()]) {
        clearEviction(memoId);
        await evict(memoId);
      }
    },
  };
};

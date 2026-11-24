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
import { AppError } from "./app-error";

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
  /** Authenticated editor label used for history attribution. */
  readonly actorLabel?: string | null;
  send: (message: Uint8Array) => void;
  close: (reason?: string) => void;
};

/** Marks server-driven state replacement so it is never attributed to a peer. */
const RESTORE_ORIGIN = Symbol("collab-restore");

export type CollabRoomOptions = {
  memoId: string;
  initialState?: Uint8Array | null;
  persistState: (memoId: string, state: Uint8Array, actorLabel: string | null) => Promise<void> | void;
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
  private pendingActorLabel: string | null = null;
  private documentVersion = 0;
  private persistedVersion = 0;
  private paused = false;
  private replacementApplied = false;
  private readonly pausedMessages: Array<{ connection: CollabConnection; message: Uint8Array; isMutation: boolean }> = [];
  private readonly connectionsWithPausedEdits = new Map<string, CollabConnection>();
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
    if (origin === RESTORE_ORIGIN) {
      // Server replacement is not an edit: keep it out of history and
      // memos.updated_by.
      this.pendingActorLabel = null;
      // The replacement was already committed with memo_contents.
      this.persistedVersion = this.documentVersion;
    } else {
      this.documentVersion += 1;
      if (origin && typeof origin === "object" && "actorLabel" in origin) {
        this.pendingActorLabel = (origin as CollabConnection).actorLabel?.trim() || null;
      }
    }
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
    if (origin !== RESTORE_ORIGIN) this.schedulePersist();
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

  /** Drain all accepted edits; concurrent callers share the complete drain. */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    if (this.pendingPersist) return this.pendingPersist;
    if (this.persistedVersion === this.documentVersion) return;
    this.pendingPersist = (async () => {
      while (!this.destroyed && this.persistedVersion < this.documentVersion) {
        const version = this.documentVersion;
        const state = Y.encodeStateAsUpdate(this.document);
        const actorLabel = this.pendingActorLabel;
        await this.options.persistState(this.memoId, state, actorLabel);
        // A later edit may have arrived while the previous write awaited I/O.
        // Drain it too, especially when destroy() has canceled its timer.
        this.persistedVersion = version;
      }
    })()
      .catch((error) => {
        this.report(error, "persist");
      })
      .finally(() => {
        this.pendingPersist = null;
      });
    return this.pendingPersist;
  }

  get isPaused() {
    return this.paused;
  }

  /** Stop intake and drain writes before taking the state for a restore. */
  async pauseForRestore(): Promise<Uint8Array> {
    this.paused = true;
    this.replacementApplied = false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.pendingPersist;
    await this.flush();
    return Y.encodeStateAsUpdate(this.document);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    // Only a committed replacement invalidates edits sent while paused.
    // A rejected save/failed restore must replay those edits on the old body.
    if (this.replacementApplied) {
      for (const connection of this.connectionsWithPausedEdits.values()) {
        try {
          connection.close("collab_restored");
        } catch (error) {
          this.report(error, "resume-close");
        }
      }
    }
    this.connectionsWithPausedEdits.clear();
    const queued = this.pausedMessages.splice(0, this.pausedMessages.length);
    for (const { connection, message, isMutation } of queued) {
      if (this.replacementApplied && isMutation) continue;
      if (this.connections.get(connection.id) !== connection) continue;
      try {
        this.receive(connection, message);
      } catch (error) {
        this.report(error, "resume-message");
      }
    }
    this.replacementApplied = false;
  }

  /**
   * Replace document content with a server-produced state that retains the
   * Yjs delete set, so a reconnecting stale client cannot resurrect removed
   * nodes. The update reaches every connected client as a normal sync frame.
   */
  applyRestoredState(state: Uint8Array) {
    if (this.destroyed || state.byteLength === 0) return;
    Y.applyUpdate(this.document, state, RESTORE_ORIGIN);
    this.replacementApplied = true;
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
    if (this.paused) {
      try {
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);
        // Defer intake until the save/restore result is known. A successful
        // replacement discards mutations; a failed operation replays them.
        if (messageType === COLLAB_MESSAGE_SYNC) {
          const isMutation = decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1;
          if (isMutation && !connection.canEdit) return;
          if (this.pausedMessages.length < 512) {
            this.pausedMessages.push({ connection, message: message.slice(), isMutation });
            if (isMutation) this.connectionsWithPausedEdits.set(connection.id, connection);
          } else {
            connection.close("collab_sync_retry");
          }
        }
      } catch (error) {
        this.report(error, "paused-message");
      }
      return;
    }
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

  async destroy(flush = true, reason = flush ? "collab_shutdown" : "collab_restored"): Promise<void> {
    if (this.destroyed) return;
    // Stop intake before draining, so the final accepted version is finite.
    this.paused = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (flush) await this.flush();
    this.destroyed = true;
    this.document.off("update", this.handleDocumentUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    for (const connection of [...this.connections.values()]) {
      this.disconnect(connection);
      try {
        connection.close(reason);
      } catch (error) {
        this.report(error, "destroy-close");
      }
    }
    this.pausedMessages.length = 0;
    this.connectionsWithPausedEdits.clear();
    this.awareness.destroy();
    this.document.destroy();
  }
}

export type CollabRoomRegistryOptions = {
  loadState: (memoId: string) => Promise<Uint8Array | null>;
  persistState: CollabRoomOptions["persistState"];
  idleEvictionMs?: number;
  persistDebounceMs?: number;
  onError?: (error: unknown, context: { memoId: string; phase: string }) => void;
};

export type CollabRoomRegistry = {
  /** Opens (or reuses) the room for a note; concurrent callers share one room. */
  open: (memoId: string) => Promise<CollabRoom>;
  /** Detaches a connection and schedules eviction once the room is empty. */
  close: (memoId: string, connection: CollabConnection) => Promise<void>;
  /** Pauses one room, flushes its last edits and returns its current Yjs state. */
  beginRestore: (memoId: string) => Promise<Uint8Array | null>;
  /** Refreshes the paused room after the restore commits. */
  applyRestoredState: (memoId: string, state: Uint8Array) => Promise<void>;
  /** Resumes the room and lets new rooms load the committed state. */
  endRestore: (memoId: string) => Promise<void>;
  roomCount: () => number;
  /** Flushes and releases every room; used on process shutdown. */
  shutdown: () => Promise<void>;
};

export const createCollabRoomRegistry = (
  options: CollabRoomRegistryOptions,
): CollabRoomRegistry => {
  const rooms = new Map<string, Promise<CollabRoom>>();
  const evictions = new Map<string, ReturnType<typeof setTimeout>>();
  const restoring = new Map<string, { done: Promise<void>; finish: () => void }>();
  const idleEvictionMs = options.idleEvictionMs ?? DEFAULT_ROOM_IDLE_EVICTION_MS;

  const clearEviction = (memoId: string) => {
    const timer = evictions.get(memoId);
    if (!timer) return;
    clearTimeout(timer);
    evictions.delete(memoId);
  };

  const scheduleEviction = (memoId: string) => {
    clearEviction(memoId);
    const timer = setTimeout(() => {
      void evict(memoId);
    }, idleEvictionMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    evictions.set(memoId, timer);
  };

  const evict = async (memoId: string, flush = true) => {
    const pending = rooms.get(memoId);
    if (!pending) return;
    // Remove first: a reconnecting client must not attach to a room that is
    // already shutting down.
    rooms.delete(memoId);
    clearEviction(memoId);
    try {
      const room = await pending;
      await room.destroy(flush, flush ? "collab_shutdown" : "collab_stale");
    } catch (error) {
      options.onError?.(error, { memoId, phase: "evict" });
    }
  };

  return {
    open: async (memoId) => {
      while (restoring.has(memoId)) await restoring.get(memoId)!.done;
      clearEviction(memoId);
      const existing = rooms.get(memoId);
      if (existing) return existing;

      const pending = (async () => {
        const initialState = await options.loadState(memoId);
        const room = new CollabRoom({
          memoId,
          initialState,
          persistState: options.persistState,
          persistDebounceMs: options.persistDebounceMs,
          onError: (error, phase) => {
            options.onError?.(error, { memoId, phase });
            if (phase === "persist" && error instanceof AppError && error.code === "revision_conflict"
              && rooms.get(memoId) === pending) {
              // An outside writer moved on. Never keep broadcasting a room
              // that cannot commit; reconnect from the authoritative body.
              void evict(memoId, false);
            }
          },
        });
        return room;
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
      scheduleEviction(memoId);
    },

    beginRestore: async (memoId) => {
      if (restoring.has(memoId)) {
        throw new AppError("revision_conflict", "A revision restore is already in progress", 409);
      }
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      restoring.set(memoId, { done, finish });
      clearEviction(memoId);
      const pending = rooms.get(memoId);
      if (!pending) return null;
      try {
        const room = await pending;
        return await room.pauseForRestore();
      } catch (error) {
        restoring.delete(memoId);
        finish();
        throw error;
      }
    },

    applyRestoredState: async (memoId, state) => {
      const pending = rooms.get(memoId);
      if (!pending) return;
      let room: CollabRoom;
      try {
        room = await pending;
      } catch {
        return;
      }
      try {
        room.applyRestoredState(state);
      } catch (error) {
        // The replacement is already committed. Discard the stale room without
        // flushing so reconnecting peers load that committed state.
        rooms.delete(memoId);
        clearEviction(memoId);
        await room.destroy(false);
        options.onError?.(error, { memoId, phase: "restore-apply" });
      }
    },

    endRestore: async (memoId) => {
      const restore = restoring.get(memoId);
      try {
        const pending = rooms.get(memoId);
        if (!pending) return;
        const room = await pending;
        room.resume();
        if (room.connectionCount === 0) scheduleEviction(memoId);
      } finally {
        restoring.delete(memoId);
        restore?.finish();
      }
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

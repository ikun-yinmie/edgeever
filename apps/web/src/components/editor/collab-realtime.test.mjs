import { describe, expect, test } from "bun:test";
import {
  deriveCollabPeers,
  isDefaultCollabDisplayPolicy,
  pickCollabColor,
  resolveCollabSocketParts,
  shouldEnableCollabRealtime,
} from "./collab-realtime.ts";

describe("collab realtime eligibility", () => {
  const eligible = {
    isGroupShared: true,
    canEdit: true,
    isDeleted: false,
    displayPolicy: null,
    runtimeSupportsRealtime: true,
  };

  test("opens realtime for an editable group-shared note on a socket runtime", () => {
    expect(shouldEnableCollabRealtime(eligible)).toBe(true);
  });

  test("stays presence-only for personal notes, readers and the trash", () => {
    expect(shouldEnableCollabRealtime({ ...eligible, isGroupShared: false })).toBe(false);
    expect(shouldEnableCollabRealtime({ ...eligible, canEdit: false })).toBe(false);
    expect(shouldEnableCollabRealtime({ ...eligible, isDeleted: true })).toBe(false);
  });

  test("stays presence-only where the runtime serves no socket", () => {
    expect(shouldEnableCollabRealtime({ ...eligible, runtimeSupportsRealtime: false })).toBe(false);
  });

  test("a filtered view never joins the raw shared document", () => {
    expect(shouldEnableCollabRealtime({
      ...eligible,
      displayPolicy: { html: "hidden", markdown: "rendered" },
    })).toBe(false);
    expect(shouldEnableCollabRealtime({
      ...eligible,
      displayPolicy: { html: "rendered", markdown: "rendered" },
    })).toBe(true);
    expect(isDefaultCollabDisplayPolicy(undefined)).toBe(true);
  });
});

describe("collab socket addressing", () => {
  test("derives the note socket path from the API base", () => {
    expect(resolveCollabSocketParts({ apiBaseUrl: "http://192.168.1.5:8787/", memoId: "memo_1" })).toEqual({
      serverUrl: "ws://192.168.1.5:8787/api/v1/memos",
      roomname: "memo_1/collab-ws",
    });
    expect(resolveCollabSocketParts({ apiBaseUrl: "https://notes.example.com", memoId: "memo 2" })).toEqual({
      serverUrl: "wss://notes.example.com/api/v1/memos",
      roomname: "memo%202/collab-ws",
    });
  });
});

describe("collab peer derivation", () => {
  test("lists named peers and skips ourselves", () => {
    const peers = deriveCollabPeers(new Map([
      [1, { user: { name: "Me", color: "#16A06E" } }],
      [2, { user: { name: "Alice", color: "#2563EB" } }],
      [3, { user: { name: "Bob", color: "not-a-color" } }],
      [4, { user: { name: "  " } }],
      [5, null],
    ]).entries(), 1);
    expect(peers.map((peer) => peer.name)).toEqual(["Alice", "Bob"]);
    expect(peers[0]).toMatchObject({ clientId: 2, color: "#2563EB" });
    expect(peers[1].color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("caret colors are stable per identity", () => {
    expect(pickCollabColor("alice")).toBe(pickCollabColor("alice"));
    expect(pickCollabColor("alice")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

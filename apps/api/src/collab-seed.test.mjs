import { describe, expect, test } from "bun:test";
import {
  resolveCollabInitialState,
  tiptapJsonToYjsUpdate,
  yjsUpdateToTiptapJson,
} from "./collab-seed.ts";

const paragraph = (text, marks) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

describe("collab seed conversion", () => {
  test("rejects missing or malformed documents", () => {
    expect(tiptapJsonToYjsUpdate(null)).toBe(null);
    expect(tiptapJsonToYjsUpdate(undefined)).toBe(null);
    expect(tiptapJsonToYjsUpdate({ type: "paragraph" })).toBe(null);
    expect(tiptapJsonToYjsUpdate({ type: "doc" })).toBe(null);
    expect(tiptapJsonToYjsUpdate({ type: "doc", content: [] })).toBe(null);
  });

  test("a simple document survives the round trip", () => {
    const doc = { type: "doc", content: [paragraph("hello")] };
    const update = tiptapJsonToYjsUpdate(doc);
    expect(update).toBeInstanceOf(Uint8Array);
    expect(yjsUpdateToTiptapJson(update)).toEqual(doc);
  });

  test("marks, attributes and nesting survive the round trip", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "Title ", marks: [{ type: "bold", attrs: {} }] },
            { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
          ],
        },
        {
          type: "blockquote",
          content: [paragraph("quoted")],
        },
        {
          type: "codeBlock",
          attrs: { language: "html" },
          content: [{ type: "text", text: "<b>hi</b>" }],
        },
        { type: "horizontalRule" },
      ],
    };
    expect(yjsUpdateToTiptapJson(tiptapJsonToYjsUpdate(doc))).toEqual(doc);
  });

  test("malformed nodes are skipped instead of poisoning the seed", () => {
    const doc = {
      type: "doc",
      content: [
        null,
        { type: "" },
        paragraph("kept"),
        { type: "text" },
        { type: "text", text: "" },
      ],
    };
    expect(yjsUpdateToTiptapJson(tiptapJsonToYjsUpdate(doc))).toEqual({
      type: "doc",
      content: [paragraph("kept")],
    });
  });

  test("marks without explicit attrs still decode", () => {
    const doc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "styled", marks: [{ type: "italic" }] }],
      }],
    };
    expect(yjsUpdateToTiptapJson(tiptapJsonToYjsUpdate(doc))).toEqual({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "styled", marks: [{ type: "italic", attrs: {} }] }],
      }],
    });
  });

  test("junk states do not materialize into placeholder documents", () => {
    expect(yjsUpdateToTiptapJson(null)).toBe(null);
    expect(yjsUpdateToTiptapJson(new Uint8Array(0))).toBe(null);
    expect(yjsUpdateToTiptapJson(new Uint8Array([1, 2, 3]))).toBe(null);
  });
});

describe("collab initial state decision", () => {
  const state = (text) => new TextEncoder().encode(text);
  const memoDoc = { type: "doc", content: [paragraph("memo")] };

  test("reuses the persisted merge while its hash still matches", () => {
    const persisted = state("merge");
    expect(resolveCollabInitialState({
      persistedState: persisted,
      persistedContentHash: "hash-1",
      memoContentJson: memoDoc,
      memoContentHash: "hash-1",
    })).toBe(persisted);
  });

  test("re-seeds from the memo when an outside writer moved on", () => {
    const initial = resolveCollabInitialState({
      persistedState: state("stale merge"),
      persistedContentHash: "hash-0",
      memoContentJson: memoDoc,
      memoContentHash: "hash-1",
    });
    expect(initial).toBeInstanceOf(Uint8Array);
    expect(yjsUpdateToTiptapJson(initial)).toEqual(memoDoc);
  });

  test("seeds from the memo when no merge was ever persisted", () => {
    const initial = resolveCollabInitialState({
      persistedState: null,
      persistedContentHash: null,
      memoContentJson: memoDoc,
      memoContentHash: "hash-1",
    });
    expect(yjsUpdateToTiptapJson(initial)).toEqual(memoDoc);
  });

  test("prefers a stale merge over an unreadable memo", () => {
    const persisted = state("merge");
    expect(resolveCollabInitialState({
      persistedState: persisted,
      persistedContentHash: null,
      memoContentJson: null,
      memoContentHash: null,
    })).toBe(persisted);
  });

  test("returns null when neither source yields a document", () => {
    expect(resolveCollabInitialState({
      persistedState: null,
      persistedContentHash: null,
      memoContentJson: null,
      memoContentHash: null,
    })).toBe(null);
  });
});

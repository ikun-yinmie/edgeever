import { describe, expect, test } from "bun:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  createNoteSearchHighlightPlugin,
  formatNoteSearchMatchLabel,
  getNextSearchMatchIndex,
  getSearchNavigationIdentity,
  getSearchMatchesFromDocument,
  shouldDiscardPluginNoteSearchRequest,
  shouldResetNoteSearchForMemoChange,
} from "./note-search.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: { group: "inline" },
  },
  marks: { strong: {} },
});

const documentWithParagraphs = (...paragraphs) => schema.node(
  "doc",
  null,
  paragraphs.map((text) => schema.node("paragraph", null, text ? schema.text(text) : undefined)),
);

describe("note search", () => {
  test("finds case-insensitive document positions", () => {
    const matches = getSearchMatchesFromDocument(
      documentWithParagraphs("Alpha beta ALPHA"),
      "alpha",
    );

    expect(matches).toEqual([
      { from: 1, to: 6 },
      { from: 12, to: 17 },
    ]);
  });

  test("does not match across block boundaries", () => {
    const doc = documentWithParagraphs("beta", "alpha");
    expect(getSearchMatchesFromDocument(doc, "betaalpha")).toEqual([]);
    expect(getSearchMatchesFromDocument(doc, "alpha")).toEqual([{ from: 7, to: 12 }]);
  });

  test("returns non-overlapping matches", () => {
    expect(getSearchMatchesFromDocument(documentWithParagraphs("aaaa"), "aa")).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ]);
  });

  test("matches across formatting boundaries within a paragraph", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [
      schema.text("alp", [schema.mark("strong")]),
      schema.text("ha alpha"),
    ])]);
    expect(getSearchMatchesFromDocument(doc, "alpha")).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
    ]);
  });

  test("moves the active decoration without changing note content", () => {
    const doc = documentWithParagraphs("alpha beta alpha", "alpha");
    const state = EditorState.create({ doc });
    let query = "alpha";
    let activeIndex = 0;
    const plugin = createNoteSearchHighlightPlugin({
      getQuery: () => query,
      getActiveIndex: () => activeIndex,
    });
    const decorations = () => plugin.props.decorations(state).find();
    expect(decorations().filter((item) => item.type.attrs.class.includes("-active")))
      .toHaveLength(1);
    activeIndex = 2;
    expect(decorations()[2].type.attrs.class).toContain("edgeever-search-match-active");
    expect(decorations()[0].type.attrs.class).toBe("edgeever-search-match");
    query = "missing";
    expect(decorations()).toEqual([]);
    expect(state.doc).toBe(doc);
  });

  test("wraps navigation and formats the result label", () => {
    expect(getNextSearchMatchIndex(2, 1, 3)).toBe(0);
    expect(getNextSearchMatchIndex(0, -1, 3)).toBe(2);
    expect(getNextSearchMatchIndex(4, 1, 0)).toBe(0);
    expect(formatNoteSearchMatchLabel("alpha", 1, 3)).toBe("2/3");
    expect(formatNoteSearchMatchLabel("alpha", 0, 0)).toBe("0/0");
    expect(formatNoteSearchMatchLabel("  ", 0, 3)).toBe("0/0");
  });

  test("resets in-note search when switching notes, including leftover plugin jumps", () => {
    expect(shouldResetNoteSearchForMemoChange("note-a", "note-b")).toBe(true);
    expect(shouldResetNoteSearchForMemoChange("note-a", "note-a")).toBe(false);
    expect(shouldResetNoteSearchForMemoChange(null, "note-b")).toBe(true);
    expect(shouldResetNoteSearchForMemoChange(null, null)).toBe(false);
    // Desktop create keeps the editor instance key while the local id remaps.
    expect(shouldResetNoteSearchForMemoChange("memo_local_1", "memo_local_1")).toBe(false);
    expect(shouldDiscardPluginNoteSearchRequest(
      { noteId: "note-a" },
      "note-b",
    )).toBe(true);
    expect(shouldDiscardPluginNoteSearchRequest(
      { noteId: "note-a" },
      "note-a",
    )).toBe(false);
    expect(shouldDiscardPluginNoteSearchRequest(null, "note-b")).toBe(false);
    expect(shouldDiscardPluginNoteSearchRequest({ noteId: "note-a" }, null)).toBe(true);
  });

  test("does not treat document edits as a new search navigation request", () => {
    const identityBeforeEdit = getSearchNavigationIdentity("memo-1", "note", "alpha");
    const matchesBeforeEdit = getSearchMatchesFromDocument(
      documentWithParagraphs("alpha before"),
      "alpha",
    );
    const identityAfterEdit = getSearchNavigationIdentity("memo-1", "note", "alpha");
    const matchesAfterEdit = getSearchMatchesFromDocument(
      documentWithParagraphs("changed text", "alpha after"),
      "alpha",
    );

    expect(matchesAfterEdit).not.toEqual(matchesBeforeEdit);
    expect(identityAfterEdit).toBe(identityBeforeEdit);
    expect(getSearchNavigationIdentity("memo-1", "note", "beta")).not.toBe(identityBeforeEdit);
  });
});

import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { EditorState, Selection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import {
  createHeadingCollapseExtension,
  createHeadingCollapsePlugin,
  getCollapsedHeadingPositions,
  headingCollapsePluginKey,
  resolveHeadingCollapseLabels,
  resolveHeadingFolds,
  resolveHeadingLevel,
  selectionTouchesFold,
} from "./heading-collapse.ts";

const schema = getSchema([StarterKit, createHeadingCollapseExtension()]);

const paragraph = (text) => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

const heading = (level, text) => ({
  type: "heading",
  attrs: { level },
  content: text ? [{ type: "text", text }] : [],
});

const docFrom = (content) => schema.nodeFromJSON({ type: "doc", content });

const buildState = (content) => {
  const doc = docFrom(content);
  return {
    doc,
    state: EditorState.create({
      schema,
      doc,
      plugins: [createHeadingCollapsePlugin()],
      selection: Selection.atStart(doc),
    }),
  };
};

describe("heading collapse", () => {
  test("resolves heading levels only for real headings", () => {
    expect(resolveHeadingLevel(docFrom([heading(2, "A")]).child(0))).toBe(2);
    expect(resolveHeadingLevel(docFrom([paragraph("A")]).child(0))).toBe(0);
  });

  test("folds every block until the next heading of the same or higher level", () => {
    const doc = docFrom([
      heading(1, "H1"),
      paragraph("one"),
      heading(2, "H2"),
      paragraph("two"),
      heading(2, "H2b"),
      paragraph("three"),
    ]);
    const folds = resolveHeadingFolds(doc);

    expect(folds.map((fold) => fold.level)).toEqual([1, 2, 2]);
    expect(folds[0].pos).toBe(0);
    expect(folds[0].hideFrom).toBe(folds[0].pos + doc.child(0).nodeSize);
    expect(folds[0].hideTo).toBe(doc.content.size);
    expect(folds[0].bodyPositions).toHaveLength(5);
    expect(folds[1].hideTo).toBe(folds[2].pos);
    expect(folds[1].bodyPositions).toHaveLength(1);
    expect(folds[2].hideTo).toBe(doc.content.size);
    expect(folds[2].bodyPositions).toHaveLength(1);
  });

  test("folds a level-two heading even when no level-one heading exists", () => {
    const doc = docFrom([
      heading(2, "A"),
      paragraph("one"),
      heading(3, "A.1"),
      paragraph("two"),
      heading(2, "B"),
      paragraph("three"),
    ]);
    const folds = resolveHeadingFolds(doc);

    expect(folds[0].hideFrom).toBe(folds[0].pos + doc.child(0).nodeSize);
    expect(folds[0].hideTo).toBe(folds[2].pos);
    expect(folds[0].bodyPositions).toHaveLength(3);
    expect(folds[1].hideTo).toBe(folds[2].pos);
    expect(folds[2].hideTo).toBe(doc.content.size);
  });

  test("does not offer folding when the heading has no following block", () => {
    const folds = resolveHeadingFolds(docFrom([
      heading(1, "A"),
      heading(1, "B"),
    ]));
    expect(folds[0].hasBody).toBe(false);
    expect(folds[0].bodyPositions).toEqual([]);
    expect(folds[1].hasBody).toBe(false);
  });

  test("recognizes selections inside a folded range", () => {
    const fold = { hideFrom: 4, hideTo: 12 };
    expect(selectionTouchesFold({ from: 4, to: 4 }, fold)).toBe(true);
    expect(selectionTouchesFold({ from: 11, to: 11 }, fold)).toBe(true);
    expect(selectionTouchesFold({ from: 12, to: 12 }, fold)).toBe(false);
    expect(selectionTouchesFold({ from: 2, to: 6 }, fold)).toBe(true);
    expect(selectionTouchesFold({ from: 6, to: 12 }, fold)).toBe(true);
  });

  test("toggles a heading fold without changing the document", () => {
    const { doc, state } = buildState([
      heading(1, "H1"),
      paragraph("body"),
    ]);
    const collapsed = state.apply(
      state.tr.setMeta(headingCollapsePluginKey, { type: "toggle", pos: 0 }),
    );

    expect(getCollapsedHeadingPositions(collapsed)).toEqual([0]);
    expect(collapsed.doc.eq(doc)).toBe(true);
    expect(collapsed.doc.textContent).toBe("H1body");

    const expanded = collapsed.apply(
      collapsed.tr.setMeta(headingCollapsePluginKey, { type: "toggle", pos: 0 }),
    );
    expect(getCollapsedHeadingPositions(expanded)).toEqual([]);
  });

  test("hides folded body blocks through node decorations", () => {
    const plugin = createHeadingCollapsePlugin();
    const doc = docFrom([
      heading(1, "H1"),
      paragraph("body"),
      heading(2, "H2"),
      paragraph("two"),
    ]);
    const state = EditorState.create({ schema, doc, plugins: [plugin] });
    const collapsed = state.apply(
      state.tr.setMeta(headingCollapsePluginKey, { type: "toggle", pos: 0 }),
    );
    const decorations = plugin.props.decorations(collapsed);
    const hidden = decorations
      .find()
      .filter((decoration) => decoration.type.attrs?.["data-edgeever-heading-hidden"] === "true");

    expect(hidden.map((decoration) => decoration.from)).toEqual([4, 10, 14]);
    expect(hidden.some((decoration) => decoration.from === 0)).toBe(false);
  });

  test("maps folded positions through document edits", () => {
    const { state } = buildState([
      heading(1, "H1"),
      paragraph("body"),
    ]);
    const collapsed = state.apply(
      state.tr.setMeta(headingCollapsePluginKey, { type: "toggle", pos: 0 }),
    );
    const insertedParagraph = schema.nodes.paragraph.create(null, schema.text("new"));
    const inserted = collapsed.apply(collapsed.tr.insert(0, insertedParagraph));

    expect(getCollapsedHeadingPositions(inserted)).toEqual([insertedParagraph.nodeSize]);
  });

  test("expands a fold when the caret moves into its hidden range", () => {
    const { state } = buildState([
      heading(1, "H1"),
      paragraph("body"),
    ]);
    const collapsed = state.apply(
      state.tr.setMeta(headingCollapsePluginKey, { type: "toggle", pos: 0 }),
    );
    const bodyPos = collapsed.doc.child(0).nodeSize + 1;
    const moved = collapsed.apply(
      collapsed.tr.setSelection(Selection.near(collapsed.doc.resolve(bodyPos))),
    );

    expect(getCollapsedHeadingPositions(moved)).toEqual([]);
  });

  test("localizes the toggle labels", () => {
    expect(resolveHeadingCollapseLabels("zh-CN").collapse).toBe("收起");
    expect(resolveHeadingCollapseLabels("zh-CN").expand).toBe("展开");
    expect(resolveHeadingCollapseLabels("ja").expand).toBe("展開");
    expect(resolveHeadingCollapseLabels("en-US").collapse).toBe("Collapse");
    expect(resolveHeadingCollapseLabels("fr").expand).toBe("Expand");
    expect(resolveHeadingCollapseLabels("en-US", { collapse: "Hide" }).collapse).toBe("Hide");
  });
});

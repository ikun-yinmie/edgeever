import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { ParagraphFormat, normalizeLineSpacing, updateParagraphLineSpacing } from "./paragraph-format.ts";
import {
  createEdgeEverDocumentExtensions,
  docToMarkdown,
  IMAGE_GALLERY_NODE_TYPE,
  markdownToDoc,
  MERGE_DIVIDER_MARKDOWN_MARKER,
  MERGE_DIVIDER_NODE_TYPE,
} from "./index.ts";
import { createEdgeEverMarkdownMathematics } from "./mathematics-markdown.ts";

const factorySource = readFileSync(resolve(import.meta.dir, "document-extensions.ts"), "utf8");

describe("paragraph line spacing", () => {
  const schema = getSchema([StarterKit, ParagraphFormat]);
  const paragraph = (text) => schema.node("paragraph", null, schema.text(text));
  const createState = (selection = { from: 1, to: 1 }) => {
    const doc = schema.node("doc", null, [
      paragraph("First paragraph"),
      paragraph("Second paragraph"),
      schema.node("heading", { level: 2 }, schema.text("Heading")),
      schema.node("bulletList", null, [schema.node("listItem", null, [paragraph("Nested paragraph")])]),
      schema.node("codeBlock", null, schema.text("const value = 1;")),
    ]);
    return EditorState.create({ schema, doc, selection: TextSelection.create(doc, selection.from, selection.to) });
  };

  test("validates signed pixel offsets without admitting CSS input", () => {
    expect(normalizeLineSpacing(-8)).toBe(-8);
    expect(normalizeLineSpacing("-8")).toBe(-8);
    expect(normalizeLineSpacing(0)).toBe(0);
    expect(normalizeLineSpacing(-100)).toBe(-12);
    expect(normalizeLineSpacing(100)).toBe(32);
    for (const value of [null, undefined, NaN, Infinity, "", "1px", "1; color: red", {}]) {
      expect(normalizeLineSpacing(value)).toBeNull();
    }
  });

  test("an empty selection changes all paragraphs and headings but not code", () => {
    let state = createState();
    const before = state.doc.textContent;
    expect(updateParagraphLineSpacing(state, (tr) => { state = state.apply(tr); }, { lineSpacing: -8 })).toBe(true);
    let changed = 0;
    state.doc.descendants((node) => {
      if (node.type.name === "paragraph" || node.type.name === "heading") {
        expect(node.attrs.lineSpacing).toBe(-8);
        changed += 1;
      }
      if (node.type.name === "codeBlock") expect(node.attrs.lineSpacing).toBeUndefined();
    });
    expect(changed).toBe(4);
    expect(state.doc.textContent).toBe(before);
    expect(state.selection.from).toBe(1);
    expect(state.selection.to).toBe(1);
    expect(updateParagraphLineSpacing(state, () => { throw new Error("Unexpected update"); }, { lineSpacing: -8 })).toBe(false);
  });

  test("a text selection changes only intersecting paragraphs and preserves selection", () => {
    let state = createState({ from: 2, to: 5 });
    expect(updateParagraphLineSpacing(state, (tr) => { state = state.apply(tr); }, { lineSpacing: -4 })).toBe(true);
    expect(state.doc.child(0).attrs.lineSpacing).toBe(-4);
    expect(state.doc.child(1).attrs.lineSpacing).toBeNull();
    expect(state.doc.child(2).attrs.lineSpacing).toBeNull();
    expect(state.selection.from).toBe(2);
    expect(state.selection.to).toBe(5);
    expect(updateParagraphLineSpacing(state, (tr) => { state = state.apply(tr); }, { lineHeight: "2", lineSpacing: null })).toBe(true);
    expect(state.doc.child(0).attrs.lineHeight).toBe("2");
    expect(state.doc.child(0).attrs.lineSpacing).toBeNull();
  });

  test("reset clears both spacing formats across the entire note", () => {
    let state = createState();
    const original = state.doc.toJSON();
    updateParagraphLineSpacing(state, (tr) => { state = state.apply(tr); }, { lineHeight: "2", lineSpacing: -6 });
    updateParagraphLineSpacing(state, (tr) => { state = state.apply(tr); }, { lineHeight: null, lineSpacing: null });
    expect(state.doc.toJSON()).toEqual(original);
  });

  test("an explicit range remains local even when editor focus changes", () => {
    let state = createState();
    const range = { from: 1, to: state.doc.child(0).nodeSize + state.doc.child(1).nodeSize - 1 };
    updateParagraphLineSpacing(state, (tr) => { state = state.apply(tr); }, { lineSpacing: -3 }, range);
    expect(state.doc.child(0).attrs.lineSpacing).toBe(-3);
    expect(state.doc.child(1).attrs.lineSpacing).toBe(-3);
    expect(state.doc.child(2).attrs.lineSpacing).toBeNull();
    expect(state.selection.empty).toBe(true);
  });

  test("line-height presets stay unitless so inline font sizes still scale", () => {
    for (const lineSpacing of [null, 0]) {
      const node = schema.node("paragraph", { lineHeight: "2", lineSpacing }, schema.text("Text"));
      expect(schema.nodes.paragraph.spec.toDOM(node)[1].style).toBe("line-height: 2 !important");
    }
  });

  test("negative spacing renders a valid positive line box and round-trips as JSON", () => {
    const node = schema.node("paragraph", { lineHeight: "2", lineSpacing: -8 }, schema.text("Text"));
    const dom = schema.nodes.paragraph.spec.toDOM(node);
    expect(dom[1]["data-line-height"]).toBe("2");
    expect(dom[1]["data-line-spacing"]).toBe("-8");
    expect(dom[1].style).toContain("max(0.5em, calc(2 * 1em + -8px))");
    expect(schema.nodeFromJSON(node.toJSON()).attrs.lineSpacing).toBe(-8);
    const fallback = schema.nodes.paragraph.spec.toDOM(schema.node("paragraph", { lineSpacing: -4 }, schema.text("Default")));
    expect(fallback[1].style).toContain("var(--editor-body-line-height, 1.6)");
  });
});

describe("shared document extensions", () => {
  test("does not import the KaTeX mathematics entry", () => {
    expect(factorySource).not.toContain('from "./mathematics"');
    expect(factorySource).not.toContain("createEdgeEverMathematics");
  });

  test("registers the same document nodes the Markdown codec uses", () => {
    const names = createEdgeEverDocumentExtensions({
      mathematics: createEdgeEverMarkdownMathematics(),
      markdown: true,
    }).map((extension) => extension.name);

    expect(names).toContain("starterKit");
    expect(names).toContain("taskList");
    expect(names).toContain("taskItem");
    expect(names).toContain("tableKit");
    expect(names).toContain("image");
    expect(names).toContain(IMAGE_GALLERY_NODE_TYPE);
    expect(names).toContain("edgeeverPdfAttachment");
    expect(names).toContain("edgeeverFileAttachment");
    expect(names).toContain(MERGE_DIVIDER_NODE_TYPE);
    expect(names).toContain("details");
    expect(names).toContain("detailsSummary");
    expect(names).toContain("detailsContent");
    expect(names).toContain("edgeeverPluginEmbed");
    expect(names).toContain("markdown");
  });

  test("keeps the stock task list schema and adds an optional numbered flag", () => {
    expect(factorySource).toContain("export const EdgeEverTaskList = TaskList.extend");
    expect(factorySource).toContain('"data-task-numbered": "true"');
    expect(factorySource).toContain("withOptional(options.taskList, EdgeEverTaskList)");
  });

  test("round-trips merge dividers and formulas through the codec factory", () => {
    const markdown = `alpha\n\n${MERGE_DIVIDER_MARKDOWN_MARKER}\n\n---\n\nEuler: $e^{i\\pi}+1=0$.`;
    const doc = markdownToDoc(markdown);
    expect(doc.content.map((node) => node.type)).toEqual([
      "paragraph",
      MERGE_DIVIDER_NODE_TYPE,
      "paragraph",
    ]);
    expect(doc.content[2]?.content?.some((node) => node.type === "inlineMath")).toBe(true);
    expect(docToMarkdown(doc)).toContain(MERGE_DIVIDER_MARKDOWN_MARKER);
  });
});

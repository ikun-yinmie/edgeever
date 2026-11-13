import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createEdgeEverDocumentExtensions, docToMarkdown, markdownToDoc } from "./index.ts";
import { splitTaskItemWithoutInheritedMarks } from "./list-shortcuts.ts";

const taskItems = (doc) => {
  const items = [];
  const visit = (node) => {
    if (node.type === "taskItem") items.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return items;
};
const statuses = (doc) => taskItems(doc).map(({ attrs }) => [attrs.checked, attrs.rejected]);

describe("red cross task status", () => {
  test("mixed pending, completed and rejected tasks round-trip through Markdown", () => {
    const source = "- [ ] Pending\n- [x] Completed\n- [❌] Rejected\n  - [❌] Nested rejected\n  - [X] Nested completed\n- [-] Cross shorthand\n";
    const doc = markdownToDoc(source);
    const expected = [[false, false], [true, false], [false, true], [false, true], [true, false], [false, true]];
    expect(statuses(doc)).toEqual(expected);
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain("- [❌] Rejected");
    expect(markdown).toContain("- [❌] Cross shorthand");
    expect(statuses(markdownToDoc(markdown))).toEqual(expected);
    expect(taskItems(doc)[2].content[1].type).toBe("taskList");
  });

  test("rejected tasks retain nested ordinary lists and child paragraphs", () => {
    const doc = markdownToDoc("- [❌] Parent\n  - [❌] Rejected child\n\n  Extra paragraph\n\n  - Ordinary child\n");
    const restored = markdownToDoc(docToMarkdown(doc));
    expect(statuses(restored)).toEqual([[false, true], [false, true]]);
    expect(JSON.stringify(restored)).toContain("Extra paragraph");
    expect(JSON.stringify(restored)).toContain("Ordinary child");
  });

  test("fenced code and escaped cross examples do not become tasks", () => {
    const doc = markdownToDoc("```md\n- [❌] Code example\n```\n\n\\- [❌] Escaped example\n");
    expect(taskItems(doc)).toHaveLength(0);
    expect(doc.content[0].content[0].text).toBe("- [❌] Code example");
  });

  test("legacy JSON tasks without rejected still serialize as standard checkboxes", () => {
    const doc = { type: "doc", content: [{ type: "taskList", content: [
      { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Legacy" }] }] },
    ] }] };
    expect(docToMarkdown(doc)).toBe("- [x] Legacy");
    expect(statuses(markdownToDoc(docToMarkdown(doc)))).toEqual([[true, false]]);
  });

  test("Enter after a rejected task creates a pending sibling", () => {
    const schema = getSchema(createEdgeEverDocumentExtensions({ mathematics: [] }));
    const doc = schema.nodeFromJSON(markdownToDoc("- [❌] Rejected"));
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 11) });
    let next;
    expect(splitTaskItemWithoutInheritedMarks(state, (tr) => { next = state.apply(tr); })).toBe(true);
    expect(statuses(next.doc.toJSON())).toEqual([[false, true], [false, false]]);
  });
});

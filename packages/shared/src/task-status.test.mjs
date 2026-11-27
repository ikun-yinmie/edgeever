import { describe, expect, test } from "bun:test";
import { getAttributesFromExtensions, getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createEdgeEverDocumentExtensions, docToMarkdown, docToText, EdgeEverTaskItem, EdgeEverTaskList, markdownToDoc } from "./index.ts";
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
const sources = (doc) => taskItems(doc).map(({ attrs }) => attrs.statusSource);
const schema = getSchema(createEdgeEverDocumentExtensions({ mathematics: [] }));
const taskDocument = (attrs, text = "Task") => ({
  type: "doc",
  content: [{ type: "taskList", content: [{
    type: "taskItem",
    attrs,
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
  }] }],
});

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

describe("task status source codec", () => {
  test("schema defaults legacy sources to null without inferring manual or auto", () => {
    const attribute = getAttributesFromExtensions([EdgeEverTaskItem])
      .find(({ name }) => name === "statusSource").attribute;
    expect(attribute.default).toBeNull();
    expect(attribute.keepOnSplit).toBe(false);

    for (const [marker, checked, rejected] of [[" ", false, false], ["x", true, false], ["❌", false, true]]) {
      const doc = schema.nodeFromJSON(taskDocument({ checked, rejected }));
      expect(sources(doc.toJSON())).toEqual([null]);
      expect(docToMarkdown(doc.toJSON())).toBe(`- [${marker}] Task`);
      const restored = markdownToDoc(docToMarkdown(doc.toJSON()));
      expect(sources(restored)).toEqual([null]);
      expect(statuses(restored)).toEqual([[checked, rejected]]);
    }
  });

  for (const statusSource of [null, "manual", "auto"]) {
    for (const [marker, checked, rejected] of [[" ", false, false], ["x", true, false], ["❌", false, true]]) {
      test(`${statusSource ?? "legacy"} source on [${marker}] survives JSON/schema and Markdown`, () => {
        const doc = schema.nodeFromJSON(taskDocument({ checked, rejected, statusSource }));
        const saved = JSON.parse(JSON.stringify(doc.toJSON()));
        const reloaded = schema.nodeFromJSON(saved);
        reloaded.check();
        expect(sources(reloaded.toJSON())).toEqual([statusSource]);
        const prefix = statusSource ? `<!-- edgeever:task-status ${statusSource} --> ` : "";
        const markdown = docToMarkdown(reloaded.toJSON());
        expect(markdown).toBe(`- [${marker}] ${prefix}Task`);
        const restored = markdownToDoc(markdown);
        expect(sources(restored)).toEqual([statusSource]);
        expect(statuses(restored)).toEqual([[checked, rejected]]);
        expect(docToText(restored)).toBe("Task");
        expect(docToMarkdown(restored)).toBe(markdown);
      });
    }
  }

  test("leading metadata is stripped before inline parsing and stays local to nested tasks", () => {
    const markdown = [
      "- [ ] <!-- edgeever:task-status manual --> **Parent**",
      "  - [x] <!-- edgeever:task-status auto --> [Child](https://example.com)",
      "    - [❌] <!-- edgeever:task-status manual --> `Grandchild`",
      "  - [ ] Legacy child",
      "",
      "  Extra paragraph",
      "",
      "  - Ordinary child",
      "- [-] <!-- edgeever:task-status auto --> Rejected sibling",
    ].join("\n");
    const doc = markdownToDoc(markdown);
    expect(sources(doc)).toEqual(["manual", "auto", "manual", null, "auto"]);
    expect(statuses(doc)).toEqual([[false, false], [true, false], [false, true], [false, false], [false, true]]);
    expect(taskItems(doc)[0].content[1].type).toBe("taskList");
    expect(taskItems(doc)[1].content[1].type).toBe("taskList");
    expect(taskItems(doc)[0].content[0].content[0].marks).toEqual([{ type: "bold" }]);
    expect(taskItems(doc)[1].content[0].content[0].marks[0].type).toBe("link");
    expect(taskItems(doc)[2].content[0].content[0].marks).toEqual([{ type: "code" }]);
    expect(docToText(doc)).not.toContain("edgeever:task-status");
    expect(docToText(doc)).toContain("Extra paragraph");
    expect(docToText(doc)).toContain("Ordinary child");
    const restored = markdownToDoc(docToMarkdown(doc));
    expect(restored).toEqual(doc);
    schema.nodeFromJSON(restored).check();
  });

  test("empty tasks round-trip with every source and mark, including after trailing spaces are trimmed", () => {
    for (const statusSource of [null, "manual", "auto"]) {
      for (const [checked, rejected] of [[false, false], [true, false], [false, true]]) {
        const markdown = docToMarkdown(taskDocument({ checked, rejected, statusSource }, ""));
        for (const source of [markdown, markdown.trimEnd()]) {
          const restored = markdownToDoc(source);
          expect(sources(restored)).toEqual([statusSource]);
          expect(statuses(restored)).toEqual([[checked, rejected]]);
          expect(taskItems(restored)[0].content).toEqual([{ type: "paragraph", content: [] }]);
          expect(docToText(restored)).toBe("");
          schema.nodeFromJSON(restored).check();
        }
      }
    }
    const siblings = markdownToDoc("Intro\n\n- [ ]\n- [ ] <!-- edgeever:task-status manual -->\n  - [x]\n");
    expect(sources(siblings)).toEqual([null, "manual", null]);
    expect(statuses(siblings)).toEqual([[false, false], [false, false], [true, false]]);
  });

  test("code and escaped examples do not become task metadata", () => {
    const line = "- [❌] <!-- edgeever:task-status manual --> Example";
    for (const markdown of [`\`\`\`md\n${line}\n\`\`\``, `~~~md\n${line}\n~~~`, `\\${line}`]) {
      const doc = markdownToDoc(markdown);
      expect(taskItems(doc)).toHaveLength(0);
      expect(docToText(doc)).toContain("edgeever:task-status manual");
      expect(taskItems(markdownToDoc(docToMarkdown(doc)))).toHaveLength(0);
    }
    for (const markdown of [`    ${line}`, `\t${line}`]) {
      // Indented code belongs to the existing code-block codec, not task metadata.
      expect(taskItems(markdownToDoc(markdown))).toHaveLength(0);
    }
    for (const body of ["\\<!-- edgeever:task-status manual --> Example", "`<!-- edgeever:task-status auto -->` Example", "&lt;!-- edgeever:task-status manual --&gt; Example"]) {
      const doc = markdownToDoc(`- [ ] ${body}`);
      expect(sources(doc)).toEqual([null]);
      expect(docToText(doc)).toContain("<!-- edgeever:task-status");
      expect(sources(markdownToDoc(docToMarkdown(doc)))).toEqual([null]);
    }
  });

  test("unknown, malformed and non-leading comments are not consumed as metadata", () => {
    const bodies = [
      "<!-- edgeever:task-status invalid --> Task",
      "<!-- edgeever:task-status MANUAL --> Task",
      "<!-- edgeever:task-status manual extra --> Task",
      "<!-- edgeever:task-status manual Task",
      "<!-- edgeever:task-status manual -->Task",
      "<!-- edgeever:task-status --> Task",
      "<!-- unrelated manual --> Task",
      "Task <!-- edgeever:task-status auto -->",
    ];
    for (const body of bodies) {
      // Verify the tokenizer leaves the full text for the ordinary inline codec.
      const inlineInputs = [];
      const token = EdgeEverTaskList.config.markdownTokenizer.tokenize(`- [ ] ${body}`, [], {
        inlineTokens(text) { inlineInputs.push(text); return []; },
        blockTokens() { return []; },
      });
      expect(token.items[0].statusSource).toBeNull();
      expect(token.items[0].text).toBe(body);
      expect(inlineInputs).toEqual([body]);
      const doc = markdownToDoc(`- [ ] ${body}`);
      expect(sources(doc)).toEqual([null]);
      expect(docToText(doc)).toBe(body);
      expect(sources(markdownToDoc(docToMarkdown(doc)))).toEqual([null]);
    }
  });

  test("HTML schema attribute hooks round-trip only manual and auto sources", () => {
    const type = schema.nodes.taskItem;
    const parseAttrs = (attributes) => type.spec.parseDOM[0].getAttrs({
      dataset: {},
      getAttribute: (name) => attributes[name] == null ? null : String(attributes[name]),
    });
    // Exercise the schema's actual toDOM/parseDOM hooks without a browser DOM.
    for (const statusSource of [null, "manual", "auto"]) {
      for (const [checked, rejected] of [[false, false], [true, false], [false, true]]) {
        const node = type.create({ checked, rejected, statusSource }, schema.nodes.paragraph.create());
        const output = type.spec.toDOM(node);
        expect(output[0]).toBe("li");
        expect(output[1]["data-type"]).toBe("taskItem");
        expect(output[1]["data-task-status-source"]).toBe(statusSource ?? undefined);
        const restored = type.create(parseAttrs(output[1]), node.content);
        expect(restored.attrs.statusSource).toBe(statusSource);
        expect(restored.attrs.checked).toBe(checked);
        expect(restored.attrs.rejected).toBe(rejected);
      }
    }
    for (const statusSource of [undefined, "", "MANUAL", "manual ", " auto", "invalid", "null"]) {
      const parsed = type.create(parseAttrs({ "data-task-status-source": statusSource }), schema.nodes.paragraph.create());
      expect(parsed.attrs.statusSource).toBeNull();
      const node = type.create({ statusSource }, schema.nodes.paragraph.create());
      expect(type.spec.toDOM(node)[1]).not.toHaveProperty("data-task-status-source");
      expect(docToMarkdown(taskDocument({ statusSource }))).not.toContain("edgeever:task-status");
    }
  });

  test("splitting a task resets its source while retaining the original source", () => {
    for (const statusSource of ["manual", "auto"]) {
      const doc = schema.nodeFromJSON(taskDocument({ checked: false, rejected: false, statusSource }));
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, 7) });
      let next;
      expect(splitTaskItemWithoutInheritedMarks(state, (tr) => { next = state.apply(tr); })).toBe(true);
      expect(sources(next.doc.toJSON())).toEqual([statusSource, null]);
      expect(statuses(next.doc.toJSON())).toEqual([[false, false], [false, false]]);
    }
  });
});

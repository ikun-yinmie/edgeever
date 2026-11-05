import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem } from "@tiptap/extension-list";
import { EdgeEverTaskList, EdgeEverTaskItem, createEdgeEverCodeBlock } from "@edgeever/shared";
import {
  applyPlainTextTab,
  getAiSlashCommandStart,
  handleConsecutiveListEnter,
  insertListItemChildParagraph,
  preserveEmptyListIndentOnBackspace,
  saveAndSyncEditor,
  shouldOpenAiFromSpace,
  sinkListItemPreservingAttrs,
  splitTaskItemWithoutInheritedMarks,
  toggleTaskItemCollapseAtSelection,
  wrapIndentedParagraphInList,
} from "./editor-shortcuts.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    codeBlock: { content: "text*", group: "block", code: true },
    bulletList: { content: "listItem+", group: "block" },
    listItem: { content: "paragraph block*" },
    text: { group: "inline" },
  },
});

const createState = (paragraphs, from, to = from) => {
  const doc = schema.node("doc", null, paragraphs.map((text) =>
    schema.node("paragraph", null, text ? schema.text(text) : null)
  ));
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
};

const runTab = (state, shiftKey = false) => {
  let nextState = state;
  const handled = applyPlainTextTab(state, (transaction) => {
    nextState = state.apply(transaction);
  }, shiftKey);
  return { handled, state: nextState };
};

const runListBackspace = (state) => {
  let nextState = state;
  const handled = preserveEmptyListIndentOnBackspace(state, (transaction) => {
    nextState = state.apply(transaction);
  });
  return { handled, state: nextState };
};

describe("code blocks inside task sub-content", () => {
  let navigatorDescriptor;
  beforeEach(() => {
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "Linux", userAgent: "Bun" },
    });
  });
  afterEach(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });

  const createEditor = (text = "", { nested = false, blockType = "codeBlock" } = {}) => {
    const paragraph = (value) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
    const taskList = {
      type: "taskList",
      attrs: { numbered: true },
      content: [
        { type: "taskItem", content: [paragraph("Before")] },
        {
          type: "taskItem",
          attrs: { checked: true, collapsed: false },
          content: [paragraph("Task"), {
            type: blockType,
            content: text ? [{ type: "text", text }] : [],
          }],
        },
      ],
    };
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        EdgeEverTaskList,
        EdgeEverTaskItem.configure({ nested: true }),
        createEdgeEverCodeBlock(),
      ],
      content: {
        type: "doc",
        content: [nested ? {
          type: "taskList",
          content: [{ type: "taskItem", content: [paragraph("Parent"), taskList] }],
        } : taskList],
      },
    });
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === blockType && node.textContent === text) {
        editor.commands.setTextSelection(position + 1 + node.content.size);
      }
    });
    return editor;
  };

  const pressKey = (editor, key, modifiers = {}) => {
    const event = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers };
    return editor.extensionManager.plugins.some((plugin) => plugin.props.handleKeyDown?.(editor.view, event));
  };

  for (const [name, command] of [
    ["consecutive Enter", handleConsecutiveListEnter],
    ["task Enter", splitTaskItemWithoutInheritedMarks],
    ["task Shift-Enter", insertListItemChildParagraph],
  ]) {
    test(`${name} leaves empty and non-empty code blocks unchanged`, () => {
      for (const text of ["", "first\nsecond"]) {
        const editor = createEditor(text);
        const before = editor.getJSON();
        let dispatched = false;
        expect(command(editor.state, undefined)).toBe(false);
        expect(command(editor.state, () => { dispatched = true; })).toBe(false);
        expect(dispatched).toBe(false);
        expect(editor.getJSON()).toEqual(before);
        editor.destroy();
      }
    });
  }

  test("Mod-Alt-c creates and toggles code blocks while preserving task attributes and text", () => {
    const editor = createEditor("detail", { blockType: "paragraph" });
    const before = editor.getJSON();
    before.content[0].content[1].content.push({ type: "paragraph" });
    expect(pressKey(editor, "c", { ctrlKey: true, altKey: true })).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.state.doc.child(0).child(1).attrs.collapsed).toBe(false);
    expect(editor.state.doc.child(0).child(1).firstChild.textContent).toBe("Task");
    expect(pressKey(editor, "c", { ctrlKey: true, altKey: true })).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  for (const nested of [false, true]) {
    test(`Enter and Shift-Enter stay inside ${nested ? "nested " : ""}task code blocks`, () => {
      for (const text of ["", "first"]) {
        const editor = createEditor(text, { nested });
        expect(pressKey(editor, "Enter")).toBe(true);
        expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
        expect(editor.state.selection.$from.parent.textContent).toBe(`${text}\n`);
        expect(pressKey(editor, "Enter", { shiftKey: true })).toBe(true);
        expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
        expect(editor.state.selection.$from.parent.textContent).toBe(`${text}\n\n`);
        expect(editor.state.selection.$from.node(-1).childCount).toBe(2);
        editor.destroy();
      }
    });

    test(`Tab and Shift-Tab indent code instead of ${nested ? "nested " : ""}tasks`, () => {
      const editor = createEditor("first\nsecond", { nested });
      const before = editor.getJSON();
      const { $from } = editor.state.selection;
      const from = $from.start();
      const to = $from.end();
      editor.commands.setTextSelection({ from, to });
      expect(pressKey(editor, "Tab")).toBe(true);
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
      expect(editor.state.selection.$from.parent.textContent).toBe("    first\n    second");
      expect(editor.state.selection.from).toBe(from);
      expect(editor.state.selection.to).toBe(to + 8);
      expect(editor.state.selection.$from.node(-1).childCount).toBe(2);
      expect(pressKey(editor, "Tab", { shiftKey: true })).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.selection.from).toBe(from);
      expect(editor.state.selection.to).toBe(to);
      expect(pressKey(editor, "Tab", { shiftKey: true })).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.selection.from).toBe(from);
      expect(editor.state.selection.to).toBe(to);
      editor.destroy();
    });
  }

  test("unindented Shift-Tab at the caret does not move or lift the task", () => {
    for (const text of ["", "first\nsecond"]) {
      const editor = createEditor(text, { nested: true });
      const before = editor.getJSON();
      const cursor = editor.state.selection.from;
      expect(pressKey(editor, "Tab", { shiftKey: true })).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.selection.from).toBe(cursor);
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
      editor.destroy();
    }
  });

  test("triple Enter still exits to a paragraph inside the same task", () => {
    const editor = createEditor("first");
    expect(pressKey(editor, "Enter")).toBe(true);
    expect(pressKey(editor, "Enter")).toBe(true);
    expect(pressKey(editor, "Enter")).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    const task = editor.state.selection.$from.node(-1);
    expect(task.type.name).toBe("taskItem");
    expect(task.childCount).toBe(3);
    expect(task.child(1).type.name).toBe("codeBlock");
    expect(task.child(1).textContent).toBe("first");
    expect(editor.state.doc.child(0).childCount).toBe(2);
    editor.destroy();
  });

  test("ordinary task paragraphs retain their Enter and Tab keymaps", () => {
    const editor = createEditor("detail", { blockType: "paragraph" });
    expect(pressKey(editor, "Enter")).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).childCount).toBe(3);
    expect(pressKey(editor, "Tab")).toBe(true);
    expect(editor.state.doc.child(0).childCount).toBe(2);
    expect(editor.state.selection.$from.node(-2).type.name).toBe("taskList");
    editor.destroy();
  });
});

describe("editor shortcut actions", () => {
  test("inserts a tab at the caret in a plain paragraph", () => {
    const result = runTab(createState(["hello world"], 6));

    expect(result.handled).toBe(true);
    expect(result.state.doc.textContent).toBe("hello\t world");
  });

  test("indents each selected paragraph without replacing its text", () => {
    const result = runTab(createState(["first", "second"], 2, 13));

    expect(result.handled).toBe(true);
    expect(result.state.doc.child(0).textContent).toBe("\tfirst");
    expect(result.state.doc.child(1).textContent).toBe("\tsecond");
  });

  test("Shift-Tab removes indentation and keeps focus when no indentation remains", () => {
    const indented = runTab(createState(["\thello"], 7), true);
    const unchanged = runTab(createState(["hello"], 3), true);

    expect(indented.handled).toBe(true);
    expect(indented.state.doc.textContent).toBe("hello");
    expect(unchanged.handled).toBe(true);
    expect(unchanged.state.doc.textContent).toBe("hello");
  });

  test("inserts a tab in code blocks", () => {
    const doc = schema.node("doc", null, [schema.node("codeBlock", null, schema.text("code"))]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
    const result = runTab(state);

    expect(result.handled).toBe(true);
    expect(result.state.doc.textContent).toBe("co\tde");
  });

  test("delegates list indentation to Tiptap's list keymap", () => {
    const doc = schema.node("doc", null, [
      schema.node("bulletList", null, [
        schema.node("listItem", null, [schema.node("paragraph", null, schema.text("item"))]),
      ]),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 4) });

    expect(applyPlainTextTab(state, () => {}, false)).toBe(false);
  });

  test("removes an empty sibling list marker while preserving nested indentation", () => {
    const doc = schema.node("doc", null, [
      schema.node("bulletList", null, [
        schema.node("listItem", null, [schema.node("paragraph", null, schema.text("first"))]),
        schema.node("listItem", null, [schema.node("paragraph")]),
      ]),
    ]);
    const result = runListBackspace(EditorState.create({
      doc,
      selection: TextSelection.create(doc, 12),
    }));

    expect(result.handled).toBe(true);
    expect(result.state.doc.toJSON()).toEqual({
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "first" }] },
            { type: "paragraph" },
          ],
        }],
      }],
    });
    expect(result.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(result.state.selection.$from.parent.content.size).toBe(0);

    let nestedListState = result.state;
    expect(wrapIndentedParagraphInList(result.state, undefined, "bulletList")).toBe(true);
    expect(wrapIndentedParagraphInList(result.state, (transaction) => {
      nestedListState = result.state.apply(transaction);
    }, "bulletList")).toBe(true);

    expect(nestedListState.doc.toJSON()).toEqual({
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "first" }] },
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
            },
          ],
        }],
      }],
    });
  });

  test("keeps the default Backspace behavior outside a removable sibling list item", () => {
    const firstItemOnly = schema.node("doc", null, [
      schema.node("bulletList", null, [
        schema.node("listItem", null, [schema.node("paragraph")]),
      ]),
    ]);
    const nonEmptySecondItem = schema.node("doc", null, [
      schema.node("bulletList", null, [
        schema.node("listItem", null, [schema.node("paragraph", null, schema.text("first"))]),
        schema.node("listItem", null, [schema.node("paragraph", null, schema.text("second"))]),
      ]),
    ]);

    expect(preserveEmptyListIndentOnBackspace(
      EditorState.create({ doc: firstItemOnly, selection: TextSelection.create(firstItemOnly, 3) }),
      () => {},
    )).toBe(false);
    expect(preserveEmptyListIndentOnBackspace(
      EditorState.create({ doc: nonEmptySecondItem, selection: TextSelection.create(nonEmptySecondItem, 12) }),
      () => {},
    )).toBe(false);
  });

  test("recognizes /ai only at a text boundary", () => {
    expect(getAiSlashCommandStart({ caretPosition: 2, insertedText: "i", textBefore: "/a" })).toBe(0);
    expect(getAiSlashCommandStart({ caretPosition: 8, insertedText: "I", textBefore: "hello /a" })).toBe(6);
    expect(getAiSlashCommandStart({ caretPosition: 5, insertedText: "i", textBefore: "x/a" })).toBeNull();
    expect(getAiSlashCommandStart({ caretPosition: 2, insertedText: "x", textBefore: "/a" })).toBeNull();
  });

  test("opens AI from Space only in an empty paragraph outside IME composition", () => {
    const base = {
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      isEmptyParagraph: true,
      key: " ",
      keyCode: 32,
      metaKey: false,
      repeat: false,
      selectionEmpty: true,
      shiftKey: false,
    };

    expect(shouldOpenAiFromSpace(base)).toBe(true);
    expect(shouldOpenAiFromSpace({ ...base, isEmptyParagraph: false })).toBe(false);
    expect(shouldOpenAiFromSpace({ ...base, selectionEmpty: false })).toBe(false);
    expect(shouldOpenAiFromSpace({ ...base, isComposing: true })).toBe(false);
    expect(shouldOpenAiFromSpace({ ...base, keyCode: 229 })).toBe(false);
    expect(shouldOpenAiFromSpace({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldOpenAiFromSpace({ ...base, key: "Enter" })).toBe(false);
  });

  test("saves dirty editor content before starting sync", async () => {
    const calls = [];

    await saveAndSyncEditor({
      hasUnsavedChanges: true,
      save: async () => calls.push("save"),
      sync: async () => calls.push("sync"),
    });

    expect(calls).toEqual(["save", "sync"]);
  });

  test("syncs existing queued changes when the editor is already clean", async () => {
    const calls = [];

    await saveAndSyncEditor({
      hasUnsavedChanges: false,
      save: async () => calls.push("save"),
      sync: async () => calls.push("sync"),
    });

    expect(calls).toEqual(["sync"]);
  });

  test("does not sync when saving the current snapshot fails", async () => {
    const calls = [];

    await expect(saveAndSyncEditor({
      hasUnsavedChanges: true,
      save: async () => {
        calls.push("save");
        throw new Error("save failed");
      },
      sync: async () => calls.push("sync"),
    })).rejects.toThrow("save failed");

    expect(calls).toEqual(["save"]);
  });

  test("consecutive enter converts empty taskItem into child paragraph and third enter exits list", () => {
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTaskList, EdgeEverTaskItem.configure({ nested: true })],
      content: {
        type: "doc",
        content: [{
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Task 1" }] }],
          }],
        }],
      },
    });

    // 1st Enter: splitListItem creates new sibling taskItem
    editor.commands.setTextSelection(9);
    editor.commands.splitListItem("taskItem");
    expect(editor.getJSON().content[0].content).toHaveLength(2);
    expect(editor.getJSON().content[0].content[1].type).toBe("taskItem");

    // 2nd Enter: consecutive enter merges into previous task item as child paragraph (making it collapsible)
    const handled2 = handleConsecutiveListEnter(editor.state, editor.view.dispatch);
    expect(handled2).toBe(true);
    expect(editor.getJSON().content[0].content).toHaveLength(1);
    const taskItem = editor.getJSON().content[0].content[0];
    expect(taskItem.content).toHaveLength(2);
    expect(taskItem.content[0].content[0].text).toBe("Task 1");
    expect(taskItem.content[1].type).toBe("paragraph");

    // 3rd Enter: exits empty child paragraph out of the list to root paragraph
    const handled3 = handleConsecutiveListEnter(editor.state, editor.view.dispatch);
    expect(handled3).toBe(true);
    const doc = editor.getJSON();
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].type).toBe("taskList");
    expect(doc.content[0].content[0].content).toHaveLength(1);
    expect(doc.content[1].type).toBe("paragraph");
    editor.destroy();
  });

  test("Shift+Enter creates a child paragraph inside the current task item", () => {
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTaskList, EdgeEverTaskItem.configure({ nested: true })],
      content: {
        type: "doc",
        content: [{
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: false, collapsed: true },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Task with detail" }] }],
          }],
        }],
      },
    });

    editor.commands.setTextSelection(19);
    const handled = insertListItemChildParagraph(editor.state, editor.view.dispatch);
    expect(handled).toBe(true);
    const taskItem = editor.getJSON().content[0].content[0];
    expect(taskItem.content).toHaveLength(2);
    expect(taskItem.content[0].content[0].text).toBe("Task with detail");
    expect(taskItem.content[1].type).toBe("paragraph");
    // Collapsed state was un-collapsed so new child is visible
    expect(taskItem.attrs.collapsed).toBe(false);
    editor.destroy();
  });

  test("sinkListItemPreservingAttrs preserves numbered: true on sub-taskList", () => {
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTaskList, EdgeEverTaskItem.configure({ nested: true })],
      content: {
        type: "doc",
        content: [{
          type: "taskList",
          attrs: { numbered: true },
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Numbered 1" }] }],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Numbered 2" }] }],
            },
          ],
        }],
      },
    });

    editor.commands.setTextSelection(18);
    const handled = sinkListItemPreservingAttrs(editor.state, editor.view.dispatch);
    expect(handled).toBe(true);
    const nestedList = editor.getJSON().content[0].content[0].content[1];
    expect(nestedList.type).toBe("taskList");
    expect(nestedList.attrs.numbered).toBe(true);
    editor.destroy();
  });

  test("toggleTaskItemCollapseAtSelection toggles collapsed state of task item with children", () => {
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTaskList, EdgeEverTaskItem.configure({ nested: true })],
      content: {
        type: "doc",
        content: [{
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: false, collapsed: false },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Task 1" }] },
              { type: "paragraph", content: [{ type: "text", text: "Sub text" }] },
            ],
          }],
        }],
      },
    });

    editor.commands.setTextSelection(5);
    const toggled = toggleTaskItemCollapseAtSelection(editor.state, editor.view.dispatch);
    expect(toggled).toBe(true);
    expect(editor.getJSON().content[0].content[0].attrs.collapsed).toBe(true);

    const toggledAgain = toggleTaskItemCollapseAtSelection(editor.state, editor.view.dispatch);
    expect(toggledAgain).toBe(true);
    expect(editor.getJSON().content[0].content[0].attrs.collapsed).toBe(false);
    editor.destroy();
  });

  test("splitTaskItemWithoutInheritedMarks does not inherit background color or marks to the next task item", () => {
    const { EdgeEverTextStyle } = require("@edgeever/shared");
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTaskList, EdgeEverTaskItem.configure({ nested: true }), EdgeEverTextStyle],
      content: {
        type: "doc",
        content: [{
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: true, collapsed: false },
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                marks: [
                  { type: "bold" },
                  { type: "textStyle", attrs: { backgroundColor: "#fef08a", color: "#16a34a" } },
                ],
                text: "Highlighted task",
              }],
            }],
          }],
        }],
      },
    });

    // Place caret at the end of the first task item (length of "Highlighted task" is 16)
    editor.commands.setTextSelection(19);
    const split = splitTaskItemWithoutInheritedMarks(editor.state, editor.view.dispatch);
    expect(split).toBe(true);

    const doc = editor.getJSON();
    expect(doc.content[0].content).toHaveLength(2);
    const newTaskItem = doc.content[0].content[1];
    expect(newTaskItem.type).toBe("taskItem");
    // Should NOT inherit checked: true
    expect(newTaskItem.attrs.checked).toBe(false);

    // Stored marks should be empty so subsequent typing will not have background color or bold
    expect(editor.state.storedMarks ?? []).toHaveLength(0);

    // Type new text into the new task item using transaction insertText
    editor.view.dispatch(editor.state.tr.insertText("Clean task item"));
    const updatedDoc = editor.getJSON();
    const updatedNewTaskItem = updatedDoc.content[0].content[1];
    const textNode = updatedNewTaskItem.content[0].content[0];
    expect(textNode.text).toBe("Clean task item");
    // Crucial: no bold, no textStyle/backgroundColor
    expect(textNode.marks ?? []).toHaveLength(0);

    editor.destroy();
  });

  test("consecutive enter still triggers task item sub-content even when splitTaskItemWithoutInheritedMarks is in place", () => {
    const { EdgeEverTextStyle } = require("@edgeever/shared");
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTaskList, EdgeEverTaskItem.configure({ nested: true }), EdgeEverTextStyle],
      content: {
        type: "doc",
        content: [{
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: false, collapsed: false },
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                marks: [{ type: "textStyle", attrs: { backgroundColor: "#fef08a" } }],
                text: "Parent Task with Background",
              }],
            }],
          }],
        }],
      },
    });

    // 1st Enter: split creates clean empty task item without inherited background
    editor.commands.setTextSelection(30);
    const split = splitTaskItemWithoutInheritedMarks(editor.state, editor.view.dispatch);
    expect(split).toBe(true);
    expect(editor.getJSON().content[0].content).toHaveLength(2);
    expect(editor.state.storedMarks ?? []).toHaveLength(0);

    // 2nd Enter on the empty task item: consecutive enter must successfully merge into parent as child paragraph (sub-content)
    const handled2 = handleConsecutiveListEnter(editor.state, editor.view.dispatch);
    expect(handled2).toBe(true);

    const docAfter2ndEnter = editor.getJSON();
    expect(docAfter2ndEnter.content[0].content).toHaveLength(1);
    const parentTask = docAfter2ndEnter.content[0].content[0];
    expect(parentTask.content).toHaveLength(2);
    expect(parentTask.content[0].content[0].text).toBe("Parent Task with Background");
    expect(parentTask.content[1].type).toBe("paragraph");

    // 3rd Enter: exits sub-paragraph to a new root paragraph
    const handled3 = handleConsecutiveListEnter(editor.state, editor.view.dispatch);
    expect(handled3).toBe(true);
    const docAfter3rdEnter = editor.getJSON();
    expect(docAfter3rdEnter.content).toHaveLength(2);
    expect(docAfter3rdEnter.content[0].type).toBe("taskList");
    expect(docAfter3rdEnter.content[1].type).toBe("paragraph");

    editor.destroy();
  });
});

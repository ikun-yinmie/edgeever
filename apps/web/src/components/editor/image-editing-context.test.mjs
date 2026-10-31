import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { EditorState } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import { ImageGallery, IMAGE_GALLERY_NODE_TYPE } from "@edgeever/shared";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { isImageInGallery, isImageInTaskItem } from "./image-editing-context";

const schema = getSchema([StarterKit, Image, ImageGallery, TaskList, TaskItem]);
const image = () => schema.nodes.image.create({ src: "image.png" });
const gallery = (layout = "auto") => schema.nodes[IMAGE_GALLERY_NODE_TYPE].create({ layout }, [image(), image()]);

describe("image editing context", () => {
  test("only gallery children use gallery controls, including single-column layout", () => {
    for (const layout of ["auto", "1", "2", "3"]) {
      const doc = schema.nodes.doc.create(null, [gallery(layout), image()]);
      expect(isImageInGallery(doc, 1)).toBe(true);
      expect(isImageInGallery(doc, 2)).toBe(true);
      expect(isImageInGallery(doc, 4)).toBe(false);
    }
  });

  test("tracks grouping, undo, redo and ungrouping without relying on DOM nesting", () => {
    let state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, [image(), image()]),
      plugins: [history()],
    });
    const dispatch = (transaction) => { state = state.apply(transaction); };
    expect(isImageInGallery(state.doc, 0)).toBe(false);
    dispatch(state.tr.replaceWith(0, 2, gallery()));
    expect(isImageInGallery(state.doc, 1)).toBe(true);
    undo(state, dispatch);
    expect(isImageInGallery(state.doc, 0)).toBe(false);
    redo(state, dispatch);
    expect(isImageInGallery(state.doc, 1)).toBe(true);
    dispatch(state.tr.replaceWith(0, 4, state.doc.firstChild.content));
    expect(isImageInGallery(state.doc, 0)).toBe(false);
  });

  test("ignores detached image positions", () => {
    const doc = schema.nodes.doc.create(null, [image()]);
    for (const position of [undefined, -1, 20]) {
      expect(isImageInGallery(doc, position)).toBe(false);
    }
  });

  test("identifies images positioned inside a task item", () => {
    const taskItem = schema.nodes.taskItem.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("Task text")]),
      image(),
    ]);
    const taskList = schema.nodes.taskList.create(null, [taskItem]);
    const doc = schema.nodes.doc.create(null, [taskList, image()]);

    expect(isImageInTaskItem(doc, 13)).toBe(true);
    expect(isImageInTaskItem(doc, 16)).toBe(false);
  });
});

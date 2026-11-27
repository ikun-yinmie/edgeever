import type { Editor } from "@tiptap/react";
import type { TiptapDoc } from "@edgeever/shared";
import { collectMemoTasks, updateMemoTaskDocument, type MemoTaskMark } from "@/lib/memo-tasks";

const findTaskItemAtSelection = (editor: Editor) => {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "taskItem") return $from.before(depth);
  }
  return null;
};

/** Apply the same task rules as the overview, in one undoable transaction. */
export const setMemoTaskMark = (editor: Editor, position: number | null, mark: MemoTaskMark) => {
  const targetPosition = position ?? findTaskItemAtSelection(editor);
  if (targetPosition === null) return false;
  const doc = editor.state.doc.toJSON() as TiptapDoc;
  const tasks = collectMemoTasks(doc, "editor");
  const target = tasks.find(task => task.position === targetPosition);
  if (!target) return false;
  const updated = updateMemoTaskDocument(doc, target, mark);
  if (!updated) return false;

  const next = editor.schema.nodeFromJSON(updated);
  const transaction = editor.state.tr;
  next.descendants((node, nodePosition) => {
    if (node.type.name !== "taskItem") return;
    const previous = editor.state.doc.nodeAt(nodePosition)!;
    if (node.attrs.checked !== previous.attrs.checked
      || node.attrs.rejected !== previous.attrs.rejected
      || node.attrs.statusSource !== previous.attrs.statusSource) {
      transaction.setNodeMarkup(nodePosition, undefined, node.attrs);
    }
  });
  editor.view.dispatch(transaction);
  return true;
};

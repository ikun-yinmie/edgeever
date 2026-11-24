import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import {
  memoTaskAttributes,
  shouldCascadeMemoTaskMark,
  type MemoTaskMark,
} from "@/lib/memo-tasks";

const attributesFor = (node: ProseMirrorNode, mark: MemoTaskMark) => ({
  ...node.attrs,
  ...memoTaskAttributes(mark),
});

const applyMark = (
  transaction: Transaction,
  position: number,
  node: ProseMirrorNode,
  mark: MemoTaskMark,
) => {
  transaction.setNodeMarkup(position, undefined, attributesFor(node, mark));
  if (!shouldCascadeMemoTaskMark(mark)) return;
  // Task items are wrapped in taskList nodes, so descend through containers.
  const markChildren = (parent: ProseMirrorNode, parentPosition: number) => {
    parent.forEach((child, offset) => {
      if (child.type.name === "taskItem") {
        transaction.setNodeMarkup(parentPosition + 1 + offset, undefined, attributesFor(child, mark));
      }
      markChildren(child, parentPosition + 1 + offset);
    });
  };
  markChildren(node, position);
};

const findTaskItemAtSelection = (editor: Editor) => {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "taskItem") {
      return { position: $from.before(depth), node: $from.node(depth) };
    }
  }
  return null;
};

/**
 * Sets a task mark on one task item and, for reject/re-open, its whole subtree.
 * Used by the checkbox NodeView (explicit position) and the toolbar (selection).
 */
export const setMemoTaskMark = (editor: Editor, position: number | null, mark: MemoTaskMark) => {
  const target = position === null
    ? findTaskItemAtSelection(editor)
    : { position, node: editor.state.doc.nodeAt(position) };
  if (!target || !target.node || target.node.type.name !== "taskItem") return false;

  const transaction = editor.state.tr;
  applyMark(transaction, target.position, target.node, mark);
  editor.view.dispatch(transaction);
  return true;
};

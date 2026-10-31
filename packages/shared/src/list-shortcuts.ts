import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { wrapInList } from "@tiptap/pm/schema-list";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceAroundStep } from "@tiptap/pm/transform";

/**
 * Consecutive Enter behavior for list items (both taskItem and listItem):
 * 1. When on a newly created empty list item (itemIndex > 0, childCount === 1):
 *    Pressing Enter removes the item's marker and merges it into the previous
 *    item as a sub-content paragraph (making the previous item collapsible,
 *    ready for sub-items/images/sub-text).
 * 2. When on an empty sub-paragraph inside a list item (indexInItem > 0):
 *    Pressing Enter removes the empty sub-paragraph and exits the list to a
 *    new root paragraph.
 */
export const handleConsecutiveListEnter = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean => {
  const { selection } = state;
  if (
    !selection.empty
    || !selection.$from.parent.isTextblock
    || selection.$from.parent.content.size !== 0
    || selection.$from.parentOffset !== 0
  ) {
    return false;
  }

  let listItemDepth = -1;
  for (let depth = selection.$from.depth - 1; depth > 0; depth -= 1) {
    const nodeName = selection.$from.node(depth).type.name;
    if (nodeName === "listItem" || nodeName === "taskItem") {
      listItemDepth = depth;
      break;
    }
  }

  if (listItemDepth < 1) {
    return false;
  }

  const listDepth = listItemDepth - 1;
  const indexInItem = selection.$from.index(listItemDepth);
  const currentItem = selection.$from.node(listItemDepth);
  const list = selection.$from.node(listDepth);
  const itemIndex = selection.$from.index(listDepth);

  // Case 2: On an empty sub-paragraph inside an item that already has children:
  if (indexInItem > 0) {
    if (!dispatch) return true;
    const paraStart = selection.$from.before();
    const paraEnd = selection.$from.after();
    let tr = state.tr.delete(paraStart, paraEnd);
    const listEnd = tr.mapping.map(selection.$from.after(listDepth));
    const paragraphNode = state.schema.nodes.paragraph.create();
    tr = tr.insert(listEnd, paragraphNode);
    tr.setSelection(TextSelection.create(tr.doc, listEnd + 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  // Case 1: On an empty new item (itemIndex > 0, childCount === 1):
  if (itemIndex > 0 && currentItem.childCount === 1) {
    const previousItem = list.child(itemIndex - 1);
    if (previousItem.type !== currentItem.type) {
      return false;
    }
    if (!dispatch) return true;

    const currentItemStart = selection.$from.before(listItemDepth);
    const previousItemStart = currentItemStart - previousItem.nodeSize;
    const updatedAttrs = previousItem.attrs.collapsed
      ? { ...previousItem.attrs, collapsed: false }
      : previousItem.attrs;
    const mergedItem = previousItem.type.create(
      updatedAttrs,
      previousItem.content.append(currentItem.content),
    );
    const transaction = state.tr.replaceWith(
      previousItemStart,
      currentItemStart + currentItem.nodeSize,
      mergedItem,
    );
    const paragraphCursor = previousItemStart + previousItem.content.size + 2;
    transaction.setSelection(TextSelection.create(transaction.doc, paragraphCursor));
    dispatch(transaction.scrollIntoView());
    return true;
  }

  return false;
};

/**
 * Inserts a sub-paragraph inside the current list item (or task item),
 * making the item collapsible and allowing attachments/images/sub-text
 * without creating a new task item checkbox.
 * Bound to Shift+Enter.
 */
export const insertListItemChildParagraph = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean => {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock) {
    return false;
  }

  let listItemDepth = -1;
  for (let depth = selection.$from.depth - 1; depth > 0; depth -= 1) {
    const nodeName = selection.$from.node(depth).type.name;
    if (nodeName === "listItem" || nodeName === "taskItem") {
      listItemDepth = depth;
      break;
    }
  }

  if (listItemDepth < 1) {
    return false;
  }

  if (!dispatch) {
    return true;
  }

  const listItemNode = selection.$from.node(listItemDepth);
  const listItemPos = selection.$from.before(listItemDepth);
  let tr = state.tr;

  if (listItemNode.attrs.collapsed) {
    tr.setNodeMarkup(listItemPos, undefined, {
      ...listItemNode.attrs,
      collapsed: false,
    });
  }

  tr = tr.split(selection.from, 1);
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Sinks a taskItem or listItem while preserving list attributes (such as numbered: true).
 */
export const sinkListItemPreservingAttrs = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean => {
  let listItemDepth = -1;
  for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
    const name = state.selection.$from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") {
      listItemDepth = depth;
      break;
    }
  }
  if (listItemDepth < 1) return false;

  const itemType = state.selection.$from.node(listItemDepth).type;
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (node) => node.childCount > 0 && node.firstChild?.type === itemType);
  if (!range) return false;
  const startIndex = range.startIndex;
  if (startIndex === 0) return false;
  const parent = range.parent;
  const nodeBefore = parent.child(startIndex - 1);
  if (nodeBefore.type !== itemType) return false;

  if (dispatch) {
    const nestedBefore = Boolean(nodeBefore.lastChild && nodeBefore.lastChild.type === parent.type);
    const inner = Fragment.from(nestedBefore ? itemType.create() : null);
    const slice = new Slice(
      Fragment.from(itemType.create(null, Fragment.from(parent.type.create(parent.attrs, inner)))),
      nestedBefore ? 3 : 1,
      0,
    );
    const { start: before, end: after } = range;
    dispatch(
      state.tr
        .step(new ReplaceAroundStep(before - (nestedBefore ? 3 : 1), after, before, after, slice, 1, true))
        .scrollIntoView(),
    );
  }
  return true;
};

/**
 * Toggles the collapsed/expanded state of the current task item if it has sub-content.
 */
export const toggleTaskItemCollapseAtSelection = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean => {
  const { selection } = state;
  let taskItemPos = -1;
  let taskItemNode: ProseMirrorNode | null = null;

  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth);
    if (node.type.name === "taskItem") {
      taskItemPos = selection.$from.before(depth);
      taskItemNode = node;
      break;
    }
  }

  if (!taskItemNode || taskItemPos < 0) {
    return false;
  }

  if (taskItemNode.childCount <= 1) {
    return false;
  }

  if (!dispatch) {
    return true;
  }

  const collapsed = !(taskItemNode.attrs.collapsed === true);
  dispatch(
    state.tr.setNodeMarkup(taskItemPos, undefined, {
      ...taskItemNode.attrs,
      collapsed,
    }),
  );
  return true;
};

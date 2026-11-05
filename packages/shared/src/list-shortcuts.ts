import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { wrapInList } from "@tiptap/pm/schema-list";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceAroundStep, canSplit } from "@tiptap/pm/transform";

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
    || selection.$from.parent.type.spec.code
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
  if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.type.spec.code) {
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

/**
 * Splits the current taskItem into a new sibling taskItem while ensuring that:
 * 1. The new taskItem does NOT inherit inline marks (such as textStyle backgroundColor, color, fontSize, bold, italic).
 * 2. tr.setStoredMarks([]) is cleared so that any typing in the new task item begins clean without formatting.
 * 3. Attributes such as checked: false and collapsed: false are reset on the new taskItem.
 */
export const splitTaskItemWithoutInheritedMarks = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean => {
  const { selection } = state;
  if (selection.$from.parent.type.spec.code) return false;
  let taskItemDepth = -1;
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    if (selection.$from.node(depth).type.name === "taskItem") {
      taskItemDepth = depth;
      break;
    }
  }
  if (taskItemDepth < 1) return false;

  // If the cursor is inside an empty textblock, let consecutive list enter handle it
  if (
    selection.empty
    && selection.$from.parent.isTextblock
    && selection.$from.parent.content.size === 0
  ) {
    return false;
  }

  const taskItemType = selection.$from.node(taskItemDepth).type;
  const paragraphType = state.schema.nodes.paragraph;
  const typesAfter = [
    { type: taskItemType, attrs: { checked: false, collapsed: false } },
    { type: paragraphType, attrs: {} },
  ];

  if (!canSplit(state.tr.doc, selection.from, 2, typesAfter)) {
    return false;
  }

  if (!dispatch) return true;

  const tr = state.tr;
  if (!selection.empty) {
    tr.delete(selection.from, selection.to);
  }

  tr.split(tr.selection.from, 2, typesAfter);

  // Clear stored marks so newly typed characters in the new task item do not inherit previous marks (like background color)
  tr.setStoredMarks([]);

  // If text was split mid-string, clean any marks that were carried over to the new item
  const $newPos = tr.selection.$from;
  const newParent = $newPos.parent;
  if (newParent.isTextblock && newParent.content.size > 0 && state.schema.marks) {
    const parentStart = $newPos.start();
    const parentEnd = $newPos.end();
    for (const markType of Object.values(state.schema.marks)) {
      tr.removeMark(parentStart, parentEnd, markType);
    }
  }

  dispatch(tr.scrollIntoView());
  return true;
};

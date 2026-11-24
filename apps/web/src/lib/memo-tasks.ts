import type { TiptapDoc, TiptapNode, TiptapTextNode } from "@edgeever/shared";

export type MemoTaskStatus = "pending" | "doing" | "done" | "rejected";
export type MemoTaskMark = Exclude<MemoTaskStatus, "doing">;
export type MemoTask = {
  id: string;
  memoId: string;
  path: number[];
  position: number;
  text: string;
  heading: string;
  parentId: string | null;
  checked: boolean;
  rejected: boolean;
  status: MemoTaskStatus;
};

const textOf = (node: TiptapNode | TiptapTextNode): string =>
  node.type === "text" ? (node as TiptapTextNode).text
    : ((node as TiptapNode).content ?? []).map(textOf).join(node.type === "hardBreak" ? "\n" : "");

const nodeSize = (node: TiptapNode | TiptapTextNode): number => {
  if (node.type === "text") return (node as TiptapTextNode).text.length;
  const content = (node as TiptapNode).content;
  return content ? 2 + content.reduce((size, child) => size + nodeSize(child), 0)
    : ["paragraph", "heading", "codeBlock"].includes(node.type) ? 2 : 1;
};

export const collectMemoTasks = (doc: TiptapDoc, memoId: string): MemoTask[] => {
  const tasks: MemoTask[] = [];
  let heading = "";
  const walk = (nodes: TiptapDoc["content"], path: number[], position: number, parentId: string | null) => {
    let offset = position;
    nodes.forEach((node, index) => {
      const currentPath = [...path, index];
      let nextParent = parentId;
      if (node.type === "heading") heading = textOf(node);
      if (node.type === "taskItem") {
        const checked = node.attrs?.checked === true;
        const rejected = !checked && node.attrs?.rejected === true;
        const id = `${memoId}:${currentPath.join(".")}`;
        tasks.push({
          id, memoId, path: currentPath, position: offset,
          text: node.content?.[0] ? textOf(node.content[0]) : "",
          heading, parentId, checked, rejected,
          status: checked ? "done" : rejected ? "rejected" : "pending",
        });
        nextParent = id;
      }
      if (node.content) walk(node.content as TiptapNode[], currentPath, offset + 1, nextParent);
      offset += nodeSize(node);
    });
  };
  walk(doc.content, [], 0, null);
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    if (!task.checked && !task.rejected) continue;
    let parentId = task.parentId;
    while (parentId) {
      const parent = byId.get(parentId)!;
      if (parent.status === "pending") parent.status = "doing";
      parentId = parent.parentId;
    }
  }
  return tasks;
};

export const findMemoTaskNode = (doc: TiptapDoc, path: number[]): TiptapNode | null => {
  let nodes: Array<TiptapNode | TiptapTextNode> = doc.content;
  let node: TiptapNode | undefined;
  for (const index of path) {
    node = nodes[index] as TiptapNode | undefined;
    if (!node) return null;
    nodes = node.content ?? [];
  }
  return node?.type === "taskItem" ? node : null;
};

/** Cycle only explicit marks; a parent's derived "doing" state is not a fourth mark. */
export const nextMemoTaskMark = (attrs: { checked?: unknown; rejected?: unknown }): MemoTaskMark =>
  attrs.rejected === true ? "pending" : attrs.checked === true ? "rejected" : "done";

export const memoTaskAttributes = (mark: MemoTaskMark) => ({
  checked: mark === "done",
  rejected: mark === "rejected",
});

/**
 * A rejected parent cancels its whole subtree, and re-opening it clears the
 * cascade again. "Done" keeps descendant marks untouched (a parent can be
 * finished while children stay pending).
 */
export const shouldCascadeMemoTaskMark = (mark: MemoTaskMark) => mark !== "done";

const markTaskItemsDeep = (node: TiptapNode, mark: MemoTaskMark) => {
  for (const child of node.content ?? []) {
    if (child.type === "taskItem") {
      child.attrs = { ...child.attrs, ...memoTaskAttributes(mark) };
    }
    // Task items sit inside taskList wrappers, so keep walking containers.
    markTaskItemsDeep(child, mark);
  }
};

export const applyMemoTaskMarkToNode = (node: TiptapNode, mark: MemoTaskMark, cascade = shouldCascadeMemoTaskMark(mark)) => {
  node.attrs = { ...node.attrs, ...memoTaskAttributes(mark) };
  if (cascade) markTaskItemsDeep(node, mark);
};

export const updateMemoTaskDocument = (doc: TiptapDoc, task: MemoTask, mark: MemoTaskMark): TiptapDoc | null => {
  const node = findMemoTaskNode(doc, task.path);
  if (!node || textOf(node.content?.[0] ?? { type: "paragraph" }) !== task.text) return null;
  const updated = structuredClone(doc);
  const target = findMemoTaskNode(updated, task.path)!;
  applyMemoTaskMarkToNode(target, mark);
  return updated;
};

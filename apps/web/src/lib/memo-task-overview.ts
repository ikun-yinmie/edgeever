import { getNotebookDescendantIds, type Notebook } from "@edgeever/shared";
import { resolveMemoTaskTreeRows } from "./memo-task-tree";
import type { MemoTask, MemoTaskStatus } from "./memo-tasks";
import { buildNotebookTree, type NotebookNode } from "./utils";

export type MemoTaskNotebookOption = { id: string; name: string; path: string; depth: number };
export type MemoTaskSource = { id: string; title: string; notebookId: string };
export type MemoTaskOverviewFilter = { notebookId: string; status: MemoTaskStatus | "all"; query: string };
export type MemoTaskOverviewMemo = { memoId: string; title: string; notebookPath: string; roots: MemoTask[]; matchingCount: number };
export type MemoTaskOverviewGroup = { notebookId: string; name: string; path: string; memos: MemoTaskOverviewMemo[]; matchingCount: number };

export const getMemoTaskNotebookOptions = (notebooks: Notebook[]): MemoTaskNotebookOption[] => {
  const options: MemoTaskNotebookOption[] = [];
  const walk = (nodes: NotebookNode[], ancestors: string[]) => {
    for (const node of nodes) {
      const names = [...ancestors, node.name];
      options.push({ id: node.id, name: node.name, path: names.join(" / "), depth: ancestors.length });
      walk(node.children, names);
    }
  };
  walk(buildNotebookTree(notebooks), []);
  return options;
};

export const taskOverviewFoldKey = (kind: "notebook" | "memo" | "task", id: string) => `${kind}:${id}`;

/** One outline drives cards, matched counts, selection and preview. Context never contributes to counts. */
export const resolveMemoTaskOverview = ({ tasks, sources, notebooks, notebookOptions, filter, unfiledLabel }: {
  tasks: MemoTask[];
  sources: MemoTaskSource[];
  notebooks: Notebook[];
  notebookOptions: MemoTaskNotebookOption[];
  filter: MemoTaskOverviewFilter;
  unfiledLabel: string;
}) => {
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const optionById = new Map(notebookOptions.map(option => [option.id, option]));
  const notebookIds = filter.notebookId ? new Set(getNotebookDescendantIds(notebooks, filter.notebookId)) : null;
  const scopedTasks = tasks.filter(task => {
    const source = sourceById.get(task.memoId);
    return source && (!notebookIds || notebookIds.has(source.notebookId));
  });
  const byId = new Map(scopedTasks.map(task => [task.id, task]));
  const children = new Map<string, MemoTask[]>();
  for (const task of scopedTasks) {
    if (!task.parentId) continue;
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }
  const query = filter.query.trim().toLocaleLowerCase();
  const searched = scopedTasks.filter(task => {
    if (!query) return true;
    const source = sourceById.get(task.memoId)!;
    const text = [task.text, task.heading, source.title, optionById.get(source.notebookId)?.path];
    for (let parent = task.parentId ? byId.get(task.parentId) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) text.push(parent.text);
    return text.join(" ").toLocaleLowerCase().includes(query);
  });
  const statusCounts: Record<MemoTaskStatus | "all", number> = { all: searched.length, pending: 0, doing: 0, done: 0, rejected: 0 };
  for (const task of searched) statusCounts[task.status] += 1;
  const matching = searched.filter(task => filter.status === "all" || task.status === filter.status);
  // Resolve even the unfiltered overview as one tree, rather than duplicating branches across statuses.
  const { roots, matchingIds, visibleIds } = resolveMemoTaskTreeRows({ tasks: scopedTasks, matching, filtered: true });
  const groupsById = new Map<string, MemoTaskOverviewGroup>();
  const memoGroups = new Map<string, MemoTaskOverviewMemo>();
  for (const root of roots) {
    const source = sourceById.get(root.memoId)!;
    const notebook = optionById.get(source.notebookId);
    let group = groupsById.get(source.notebookId);
    if (!group) {
      group = { notebookId: source.notebookId, name: notebook?.name ?? unfiledLabel, path: notebook?.path ?? unfiledLabel, memos: [], matchingCount: 0 };
      groupsById.set(source.notebookId, group);
    }
    let memo = memoGroups.get(source.id);
    if (!memo) {
      memo = { memoId: source.id, title: source.title, notebookPath: group.path, roots: [], matchingCount: 0 };
      memoGroups.set(source.id, memo);
      group.memos.push(memo);
    }
    memo.roots.push(root);
  }
  for (const task of matching) {
    const source = sourceById.get(task.memoId)!;
    memoGroups.get(task.memoId)!.matchingCount += 1;
    groupsById.get(source.notebookId)!.matchingCount += 1;
  }
  const notebookOrder = new Map(notebookOptions.map((option, index) => [option.id, index]));
  const groups = [...groupsById.values()].sort((a, b) => (notebookOrder.get(a.notebookId) ?? Infinity) - (notebookOrder.get(b.notebookId) ?? Infinity));
  return { groups, roots, matching, matchingIds, visibleIds: visibleIds!, byId, children, statusCounts, memoCount: memoGroups.size };
};

export type MemoTaskOverview = ReturnType<typeof resolveMemoTaskOverview>;

/** Actual rendered rows, including context, after notebook, memo and task folds. */
export const getVisibleOverviewTasks = (overview: MemoTaskOverview, collapsed: ReadonlySet<string>): MemoTask[] => {
  const result: MemoTask[] = [];
  const walk = (tasks: MemoTask[]) => {
    for (const task of tasks) {
      if (!overview.visibleIds.has(task.id)) continue;
      result.push(task);
      if (!collapsed.has(taskOverviewFoldKey("task", task.id))) walk(overview.children.get(task.id) ?? []);
    }
  };
  for (const group of overview.groups) {
    if (collapsed.has(taskOverviewFoldKey("notebook", group.notebookId))) continue;
    for (const memo of group.memos) {
      if (!collapsed.has(taskOverviewFoldKey("memo", memo.memoId))) walk(memo.roots);
    }
  }
  return result;
};

export const resolveOverviewSelection = (visibleTasks: MemoTask[], selectedId: string | null, matchingIds: ReadonlySet<string>): MemoTask | undefined =>
  visibleTasks.find(task => task.id === selectedId) ?? visibleTasks.find(task => matchingIds.has(task.id)) ?? visibleTasks[0];

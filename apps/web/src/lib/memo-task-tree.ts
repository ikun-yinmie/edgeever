import type { MemoTask } from "./memo-tasks";

export type MemoTaskTreeRows = {
  /** Null when the whole list is shown (grouped "all" view). */
  visibleIds: Set<string> | null;
  roots: MemoTask[];
  matchingIds: Set<string>;
};

const walkAncestors = (task: MemoTask, byId: ReadonlyMap<string, MemoTask>, visit: (parent: MemoTask) => void) => {
  let parent = task.parentId ? byId.get(task.parentId) : null;
  while (parent) {
    visit(parent);
    parent = parent.parentId ? byId.get(parent.parentId) : null;
  }
};

/**
 * Visible rows for the task overview.
 *
 * A filtered or searched list must not flatten: every matching task keeps its
 * ancestor chain as context, and the whole subtree below a match stays visible
 * so branch progress is readable. Only rows without a visible ancestor become
 * roots, so each task renders exactly once inside its outline.
 */
export const resolveMemoTaskTreeRows = ({
  tasks,
  matching,
  filtered,
}: {
  tasks: MemoTask[];
  matching: MemoTask[];
  filtered: boolean;
}): MemoTaskTreeRows => {
  const matchingIds = new Set(matching.map(task => task.id));
  if (!filtered) {
    return { visibleIds: null, roots: [], matchingIds };
  }

  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string, MemoTask[]>();
  for (const task of tasks) {
    if (task.parentId) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  const visibleIds = new Set<string>();
  const addDescendants = (task: MemoTask) => {
    for (const child of children.get(task.id) ?? []) {
      if (visibleIds.has(child.id)) continue;
      visibleIds.add(child.id);
      addDescendants(child);
    }
  };

  for (const task of matching) {
    visibleIds.add(task.id);
    walkAncestors(task, byId, (parent) => visibleIds.add(parent.id));
    addDescendants(task);
  }

  return {
    visibleIds,
    roots: tasks.filter(task => visibleIds.has(task.id) && (!task.parentId || !visibleIds.has(task.parentId))),
    matchingIds,
  };
};

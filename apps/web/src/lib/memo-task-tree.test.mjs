import { describe, expect, test } from "bun:test";
import { collectMemoTasks } from "./memo-tasks";
import { resolveMemoTaskTreeRows } from "./memo-task-tree";
import { markdownToDoc } from "@edgeever/shared";

const tasksFor = (source) => collectMemoTasks(markdownToDoc(source), "memo");

describe("task overview tree rows", () => {
  test("a status filter keeps matching descendants under their ancestors", () => {
    const tasks = tasksFor("- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild\n- [ ] Sibling");
    // Pretend the grandchild is the only match of a filter.
    const matching = [tasks[2]];
    const { visibleIds, roots, matchingIds } = resolveMemoTaskTreeRows({ tasks, matching, filtered: true });

    expect([...visibleIds].sort()).toEqual([tasks[0].id, tasks[1].id, tasks[2].id].sort());
    expect(roots.map(task => task.id)).toEqual([tasks[0].id]);
    expect(matchingIds.has(tasks[2].id)).toBe(true);
    expect(matchingIds.has(tasks[0].id)).toBe(false);
    // Each task appears exactly once: no roots for tasks with a visible parent.
    expect(roots.map(task => task.id)).not.toContain(tasks[1].id);
  });

  test("multiple matches in one branch share one root and siblings stay out", () => {
    const tasks = tasksFor("- [ ] Parent\n  - [ ] First\n  - [ ] Second\n- [ ] Other");
    const { roots, visibleIds } = resolveMemoTaskTreeRows({ tasks, matching: [tasks[1], tasks[2]], filtered: true });
    expect(roots.map(task => task.id)).toEqual([tasks[0].id]);
    expect(visibleIds?.has(tasks[3].id)).toBe(false);
  });

  test("a matching parent keeps its whole subtree visible", () => {
    const tasks = tasksFor("- [ ] Parent\n  - [x] Done child\n    - [ ] Grandchild\n- [ ] Sibling");
    const { visibleIds, roots } = resolveMemoTaskTreeRows({ tasks, matching: [tasks[0]], filtered: true });
    expect([...visibleIds].sort()).toEqual(tasks.slice(0, 3).map(task => task.id).sort());
    expect(roots.map(task => task.id)).toEqual([tasks[0].id]);
    expect(visibleIds.has(tasks[3].id)).toBe(false);
  });

  test("the grouped all view keeps every task visible", () => {
    const tasks = tasksFor("- [ ] Parent\n  - [ ] Child");
    const { visibleIds, roots, matchingIds } = resolveMemoTaskTreeRows({ tasks, matching: tasks, filtered: false });
    expect(visibleIds).toBeNull();
    expect(roots).toEqual([]);
    expect([...matchingIds]).toEqual(tasks.map(task => task.id));
  });
});

import { describe, expect, test } from "bun:test";
import { markdownToDoc } from "@edgeever/shared";
import { collectMemoTasks } from "./memo-tasks";
import { getMemoTaskNotebookOptions, getVisibleOverviewTasks, resolveMemoTaskOverview, resolveOverviewSelection, taskOverviewFoldKey } from "./memo-task-overview";

const notebook = (id, name, parentId = null, sortOrder = 0) => ({ id, name, parentId, sortOrder, memoCount: 0 });
const notebooks = [notebook("work", "Work"), notebook("child", "Ideas", "work"), notebook("deep", "Deep", "child"), notebook("home", "Home", null, 1), notebook("other", "Ideas", "home")];
const source = (id, notebookId, title = id) => ({ id, notebookId, title });
const tasksFor = (id, markdown) => collectMemoTasks(markdownToDoc(markdown), id);
const resolve = (tasks, sources, filter = {}) => resolveMemoTaskOverview({ tasks, sources, notebooks, notebookOptions: getMemoTaskNotebookOptions(notebooks), filter: { notebookId: "", status: "all", query: "", ...filter }, unfiledLabel: "Unavailable" });

// Exercise the same model used by list rows, counts, selection and source preview.
describe("global task overview", () => {
  test("category options use tree order, depth and disambiguated full paths without mutating notebooks", () => {
    const before = structuredClone(notebooks);
    expect(getMemoTaskNotebookOptions(notebooks).map(({ id, path, depth }) => [id, path, depth])).toEqual([
      ["work", "Work", 0], ["child", "Work / Ideas", 1], ["deep", "Work / Ideas / Deep", 2], ["home", "Home", 0], ["other", "Home / Ideas", 1],
    ]);
    expect(notebooks).toEqual(before);
  });

  test("a parent category includes itself and every descendant, never same-name notebooks elsewhere", () => {
    const sources = [source("a", "work"), source("b", "child"), source("c", "deep"), source("d", "other")];
    const tasks = sources.flatMap(memo => tasksFor(memo.id, "- [ ] Task"));
    const result = resolve(tasks, sources, { notebookId: "work" });
    expect(result.matching.map(task => task.memoId)).toEqual(["a", "b", "c"]);
    expect(result.groups.map(group => group.notebookId)).toEqual(["work", "child", "deep"]);
  });

  test("default grouping keeps mixed-status task branches once under each source memo", () => {
    const tasks = [...tasksFor("a", "- [ ] Parent\n  - [x] Done\n  - [ ] Child\n- [ ] Other"), ...tasksFor("b", "- [ ] Second note")];
    const result = resolve(tasks, [source("a", "child"), source("b", "child")]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].memos.map(memo => memo.memoId)).toEqual(["a", "b"]);
    expect(result.groups[0].memos[0].roots.map(task => task.text)).toEqual(["Parent", "Other"]);
    const visible = getVisibleOverviewTasks(result, new Set());
    expect(visible.map(task => task.id)).toEqual(tasks.map(task => task.id));
    expect(new Set(visible.map(task => task.id)).size).toBe(tasks.length);
    expect(result.groups[0].matchingCount).toBe(tasks.length);
  });

  test("category, status and search compose while ancestor context is excluded from all match counts", () => {
    const tasks = [...tasksFor("a", "- [ ] Tree parent\n  - [x] Finished needle\n  - [ ] Hidden sibling"), ...tasksFor("b", "- [x] Finished needle elsewhere")];
    const result = resolve(tasks, [source("a", "child"), source("b", "other")], { notebookId: "work", status: "done", query: "NEEDLE" });
    expect(result.matching.map(task => task.text)).toEqual(["Finished needle"]);
    expect(getVisibleOverviewTasks(result, new Set()).map(task => task.text)).toEqual(["Tree parent", "Finished needle"]);
    expect(result.matchingIds.has(tasks[0].id)).toBe(false);
    expect(result.groups[0].matchingCount).toBe(1);
    expect(result.groups[0].memos[0].matchingCount).toBe(1);
    expect(result.statusCounts).toEqual({ all: 1, pending: 0, doing: 0, done: 1, rejected: 0 });
  });

  test("matching a parent retains descendants as context without counting or duplicating them", () => {
    const tasks = tasksFor("a", "- [ ] Needle parent\n  - [x] Child\n    - [ ] Grandchild\n- [x] Other");
    const result = resolve(tasks, [source("a", "work")], { status: "doing", query: "Needle" });
    expect(result.matching).toHaveLength(1);
    expect(result.groups[0].memos[0].roots).toHaveLength(1);
    expect(getVisibleOverviewTasks(result, new Set()).map(task => task.text)).toEqual(["Needle parent", "Child", "Grandchild"]);
    expect(result.groups[0].matchingCount).toBe(1);
  });

  test("search covers notebook paths, memo titles, headings and task ancestors", () => {
    const tasks = tasksFor("a", "## Milestone\n- [ ] Parent\n  - [ ] Child");
    const sources = [source("a", "deep", "Release notes")];
    for (const query of ["Work / Ideas", "release", "milestone", "parent"]) {
      expect(resolve(tasks, sources, { query }).matching.map(task => task.text)).toEqual(["Parent", "Child"]);
    }
  });

  test("preview selection follows filtered and actually unfolded rows", () => {
    const tasks = tasksFor("a", "- [ ] Parent\n  - [x] Needle\n  - [ ] Sibling");
    const result = resolve(tasks, [source("a", "child")], { status: "done", query: "needle" });
    const open = getVisibleOverviewTasks(result, new Set());
    expect(resolveOverviewSelection(open, tasks[2].id, result.matchingIds)?.id).toBe(tasks[1].id);
    expect(resolveOverviewSelection(open, tasks[0].id, result.matchingIds)?.id).toBe(tasks[0].id);
    const foldedTask = getVisibleOverviewTasks(result, new Set([taskOverviewFoldKey("task", tasks[0].id)]));
    expect(foldedTask).toEqual([tasks[0]]);
    expect(resolveOverviewSelection(foldedTask, tasks[1].id, result.matchingIds)?.id).toBe(tasks[0].id);
    for (const key of [taskOverviewFoldKey("memo", "a"), taskOverviewFoldKey("notebook", "child")]) {
      const folded = getVisibleOverviewTasks(result, new Set([key]));
      expect(folded).toEqual([]);
      expect(resolveOverviewSelection(folded, tasks[1].id, result.matchingIds)).toBeUndefined();
    }
  });

  test("no results clears preview selection; reset restores all categories and statuses", () => {
    const tasks = [...tasksFor("a", "- [ ] Work"), ...tasksFor("b", "- [x] Home")];
    const sources = [source("a", "work"), source("b", "home")];
    const empty = resolve(tasks, sources, { notebookId: "work", status: "done", query: "missing" });
    expect(empty.matching).toEqual([]);
    expect(empty.groups).toEqual([]);
    expect(resolveOverviewSelection(getVisibleOverviewTasks(empty, new Set()), tasks[0].id, empty.matchingIds)).toBeUndefined();
    const reset = resolve(tasks, sources);
    expect(reset.matching).toHaveLength(2);
    expect(reset.groups).toHaveLength(2);
  });
});

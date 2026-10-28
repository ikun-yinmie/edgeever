import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const toolbarSource = readFileSync(new URL("./EditorToolbar.tsx", import.meta.url), "utf8");
const slashMenuSource = readFileSync(new URL("./editor/SlashCommandMenu.tsx", import.meta.url), "utf8");
const sharedExtensionsSource = readFileSync(
  new URL("../../../../packages/shared/src/document-extensions.ts", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

describe("numbered task lists", () => {
  test("stores an optional numbered flag on the existing task list node", () => {
    expect(sharedExtensionsSource).toContain("numbered: {");
    expect(sharedExtensionsSource).toContain('"data-task-numbered": "true"');
  });

  test("renders CSS counters only for numbered task lists", () => {
    expect(css).toContain('ul[data-type="taskList"][data-task-numbered="true"]');
    expect(css).toContain("counter-increment: edgeever-task-number;");
    expect(css).toContain('content: counter(edgeever-task-number) ".";');
  });

  test("exposes a numbered task list action in the toolbar and slash menu", () => {
    expect(toolbarSource).toContain("toggleNumberedTaskList");
    expect(toolbarSource).toContain('t("editorToolbar.numberedTaskList")');
    expect(toolbarSource).toContain("ListChecks");
    expect(slashMenuSource).toContain('id: "numbered-task-list"');
    expect(slashMenuSource).toContain('updateAttributes("taskList", { numbered: true })');
  });
});

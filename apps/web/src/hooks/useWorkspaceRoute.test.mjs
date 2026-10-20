import { describe, expect, test } from "bun:test";
import { buildOpenMemoWindowUrl, resolveWorkspaceRoute } from "./useWorkspaceRoute.ts";

describe("workspace route resolution", () => {
  test("recognizes the workspace destinations", () => {
    expect(resolveWorkspaceRoute("/", "")).toMatchObject({
      isTrash: false,
      isSettings: false,
      isPlugins: false,
      isTemplates: false,
      isAiPrompts: false,
      isExecutionCenter: false,
    });
    expect(resolveWorkspaceRoute("/", "?view=trash").isTrash).toBe(true);
    expect(resolveWorkspaceRoute("/settings", "").isSettings).toBe(true);
    expect(resolveWorkspaceRoute("/plugins", "").isPlugins).toBe(true);
    expect(resolveWorkspaceRoute("/plugins/org.edgeever.example", "").isPlugins).toBe(true);
    expect(resolveWorkspaceRoute("/templates", "").isTemplates).toBe(true);
    expect(resolveWorkspaceRoute("/ai-prompts", "").isAiPrompts).toBe(true);
    expect(resolveWorkspaceRoute("/execution-center", "").isExecutionCenter).toBe(true);
  });

  test("only treats the canonical trash query as trash", () => {
    expect(resolveWorkspaceRoute("/", "?view=trash&extra=1").isTrash).toBe(false);
    expect(resolveWorkspaceRoute("/other", "?view=trash").isTrash).toBe(false);
  });

  test("extracts a standalone mobile editor return id", () => {
    expect(resolveWorkspaceRoute("/", "?mobileEditorReturn=memo-42").mobileEditorReturnMemoId).toBe("memo-42");
  });

  test("extracts a note that a new window should open", () => {
    expect(resolveWorkspaceRoute("/", "?openMemo=memo-42").openMemoId).toBe("memo-42");
    expect(resolveWorkspaceRoute("/", "").openMemoId).toBeNull();
  });
});

describe("new window deep links", () => {
  test("adds the openMemo query for browser-routed windows", () => {
    expect(buildOpenMemoWindowUrl("https://app.example/settings?tab=x#frag", "memo-1"))
      .toBe("https://app.example/settings?openMemo=memo-1");
  });

  test("nests the openMemo query inside the hash for desktop hash routing", () => {
    expect(buildOpenMemoWindowUrl("edgeever-app://app/index.html#/settings", "memo-1", { hashRouter: true }))
      .toBe("edgeever-app://app/index.html#/settings?openMemo=memo-1");
    expect(buildOpenMemoWindowUrl("edgeever-app://app/index.html", "memo-1", { hashRouter: true }))
      .toBe("edgeever-app://app/index.html#/?openMemo=memo-1");
    expect(buildOpenMemoWindowUrl("edgeever-app://app/index.html#/?view=trash", "memo-1", { hashRouter: true }))
      .toBe("edgeever-app://app/index.html#/?view=trash&openMemo=memo-1");
  });
});

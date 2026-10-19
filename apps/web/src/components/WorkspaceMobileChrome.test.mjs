import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chromeSource = readFileSync(new URL("./WorkspaceMobileChrome.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

describe("mobile notebook picker create-notebook entry", () => {
  test("declares an optional onCreateNotebook callback for the picker", () => {
    expect(chromeSource).toContain("onCreateNotebook?: (parentId?: string | null) => void;");
    expect(chromeSource).toContain("onCreateNotebook,");
  });

  test("renders a create-notebook row that closes the drawer before creating", () => {
    expect(chromeSource).toContain('t("mobileNotebookPicker.createNotebook")');
    expect(chromeSource).toContain("<Plus className=\"h-4 w-4 shrink-0 text-slate-500\" />");
    expect(chromeSource).toContain("onClose();");
    expect(chromeSource).toContain("onCreateNotebook(null);");
  });

  test("workspace wires the picker to the shared notebook-name dialog", () => {
    expect(workspaceSource).toContain("onCreateNotebook={(parentId) => {");
    expect(workspaceSource).toContain("setMobileNotebookPickerOpen(false);");
    expect(workspaceSource).toContain("handleCreateNotebook(parentId);");
  });
});

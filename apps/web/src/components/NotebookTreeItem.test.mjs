import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./NotebookTreeItem.tsx", import.meta.url), "utf8");

describe("NotebookTreeItem create-note context action", () => {
  test("offers creating a note with a right-expanding type submenu", () => {
    const menu = source.split("<ContextMenuContent")[1]?.split("</ContextMenuContent>")[0] ?? "";

    expect(menu).toContain("<ContextMenuSub>");
    expect(menu).toContain("<ContextMenuSubTrigger");
    expect(menu).toContain("<ContextMenuSubContent");
    expect(menu).toContain('t("notebookPane.newMemo")');
    expect(menu).toContain('t("diagram.normalNote")');
    expect(menu).toContain('t("diagram.mindMap")');
    expect(menu).toContain('t("diagram.flowchart")');
    expect(menu).toContain('t("diagram.architecture")');
    expect(menu).toContain("onCreateMemo(node.id)");
    expect(menu).toContain('onCreateMemo(node.id, "mind-map")');
    expect(menu).toContain('onCreateMemo(node.id, "flowchart")');
    expect(menu).toContain('onCreateMemo(node.id, "architecture")');
  });

  test("clicking the row itself creates the default note", () => {
    const trigger = source.split("<ContextMenuSubTrigger")[1]?.split("</ContextMenuSubTrigger>")[0] ?? "";

    expect(trigger).toContain("event.preventDefault()");
    expect(trigger).toContain("setContextMenuOpen(false)");
    expect(trigger).toContain("onCreateMemo(node.id)");
  });

  test("runs as a controlled menu so it closes right after creating", () => {
    expect(source).toContain("<ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>");
  });

  test("only shows the create-note action when a notebook-scoped callback is wired", () => {
    expect(source).toContain("{onCreateMemo ? (");
    expect(source).toContain("onCreateMemo?: (notebookId: string, kind?: DiagramKind) => void;");
  });

  test("forwards the create-note callback down the notebook tree", () => {
    const child = source.split("<NotebookTreeItem")[1] ?? "";
    expect(child).toContain("onCreateMemo={onCreateMemo}");
  });
});

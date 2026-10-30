import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { notebookIdMappingsFromEvent, remapNotebookId } from "../lib/notebook-id-remap.ts";

const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
const queuedSyncSource = readFileSync(new URL("../hooks/useWorkspaceQueuedSync.ts", import.meta.url), "utf8");
const desktopSyncSource = readFileSync(new URL("../lib/desktop-sync.ts", import.meta.url), "utf8");
const syncEventsSource = readFileSync(new URL("../lib/sync-events.ts", import.meta.url), "utf8");

describe("notebook id remapping", () => {
  test("follows a temporary notebook id to the server id and leaves others alone", () => {
    const mappings = new Map([["local_abc", "nb_server_1"]]);
    expect(remapNotebookId("local_abc", mappings)).toBe("nb_server_1");
    expect(remapNotebookId("nb_other", mappings)).toBe("nb_other");
    expect(remapNotebookId(null, mappings)).toBeNull();
    expect(remapNotebookId("local_abc", new Map())).toBe("local_abc");
  });

  test("only accepts a non-empty map event payload", () => {
    const valid = new CustomEvent("x", { detail: new Map([["local_a", "nb_a"]]) });
    expect(notebookIdMappingsFromEvent(valid)?.get("local_a")).toBe("nb_a");
    expect(notebookIdMappingsFromEvent(new CustomEvent("x", { detail: new Map() }))).toBeNull();
    expect(notebookIdMappingsFromEvent(new CustomEvent("x", { detail: { local_a: "nb_a" } }))).toBeNull();
  });
});

describe("create-notebook flow", () => {
  test("lands on the new category so the next note is created inside it", () => {
    const createNotebook = workspaceSource.slice(
      workspaceSource.indexOf("const createNotebookMutation = useMutation({"),
      workspaceSource.indexOf("const updateNotebookMutation = useMutation({"),
    );
    expect(createNotebook).toContain("setSelectedNotebookId(data.notebook.id)");
    expect(createNotebook).toContain("setMemoView(\"notebook\")");
    expect(createNotebook).toContain("navigateWorkspaceHome()");
    expect(createNotebook).toContain("setSelectedTag(null)");
    expect(createNotebook).toContain("setMemberNotesView(null)");
    expect(createNotebook).toContain("setNotebookRevealRequest({ notebookId: data.notebook.id, token: notebookRevealTokenRef.current })");
    expect(createNotebook).toContain("setMobileBottomNavActive(\"home\")");
    expect(createNotebook).toContain("setMobileNotebookPickerOpen(false)");
    expect(createNotebook).toContain("setActivePane(\"memos\")");
  });

  test("follows the temporary notebook id when sync replaces it", () => {
    expect(syncEventsSource).toContain("NOTEBOOK_ID_REMAPPED_EVENT");
    expect(syncEventsSource).toContain("notifyNotebookIdRemapped");
    expect(queuedSyncSource).toContain("notifyNotebookIdRemapped(new Map([[temporaryId, (result as Notebook).id]]))");
    expect(desktopSyncSource).toContain("return data.notebook;");
    expect(desktopSyncSource).toContain('item.kind === "notebook.create" && result');
    expect(desktopSyncSource).toContain("notifyNotebookIdRemapped(new Map([[item.entityId, result.id]]))");
    expect(workspaceSource).toContain("window.addEventListener(NOTEBOOK_ID_REMAPPED_EVENT, handleNotebookIdRemapped)");
    expect(workspaceSource).toContain("setSelectedNotebookId((current) => remapNotebookId(current, mappings))");
    expect(workspaceSource).toContain("setSelectionMoveTargetNotebookId((current) => remapNotebookId(current, mappings))");
    expect(workspaceSource).toContain("setNotebookRevealRequest((current) => (current");
  });
});

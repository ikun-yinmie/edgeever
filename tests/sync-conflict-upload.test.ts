import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enUS } from "../packages/shared/src/i18n/en-US";
import { ja } from "../packages/shared/src/i18n/ja";
import { zhCN } from "../packages/shared/src/i18n/zh-CN";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const webQueueSource = readSource("../apps/web/src/lib/sync-queue.ts");
const desktopSyncSource = readSource("../apps/web/src/lib/desktop-sync.ts");
const queuedSyncHookSource = readSource("../apps/web/src/hooks/useWorkspaceQueuedSync.ts");
const notebookPaneSource = readSource("../apps/web/src/components/NotebookPane.tsx");
const syncIssuesDialogSource = readSource("../apps/web/src/components/DesktopSyncIssuesDialog.tsx");
const recoveryBannerSource = readSource("../apps/web/src/components/editor/EditorSaveRecoveryBanner.tsx");
const saveConflictActionsSource = readSource("../apps/web/src/components/editor/useEditorSaveConflictActions.ts");
const editorPaneSource = readSource("../apps/web/src/components/EditorPane.tsx");

describe("sync conflicts can upload the local version", () => {
  test("the web queue force-pushes the local draft instead of only adopting the cloud", () => {
    expect(webQueueSource).toContain("export const forceUploadWebConflicts");
    expect(webQueueSource).toContain("allowDestructiveOverwrite: true");
    // A newer autosave that landed during the overwrite is rebased, not dropped.
    expect(webQueueSource).toContain("expectedRevision: data.memo.revision");
    expect(queuedSyncHookSource).toContain("uploadLocalConflictsNow");
    expect(queuedSyncHookSource).toContain("forceUploadWebConflicts(localDataScope)");
  });

  test("the desktop outbox can push a conflicted edit to the cloud", () => {
    expect(desktopSyncSource).toContain("const pushDesktopConflictToCloud");
    expect(desktopSyncSource).toContain("export const forceUploadDesktopConflicts");
    expect(desktopSyncSource).toContain("export const forceUploadDesktopSyncIssue");
    expect(queuedSyncHookSource).toContain("forceUploadDesktopConflicts()");
  });

  test("both conflict surfaces offer the upload action", () => {
    expect(notebookPaneSource).toContain("onUploadLocalConflicts");
    expect(notebookPaneSource).toContain('t("notebookPane.sync.uploadConflicts")');
    expect(syncIssuesDialogSource).toContain("forceUploadDesktopSyncIssue");
    expect(syncIssuesDialogSource).toContain('t("notebookPane.syncDetails.uploadLocal")');

    expect(zhCN.notebookPane.sync.uploadConflicts).toBe("上传本地版本");
    expect(enUS.notebookPane.sync.uploadConflicts).toBe("Upload local versions");
    expect(ja.notebookPane.sync.uploadConflicts).toBe("ローカル版をアップロード");
    expect(zhCN.notebookPane.syncDetails.uploadLocal).toBe("上传本地版本");
  });

  test("the in-editor conflict banner can keep the local version", () => {
    expect(recoveryBannerSource).toContain("onUploadLocal");
    expect(recoveryBannerSource).toContain('t("editor.saveState.conflictUploadLocal")');
    expect(saveConflictActionsSource).toContain("handleUploadLocalVersion");
    expect(editorPaneSource).toContain("uploadLocalVersion: forceOverwriteAfterConflict");
    expect(zhCN.editor.saveState.conflictUploadLocal).toBe("上传本地版本");
    expect(enUS.editor.saveState.conflictUploadLocal).toBe("Upload local version");
    expect(ja.editor.saveState.conflictUploadLocal).toBe("ローカル版をアップロード");
  });
});
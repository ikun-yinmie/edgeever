import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { enUS } from "../packages/shared/src/i18n/en-US";
import { ja } from "../packages/shared/src/i18n/ja";
import { zhCN } from "../packages/shared/src/i18n/zh-CN";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const editorSource = readSource("../apps/web/src/components/EditorPane.tsx");
const workspaceSource = readSource("../apps/web/src/components/WorkspaceApp.tsx");
const shareFormSource = readSource("../apps/web/src/components/dialogs/ShareToGroupDialog.tsx");
const policyDialogSource = readSource("../apps/web/src/components/settings/GroupSharePolicyDialog.tsx");
const groupServiceSource = readSource("../apps/api/src/group-service.ts");
const groupRoutesSource = readSource("../apps/api/src/group-routes.ts");
const memoRoutesSource = readSource("../apps/api/src/memo-routes.ts");
const allowCopyMigration = "../migrations/0069_group_share_allow_copy.sql";

describe("group-shared notes keep a personal copy", () => {
  test("the copy falls back to a notebook the viewer owns", () => {
    // Shared group accounts own no notebook at all, so the copy must create its
    // container before writing instead of failing on "no notebook available".
    expect(workspaceSource).toContain('t("editor.sharedCopyNotebook")');
    expect(workspaceSource).toContain("api.createNotebook({ name: notebookName })");
    expect(workspaceSource).not.toContain('throw new Error("No notebook available for the copy")');
    expect(zhCN.editor.sharedCopyNotebook).toBe("我的笔记");
    expect(enUS.editor.sharedCopyNotebook).toBe("My notes");
  });

  test("the sharer can forbid saving a copy and readers see that decision", () => {
    expect(existsSync(new URL(allowCopyMigration, import.meta.url))).toBe(true);
    const migration = readSource(allowCopyMigration);
    expect(migration).toContain("ALTER TABLE group_shares ADD COLUMN allow_copy INTEGER NOT NULL DEFAULT 1");

    // Server: the share row carries the decision and both read paths expose it.
    expect(groupServiceSource).toContain("allowCopy: share.allow_copy !== 0");
    expect(groupServiceSource).toContain('updates.push("allow_copy = ?")');
    expect(groupRoutesSource).toContain("allowCopy: access.allowCopy");
    expect(memoRoutesSource).toContain("allowCopy: scope.access.allowCopy");

    // Sharing UI: the option is offered when sharing and when editing a share.
    expect(shareFormSource).toContain("allowCopy,");
    expect(shareFormSource).toContain('form.setAllowCopy(checked === true)');
    expect(policyDialogSource).toContain("allowCopy,");
    expect(policyDialogSource).toContain("setAllowCopy(checked === true)");

    // Reader: the button gives way to an explanation when copies are forbidden.
    expect(editorSource).toContain("const canSaveCopy = sharedAccess?.allowCopy !== false;");
    expect(editorSource).toContain('t("editor.saveSharedCopyBlocked")');
    expect(zhCN.editor.saveSharedCopyBlocked).toBe("分享者已禁止保存为副本");
    expect(enUS.editor.saveSharedCopyBlocked).toBe("The sharer turned off saving copies");
    expect(ja.sharedPane.allowCopyTitle).toBe("コピーの保存を許可");
  });
});

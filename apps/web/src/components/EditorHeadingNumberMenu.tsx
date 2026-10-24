import type { Editor } from "@tiptap/react";
import { ListOrdered, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export const EditorHeadingNumberMenu = ({ editor, readOnly }: { editor: Editor | null; readOnly: boolean }) => {
  const { t } = useTranslation();
  const apply = (value: "decimal" | "chinese" | "circled" | null) => {
    if (!editor || editor.isDestroyed || readOnly || !editor.isActive("heading")) return;
    editor.chain().focus().updateAttributes("heading", { headingNumbering: value }).run();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={readOnly || !editor || !editor.isActive("heading")}>
        <button type="button" className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-xs text-slate-700 hover:border-slate-200 hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40" aria-label={t("editorToolbar.headingNumbering")} onMouseDown={(event) => event.preventDefault()}>
          <ListOrdered className="h-4 w-4" />
          <span className="hidden sm:inline">{t("editorToolbar.headingNumbering")}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => apply("decimal")}>{t("editorToolbar.headingNumberDecimal")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => apply("chinese")}>{t("editorToolbar.headingNumberChinese")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => apply("circled")}>{t("editorToolbar.headingNumberCircled")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => apply(null)}>{t("editorToolbar.headingNumberNone")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

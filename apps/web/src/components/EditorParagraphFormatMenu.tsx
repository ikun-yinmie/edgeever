import type { ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { AlignJustify, ChevronDown, IndentDecrease, IndentIncrease, ListOrdered } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { LINE_HEIGHTS } from "@edgeever/shared";

type Props = { editor: Editor | null; readOnly: boolean };

const run = (editor: Editor | null, readOnly: boolean, command: (editor: Editor) => void) => {
  if (!editor || editor.isDestroyed || readOnly) return;
  editor.chain().focus();
  command(editor);
};

const updateBlocks = (editor: Editor, attrs: Record<string, unknown>) => {
  editor.chain().focus().updateAttributes("paragraph", attrs).updateAttributes("heading", attrs).run();
};

export const EditorParagraphFormatItems = ({ editor, readOnly, context = false }: Props & { context?: boolean }) => {
  const { t } = useTranslation();
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Label = context ? ContextMenuLabel : (() => null);
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  const apply = (attrs: Record<string, unknown>) => run(editor, readOnly, (active) => updateBlocks(active, attrs));
  const item = (label: string, onSelect: () => void, icon?: ReactNode) => (
    <Item key={label} className="flex cursor-pointer items-center gap-2" onSelect={onSelect}>
      {icon}
      <span>{label}</span>
    </Item>
  );

  return (
    <>
      <Label>{t("editorToolbar.lineSpacing")}</Label>
      {LINE_HEIGHTS.map((height) => item(
        t("editorToolbar.lineSpacingValue", { value: height }),
        () => apply({ lineHeight: height }),
        height === "1.5" ? <AlignJustify className="h-4 w-4" /> : undefined,
      ))}
      {item(t("editorToolbar.lineSpacingReset"), () => apply({ lineHeight: null }))}
      <Separator />
      <Label>{t("editorToolbar.indentation")}</Label>
      {item(t("editorToolbar.indentLess"), () => run(editor, readOnly, (active) => {
        const current = Number(active.getAttributes("paragraph").indentLeft ?? 0);
        updateBlocks(active, { indentLeft: Math.max(0, current - 1) });
      }), <IndentDecrease className="h-4 w-4" />)}
      {item(t("editorToolbar.indentMore"), () => run(editor, readOnly, (active) => {
        const current = Number(active.getAttributes("paragraph").indentLeft ?? 0);
        updateBlocks(active, { indentLeft: Math.min(8, current + 1) });
      }), <IndentIncrease className="h-4 w-4" />)}
      {item(t("editorToolbar.firstLineIndent"), () => apply({ firstLineIndent: 2 }), <ListOrdered className="h-4 w-4" />)}
      {item(t("editorToolbar.clearIndent"), () => apply({ indentLeft: 0, indentRight: 0, firstLineIndent: 0 }))}
    </>
  );
};

export const EditorParagraphFormatMenu = ({ editor, readOnly }: Props) => {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={readOnly || !editor}>
        <button type="button" className={cn("flex h-8 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-xs text-slate-700 hover:border-slate-200 hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40")} aria-label={t("editorToolbar.paragraphFormat")} onMouseDown={(event) => event.preventDefault()}>
          <AlignJustify className="h-4 w-4" />
          <span className="hidden sm:inline">{t("editorToolbar.paragraphFormat")}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
        <EditorParagraphFormatItems editor={editor} readOnly={readOnly} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

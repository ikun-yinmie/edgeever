import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import { AlignJustify, ChevronDown, IndentDecrease, IndentIncrease, ListOrdered } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { LINE_HEIGHTS, LINE_SPACING_MIN, LINE_SPACING_MAX, normalizeLineSpacing, updateParagraphLineSpacing, type ParagraphFormatAttrs } from "@edgeever/shared";

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
  const [selectionOnly] = useState(() => Boolean(editor && !editor.state.selection.empty));
  const selectionBookmark = useRef(editor?.state.selection.getBookmark());
  const dragTime = useRef<number | null>(null);
  const finishSpacingDrag = () => {
    if (dragTime.current === null) return;
    dragTime.current = null;
    if (editor && !editor.isDestroyed) editor.view.dispatch(closeHistory(editor.state.tr));
  };
  useEffect(() => {
    if (!editor) return;
    const mapSelection = ({ transaction }: { transaction: Transaction }) => {
      selectionBookmark.current = selectionBookmark.current?.map(transaction.mapping);
    };
    editor.on("transaction", mapSelection);
    return () => {
      editor.off("transaction", mapSelection);
      finishSpacingDrag();
    };
  }, [editor]);
  const [spacing, setSpacing] = useState(() => {
    if (!editor) return 0;
    let value: number | undefined;
    const range = selectionOnly && selectionBookmark.current
      ? selectionBookmark.current.resolve(editor.state.doc)
      : { from: 0, to: editor.state.doc.content.size };
    editor.state.doc.nodesBetween(range.from, range.to, (node) => {
      if (value === undefined && (node.type.name === "paragraph" || node.type.name === "heading")) {
        value = normalizeLineSpacing(node.attrs.lineSpacing) ?? 0;
      }
    });
    return value ?? 0;
  });
  const applySpacing = (attrs: Partial<Pick<ParagraphFormatAttrs, "lineHeight" | "lineSpacing">>) => {
    if (!editor || editor.isDestroyed || !editor.isEditable || readOnly) return;
    const range = selectionOnly && selectionBookmark.current
      ? selectionBookmark.current.resolve(editor.state.doc)
      : { from: 0, to: editor.state.doc.content.size };
    updateParagraphLineSpacing(editor.state, (transaction) => {
      // A slow drag still belongs to a single undo event.
      if (dragTime.current !== null) transaction.setTime(dragTime.current);
      editor.view.dispatch(transaction);
    }, attrs, range);
  };
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
      <div
        className="w-64 space-y-2 px-2 py-2"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
        }}
      >
        <p className="text-xs text-slate-500">{t(selectionOnly ? "editorToolbar.lineSpacingSelection" : "editorToolbar.lineSpacingDocument")}</p>
        <label className="grid gap-2 text-xs text-slate-700">
          <span className="flex items-center justify-between gap-3">
            <span>{t("editorToolbar.lineSpacingAdjust")}</span>
            <output className="tabular-nums">{spacing > 0 ? "+" : ""}{spacing} px</output>
          </span>
          <input
            type="range"
            min={LINE_SPACING_MIN}
            max={LINE_SPACING_MAX}
            step={1}
            value={spacing}
            disabled={readOnly || !editor}
            aria-label={t("editorToolbar.lineSpacingAdjust")}
            aria-valuetext={`${spacing > 0 ? "+" : ""}${spacing} px`}
            className="w-full cursor-ew-resize accent-emerald-600"
            onPointerDown={(event) => {
              if (!editor || editor.isDestroyed || !editor.isEditable || readOnly) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragTime.current = Date.now();
              editor.view.dispatch(closeHistory(editor.state.tr));
            }}
            onPointerUp={finishSpacingDrag}
            onPointerCancel={finishSpacingDrag}
            onLostPointerCapture={finishSpacingDrag}
            onChange={(event) => {
              const value = Number(event.target.value);
              setSpacing(value);
              applySpacing({ lineSpacing: value });
            }}
          />
        </label>
        <p className="text-[11px] text-slate-500">{t("editorToolbar.lineSpacingAdjustHint")}</p>
      </div>
      {LINE_HEIGHTS.map((height) => item(
        t("editorToolbar.lineSpacingValue", { value: height }),
        () => applySpacing({ lineHeight: height, lineSpacing: null }),
        height === "1.5" ? <AlignJustify className="h-4 w-4" /> : undefined,
      ))}
      {item(t("editorToolbar.lineSpacingReset"), () => applySpacing({ lineHeight: null, lineSpacing: null }))}
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

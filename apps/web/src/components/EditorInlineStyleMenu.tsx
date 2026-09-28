import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Baseline, Highlighter } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const FONT_SIZES = ["12px", "14px", "16px", "18px", "20px", "24px", "32px"];

const TEXT_COLORS = [
  { value: "#0f172a", label: "#0f172a" },
  { value: "#ef4444", label: "#ef4444" },
  { value: "#f97316", label: "#f97316" },
  { value: "#eab308", label: "#eab308" },
  { value: "#16a34a", label: "#16a34a" },
  { value: "#0ea5e9", label: "#0ea5e9" },
  { value: "#6366f1", label: "#6366f1" },
  { value: "#a855f7", label: "#a855f7" },
  { value: "#ec4899", label: "#ec4899" },
  { value: "#78716c", label: "#78716c" },
];

const HIGHLIGHT_COLORS = [
  { value: "#fde68a", label: "#fde68a" },
  { value: "#fecaca", label: "#fecaca" },
  { value: "#bbf7d0", label: "#bbf7d0" },
  { value: "#bae6fd", label: "#bae6fd" },
  { value: "#e9d5ff", label: "#e9d5ff" },
  { value: "#fbcfe8", label: "#fbcfe8" },
  { value: "#e7e5e4", label: "#e7e5e4" },
];

type EditorInlineStyleMenuProps = {
  editor: Editor | null;
  readOnly: boolean;
};

const readTextStyleAttr = (editor: Editor | null, attribute: "color" | "backgroundColor" | "fontSize") => {
  if (!editor || editor.isDestroyed) return null;
  try {
    const attrs = editor.getAttributes("textStyle");
    const value = attrs[attribute];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
};

export const EditorFontSizeMenu = ({ editor, readOnly }: EditorInlineStyleMenuProps) => {
  const { t } = useTranslation();
  const currentSize = readTextStyleAttr(editor, "fontSize");

  const run = (command: (activeEditor: Editor) => void) => {
    if (!editor || editor.isDestroyed || readOnly) return;
    editor.commands.focus();
    command(editor);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={readOnly}>
            <button
              type="button"
              className={cn(
                "flex h-8 min-w-9 shrink-0 items-center justify-center gap-0.5 rounded-md border px-1.5 text-xs transition disabled:pointer-events-none disabled:opacity-40",
                currentSize
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-transparent bg-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50",
              )}
              aria-label={t("editorToolbar.fontSize")}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span className="text-[13px] font-semibold leading-none">{t("editorToolbar.fontSize")}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("editorToolbar.fontSize")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-36">
        {FONT_SIZES.map((size) => (
          <DropdownMenuItem
            key={size}
            className={cn("justify-between", currentSize === size && "bg-emerald-50 text-emerald-800")}
            onSelect={() => run((active) => active.chain().focus().setFontSize(size).run())}
          >
            <span style={{ fontSize: size }}>{size}</span>
            {currentSize === size && <span aria-hidden="true">✓</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run((active) => active.chain().focus().unsetFontSize().run())}>
          {t("editorToolbar.fontSizeReset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const EditorTextColorMenu = ({ editor, readOnly }: EditorInlineStyleMenuProps) => {
  const { t } = useTranslation();
  const state = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) => {
      if (!activeEditor || activeEditor.isDestroyed) return { color: null, active: false };
      try {
        const attrs = activeEditor.getAttributes("textStyle");
        return {
          color: typeof attrs.color === "string" && attrs.color ? attrs.color : null,
          active: activeEditor.isActive("textStyle"),
        };
      } catch {
        return { color: null, active: false };
      }
    },
  });
  const currentColor = state?.color ?? null;

  const run = (command: (activeEditor: Editor) => void) => {
    if (!editor || editor.isDestroyed || readOnly) return;
    editor.commands.focus();
    command(editor);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={readOnly}>
            <button
              type="button"
              className={cn(
                "flex h-8 w-8 shrink-0 flex-col items-center justify-center rounded-md border transition disabled:pointer-events-none disabled:opacity-40",
                currentColor
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-transparent bg-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50",
              )}
              aria-label={t("editorToolbar.fontColor")}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Baseline className="h-4 w-4" />
              <span
                className="mt-0.5 h-0.5 w-4 rounded-full"
                style={{ backgroundColor: currentColor ?? "transparent", boxShadow: currentColor ? "none" : "inset 0 0 0 1px rgb(var(--slate-300-rgb))" }}
              />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("editorToolbar.fontColor")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-44">
        <div className="grid grid-cols-5 gap-1 p-1">
          {TEXT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md border transition",
                currentColor?.toLowerCase() === color.value
                  ? "border-emerald-500 ring-2 ring-emerald-500/30"
                  : "border-slate-200 hover:border-slate-400",
              )}
              style={{ backgroundColor: color.value }}
              aria-label={color.value}
              title={color.value}
              onClick={() => run((active) => active.chain().focus().setColor(color.value).run())}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run((active) => active.chain().focus().unsetColor().run())}>
          {t("editorToolbar.fontColorReset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const EditorHighlightColorMenu = ({ editor, readOnly }: EditorInlineStyleMenuProps) => {
  const { t } = useTranslation();
  const currentColor = readTextStyleAttr(editor, "backgroundColor");

  const run = (command: (activeEditor: Editor) => void) => {
    if (!editor || editor.isDestroyed || readOnly) return;
    editor.commands.focus();
    command(editor);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={readOnly}>
            <button
              type="button"
              className={cn(
                "flex h-8 w-8 shrink-0 flex-col items-center justify-center rounded-md border transition disabled:pointer-events-none disabled:opacity-40",
                currentColor
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-transparent bg-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50",
              )}
              aria-label={t("editorToolbar.highlightColor")}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Highlighter className="h-4 w-4" />
              <span
                className="mt-0.5 h-0.5 w-4 rounded-full"
                style={{ backgroundColor: currentColor ?? "transparent", boxShadow: currentColor ? "none" : "inset 0 0 0 1px rgb(var(--slate-300-rgb))" }}
              />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("editorToolbar.highlightColor")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-44">
        <div className="grid grid-cols-5 gap-1 p-1">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md border transition",
                currentColor?.toLowerCase() === color.value
                  ? "border-emerald-500 ring-2 ring-emerald-500/30"
                  : "border-slate-200 hover:border-slate-400",
              )}
              style={{ backgroundColor: color.value }}
              aria-label={color.value}
              title={color.value}
              onClick={() => run((active) => active.chain().focus().setBackgroundColor(color.value).run())}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run((active) => active.chain().focus().unsetBackgroundColor().run())}>
          {t("editorToolbar.highlightColorReset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

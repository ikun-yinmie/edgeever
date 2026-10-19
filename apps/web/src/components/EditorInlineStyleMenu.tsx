import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import {
  AArrowDown,
  AArrowUp,
  Baseline,
  ChevronDown,
  Highlighter,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  FONT_SIZE_BASE_PX,
  FONT_SIZE_PX_MAX,
  FONT_SIZE_PX_MIN,
  FONT_SIZE_SCALE,
  clampFontSizePx,
  parseFontSizePx,
  stepFontSizePx,
} from "@edgeever/shared";

const FONT_SIZES = FONT_SIZE_SCALE.map((size) => `${size}px`);

export const FONT_SIZE_MENU_VALUES = FONT_SIZES;

/** 每行五个的文字色盘：第一行黑灰阶，后四行按色相从浅到深。 */
const TEXT_COLORS = [
  "#0f172a", "#475569", "#9aa4b2", "#78716c", "#c026d3",
  "#ef4444", "#f97316", "#eab308", "#16a34a", "#0d9488",
  "#0ea5e9", "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
  "#fca5a5", "#fdba74", "#fde047", "#86efac", "#7dd3fc",
  "#a5b4fc", "#d8b4fe", "#f9a8d4", "#059669", "#be185d",
];

/** 每行五个的高亮底色盘：柔和低饱和，附带两个深色便于反白标注。 */
const HIGHLIGHT_COLORS = [
  "#fde68a", "#fecaca", "#bbf7d0", "#bae6fd", "#e9d5ff",
  "#fbcfe8", "#fef08a", "#99f6e4", "#bfdbfe", "#ddd6fe",
  "#e7e5e4", "#fed7aa", "#a7f3d0", "#f5d0fe", "#c7d2fe",
  "#d9f99d", "#fda4af", "#93c5fd", "#fcd34d", "#86efac",
  "#0ea5e9", "#e11d48", "#16a34a", "#d97706", "#7c3aed",
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

type ColorSwatchProps = {
  color: string;
  selected: boolean;
  onSelect: () => void;
};

/** 圆角色块：浅色用边框分界，深色带白色内衬便于辨认。 */
const ColorSwatch = ({ color, selected, onSelect }: ColorSwatchProps) => (
  <button
    type="button"
    className={cn(
      "h-7 w-7 rounded-md border transition",
      selected
        ? "border-emerald-500 ring-2 ring-emerald-500/30"
        : "border-slate-200 hover:border-slate-400",
    )}
    style={{
      backgroundColor: color,
      boxShadow: "inset 0 0 0 2px rgb(255 255 255 / 0.45)",
    }}
    aria-label={color}
    aria-pressed={selected}
    onClick={onSelect}
  />
);

type CustomColorItemProps = {
  label: string;
  onPick: (color: string) => void;
};

/** 托管在下拉菜单项里的原生取色器：选择即应用，菜单保持打开以便微调。 */
const CustomColorItem = ({ label, onPick }: CustomColorItemProps) => (
  <DropdownMenuItem
    className="gap-2"
    onSelect={(event) => event.preventDefault()}
  >
    <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-md border border-slate-200" aria-hidden="true">
      <span className="absolute inset-0 bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]" />
    </span>
    <span className="flex-1 text-sm">{label}</span>
    <input
      type="color"
      aria-label={label}
      className="h-6 w-8 shrink-0 cursor-pointer border-0 bg-transparent p-0"
      onChange={(event) => onPick(event.target.value)}
      onClick={(event) => event.stopPropagation()}
    />
  </DropdownMenuItem>
);

export const EditorFontSizeMenu = ({ editor, readOnly }: EditorInlineStyleMenuProps) => {
  const { t } = useTranslation();
  const currentSize = readTextStyleAttr(editor, "fontSize");
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const run = (command: (activeEditor: Editor) => void) => {
    if (!editor || editor.isDestroyed || readOnly) return;
    editor.commands.focus();
    command(editor);
  };

  const parsedCustom = Number.parseInt(customValue.trim(), 10);
  const customValid = Number.isFinite(parsedCustom);

  const applyCustomSize = () => {
    if (!customValid) return;
    run((active) => active.chain().focus().setFontSize(`${clampFontSizePx(parsedCustom)}px`).run());
    setOpen(false);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setCustomValue(nextOpen ? String(parseFontSizePx(currentSize) ?? FONT_SIZE_BASE_PX) : "");
      }}
    >
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
              <span className="min-w-9 text-[13px] font-semibold leading-none tabular-nums">{currentSize ?? t("editorToolbar.fontSize")}</span>
              <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("editorToolbar.fontSize")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="max-h-80 min-w-24 overflow-y-auto">
        <div
          className="flex items-center gap-1.5 px-2 py-1.5"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={FONT_SIZE_PX_MIN}
            max={FONT_SIZE_PX_MAX}
            value={customValue}
            disabled={readOnly}
            placeholder={String(FONT_SIZE_BASE_PX)}
            aria-label={t("editorToolbar.fontSizeCustom")}
            className="h-7 w-16 px-2 text-[13px] tabular-nums"
            onChange={(event) => setCustomValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                applyCustomSize();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-7 px-2 text-[13px] font-normal"
            disabled={readOnly || !customValid}
            onMouseDown={(event) => event.preventDefault()}
            onClick={applyCustomSize}
          >
            {t("editorToolbar.fontSizeApply")}
          </Button>
        </div>
        <DropdownMenuSeparator />
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

export const EditorFontSizeStepButtons = ({ editor, readOnly }: EditorInlineStyleMenuProps) => {
  const { t } = useTranslation();

  const step = (direction: 1 | -1) => {
    if (!editor || editor.isDestroyed || readOnly) return;
    const current = parseFontSizePx(readTextStyleAttr(editor, "fontSize"));
    const next = stepFontSizePx(current, direction);
    editor.chain().focus().setFontSize(`${next}px`).run();
  };

  const stepButtons = [
    { direction: -1 as const, label: t("editorToolbar.fontSizeDecrease"), Icon: AArrowDown },
    { direction: 1 as const, label: t("editorToolbar.fontSizeIncrease"), Icon: AArrowUp },
  ];

  return (
    <>
      {stepButtons.map(({ direction, label, Icon }) => (
        <Tooltip key={direction}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-slate-700 transition hover:border-slate-200 hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40"
              disabled={readOnly}
              aria-label={label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => step(direction)}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      ))}
    </>
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
        <TooltipContent side="top">{t("editorToolbar.fontColor")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-44">
        <div className="grid grid-cols-5 gap-1 p-1">
          {TEXT_COLORS.map((color) => (
            <ColorSwatch
              key={color}
              color={color}
              selected={currentColor?.toLowerCase() === color}
              onSelect={() => run((active) => active.chain().focus().setColor(color).run())}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <CustomColorItem label={t("editorToolbar.customColorLabel")} onPick={(color) => run((active) => active.chain().focus().setColor(color).run())} />
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
        <TooltipContent side="top">{t("editorToolbar.highlightColor")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-44">
        <div className="grid grid-cols-5 gap-1 p-1">
          {HIGHLIGHT_COLORS.map((color) => (
            <ColorSwatch
              key={color}
              color={color}
              selected={currentColor?.toLowerCase() === color}
              onSelect={() => run((active) => active.chain().focus().setBackgroundColor(color).run())}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <CustomColorItem label={t("editorToolbar.customColorLabel")} onPick={(color) => run((active) => active.chain().focus().setBackgroundColor(color).run())} />
        <DropdownMenuItem onSelect={() => run((active) => active.chain().focus().unsetBackgroundColor().run())}>
          {t("editorToolbar.highlightColorReset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

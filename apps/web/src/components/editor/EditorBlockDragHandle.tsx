import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import DragHandle from "@tiptap/extension-drag-handle-react";
import {
  Braces,
  ChevronRight,
  Copy,
  CornerDownLeft,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  IndentDecrease,
  IndentIncrease,
  List,
  ListOrdered,
  ListTodo,
  MoreVertical,
  Pilcrow,
  Quote,
  Scissors,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const BLOCK_DRAG_HANDLE_CLASS_NAME = "edgeever-block-drag-handle";
const BLOCK_MENU_TRIGGER_CLASS_NAME = "edgeever-block-menu-trigger";

const isBlockHandleEvent = (event: DragEvent, className: string) => {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest(`.${className}`));
};

/** TipTap clears dataTransfer during dragstart; Chrome then refuses the drop unless a type remains. */
const retainBlockDragDataTransfer = (event: DragEvent) => {
  if (!isBlockHandleEvent(event, BLOCK_DRAG_HANDLE_CLASS_NAME) || !event.dataTransfer) {
    return;
  }
  event.dataTransfer.effectAllowed = "move";
  if (![...event.dataTransfer.types].includes("text/plain")) {
    event.dataTransfer.setData("text/plain", " ");
  }
};

type TransformOption = {
  id: string;
  icon: typeof Pilcrow;
  label: string;
  run: (editor: Editor) => boolean;
};

const HEADING_TRANSFORMS: Array<{ level: 1 | 2 | 3 | 4 | 5 | 6; icon: typeof Heading1 }> = [
  { level: 1, icon: Heading1 },
  { level: 2, icon: Heading2 },
  { level: 3, icon: Heading3 },
  { level: 4, icon: Heading4 },
  { level: 5, icon: Heading5 },
  { level: 6, icon: Heading6 },
];

const getBlockTransformOptions = (t: (key: string) => string): TransformOption[] => [
  {
    id: "paragraph",
    icon: Pilcrow,
    label: t("editorToolbar.paragraph"),
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  ...HEADING_TRANSFORMS.map(({ level, icon }) => ({
    id: `heading-${level}`,
    icon,
    label: t(`editorToolbar.heading${level}` as const),
    run: (editor: Editor) => editor.chain().focus().setHeading({ level }).run(),
  })),
  {
    id: "bullet-list",
    icon: List,
    label: t("editorToolbar.bulletList"),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ordered-list",
    icon: ListOrdered,
    label: t("editorToolbar.orderedList"),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "task-list",
    icon: ListTodo,
    label: t("editorToolbar.taskList"),
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    id: "blockquote",
    icon: Quote,
    label: t("editorToolbar.quote"),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "code-block",
    icon: Braces,
    label: t("editorToolbar.codeBlock"),
    run: (editor) => editor.chain().focus().setCodeBlock().run(),
  },
];

/** Resolve the top-level block node around the selection for whole-block operations. */
const resolveBlockRange = (editor: Editor) => {
  const { $from, $to } = editor.state.selection;
  const sharedDepth = Math.min($from.sharedDepth($to.pos), $from.depth);
  const depth = sharedDepth > 0 ? sharedDepth - 1 : 0;
  const from = $from.before(depth + 1);
  const to = $to.after(depth + 1);
  return { from, to, depth };
};

const canSinkOrLift = (editor: Editor, action: "sink" | "lift") => {
  const listTypes = ["bulletList", "orderedList", "taskList"];
  for (const type of listTypes) {
    if (action === "sink" ? editor.can().sinkListItem(type) : editor.can().liftListItem(type)) {
      return true;
    }
  }
  return false;
};

const runIndent = (editor: Editor, action: "sink" | "lift") => {
  for (const type of ["bulletList", "orderedList", "taskList"]) {
    const chain = editor.chain().focus();
    const command = action === "sink" ? chain.sinkListItem(type) : chain.liftListItem(type);
    if (command.run()) {
      return true;
    }
  }
  return false;
};

type AddBelowOption = {
  id: string;
  icon: typeof Pilcrow;
  label: string;
  insert: (editor: Editor, position: number) => boolean;
};

const getAddBelowOptions = (t: (key: string) => string): AddBelowOption[] => [
  {
    id: "paragraph",
    icon: Pilcrow,
    label: t("editorToolbar.paragraph"),
    insert: (editor, position) => editor.chain().focus().insertContentAt(position, { type: "paragraph" }).run(),
  },
  {
    id: "heading-1",
    icon: Heading1,
    label: t("editorToolbar.heading1"),
    insert: (editor, position) =>
      editor.chain().focus().insertContentAt(position, { type: "heading", attrs: { level: 1 } }).run(),
  },
  {
    id: "heading-2",
    icon: Heading2,
    label: t("editorToolbar.heading2"),
    insert: (editor, position) =>
      editor.chain().focus().insertContentAt(position, { type: "heading", attrs: { level: 2 } }).run(),
  },
  {
    id: "heading-3",
    icon: Heading3,
    label: t("editorToolbar.heading3"),
    insert: (editor, position) =>
      editor.chain().focus().insertContentAt(position, { type: "heading", attrs: { level: 3 } }).run(),
  },
  {
    id: "bullet-list",
    icon: List,
    label: t("editorToolbar.bulletList"),
    insert: (editor, position) => {
      editor.chain().focus().insertContentAt(position, { type: "paragraph" }).run();
      return editor.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: "ordered-list",
    icon: ListOrdered,
    label: t("editorToolbar.orderedList"),
    insert: (editor, position) => {
      editor.chain().focus().insertContentAt(position, { type: "paragraph" }).run();
      return editor.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: "task-list",
    icon: ListTodo,
    label: t("editorToolbar.taskList"),
    insert: (editor, position) => {
      editor.chain().focus().insertContentAt(position, { type: "paragraph" }).run();
      return editor.chain().focus().toggleTaskList().run();
    },
  },
  {
    id: "blockquote",
    icon: Quote,
    label: t("editorToolbar.quote"),
    insert: (editor, position) => {
      editor.chain().focus().insertContentAt(position, { type: "paragraph" }).run();
      return editor.chain().focus().toggleBlockquote().run();
    },
  },
  {
    id: "code-block",
    icon: Braces,
    label: t("editorToolbar.codeBlock"),
    insert: (editor, position) =>
      editor.chain().focus().insertContentAt(position, { type: "codeBlock" }).run(),
  },
  {
    id: "divider",
    icon: CornerDownLeft,
    label: t("editorToolbar.horizontalRule"),
    insert: (editor, position) => {
      editor.chain().focus().insertContentAt(position, { type: "paragraph" }).run();
      return editor.chain().focus().setHorizontalRule().run();
    },
  },
];

const duplicateBlock = (editor: Editor) => {
  const { from, to } = resolveBlockRange(editor);
  const slice = editor.state.doc.slice(from, to);
  return editor.chain().focus().insertContentAt(to, slice.content).run();
};

const cutBlock = (editor: Editor) => {
  const { from, to } = resolveBlockRange(editor);
  const slice = editor.state.doc.slice(from, to);
  const copied = editor.chain().focus().insertContentAt(to, slice.content).run();
  if (!copied) return false;
  return editor.chain().focus().deleteRange({ from, to: to + (to - from) }).run();
};

export const EditorBlockDragHandle = ({ editor }: { editor: Editor }) => {
  const { t } = useTranslation();

  useEffect(() => {
    document.addEventListener("dragstart", retainBlockDragDataTransfer);
    return () => document.removeEventListener("dragstart", retainBlockDragDataTransfer);
  }, []);

  if (editor.isDestroyed || !editor.isEditable) {
    return null;
  }

  const deleteBlock = () => {
    const { from, to } = resolveBlockRange(editor);
    editor.chain().focus().deleteRange({ from, to }).run();
  };

  const addBelow = (insert: (position: number) => boolean) => {
    const { to } = resolveBlockRange(editor);
    if (!insert(to)) return;
    window.requestAnimationFrame(() => editor.commands.focus("end"));
  };

  const transformOptions = getBlockTransformOptions(t);
  const addBelowOptions = getAddBelowOptions(t);

  return (
    <DragHandle
      editor={editor}
      className={BLOCK_DRAG_HANDLE_CLASS_NAME}
      nested
    >
      <span className="sr-only">{t("editor.dragHandle")}</span>
      <GripVertical aria-hidden="true" className="h-4 w-4" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={BLOCK_MENU_TRIGGER_CLASS_NAME}
            aria-label={t("editor.blockMenu.trigger")}
            onMouseDown={(event) => event.preventDefault()}
            onDragStart={(event) => event.stopPropagation()}
            draggable={false}
          >
            <MoreVertical aria-hidden="true" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" sideOffset={6} className="min-w-52">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <CornerDownLeft className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <span>{t("editor.blockMenu.transform")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 min-w-44 overflow-y-auto">
              {transformOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuItem key={option.id} onSelect={() => option.run(editor)}>
                    <Icon className="h-4 w-4 text-slate-500" aria-hidden="true" />
                    {option.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={deleteBlock}>
            <Trash2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
            {t("editor.blockMenu.delete")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => duplicateBlock(editor)}>
            <Copy className="h-4 w-4 text-slate-500" aria-hidden="true" />
            {t("editor.blockMenu.duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void cutBlock(editor)}>
            <Scissors className="h-4 w-4 text-slate-500" aria-hidden="true" />
            {t("editor.blockMenu.cut")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2" disabled={!canSinkOrLift(editor, "sink") && !canSinkOrLift(editor, "lift")}>
              <IndentIncrease className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <span>{t("editor.blockMenu.indent")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-40">
              <DropdownMenuItem
                disabled={!canSinkOrLift(editor, "sink")}
                onSelect={() => runIndent(editor, "sink")}
              >
                <IndentIncrease className="h-4 w-4 text-slate-500" aria-hidden="true" />
                {t("editor.blockMenu.indentMore")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canSinkOrLift(editor, "lift")}
                onSelect={() => runIndent(editor, "lift")}
              >
                <IndentDecrease className="h-4 w-4 text-slate-500" aria-hidden="true" />
                {t("editor.blockMenu.indentLess")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Copy className="h-4 w-4 rotate-45 text-slate-500" aria-hidden="true" />
              <span>{t("editor.blockMenu.addBelow")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 min-w-44 overflow-y-auto">
              {addBelowOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuItem key={option.id} onSelect={() => addBelow((position) => option.insert(editor, position))}>
                    <Icon className="h-4 w-4 text-slate-500" aria-hidden="true" />
                    {option.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </DragHandle>
  );
};

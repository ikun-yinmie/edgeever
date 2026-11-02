import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model";

export type CapturedMark = {
  type: string;
  attrs?: Record<string, any>;
};

export type CapturedFormat = {
  marks: CapturedMark[];
  timestamp: number;
};

const FORMAT_PAINTER_MARK_TYPES = [
  "textStyle",
  "bold",
  "italic",
  "strike",
  "code",
  "underline",
  "highlight",
] as const;

/**
 * Captures all relevant inline formatting marks at the current selection.
 */
export const captureFormatFromEditor = (editor: Editor): CapturedFormat | null => {
  const { state } = editor;
  const { selection } = state;
  const { from, to } = selection;

  const markMap = new Map<string, ProseMirrorMark>();

  if (from === to) {
    const marks = state.storedMarks || selection.$from.marks();
    for (const m of marks) {
      markMap.set(m.type.name, m);
    }
  } else {
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isInline && node.marks.length > 0) {
        for (const m of node.marks) {
          if (!markMap.has(m.type.name)) {
            markMap.set(m.type.name, m);
          }
        }
      }
    });
  }

  const capturedMarks: CapturedMark[] = Array.from(markMap.values())
    .filter((mark) => FORMAT_PAINTER_MARK_TYPES.includes(mark.type.name as any))
    .map((mark) => ({
      type: mark.type.name,
      attrs: mark.attrs && Object.keys(mark.attrs).length > 0 ? { ...mark.attrs } : undefined,
    }));

  return {
    marks: capturedMarks,
    timestamp: Date.now(),
  };
};

/**
 * Applies the captured format to the target range (or current selection) in the editor.
 */
export const applyFormatToEditor = (
  editor: Editor,
  format: CapturedFormat,
  range?: { from: number; to: number },
): boolean => {
  const { state, view } = editor;
  const targetFrom = range ? range.from : state.selection.from;
  const targetTo = range ? range.to : state.selection.to;

  if (targetFrom >= targetTo) {
    return false;
  }

  let tr = state.tr;
  const schema = state.schema;

  // 1. Remove existing inline formatting in the target range to avoid dirty compounding
  for (const markName of FORMAT_PAINTER_MARK_TYPES) {
    const markType = schema.marks[markName];
    if (markType) {
      tr = tr.removeMark(targetFrom, targetTo, markType);
    }
  }

  // 2. Add the captured marks
  for (const item of format.marks) {
    const markType = schema.marks[item.type];
    if (markType) {
      const mark = markType.create(item.attrs);
      tr = tr.addMark(targetFrom, targetTo, mark);
    }
  }

  view.dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Copies the current text selection strictly as plain text.
 */
export const copySelectionAsPlainText = async (editor: Editor): Promise<boolean> => {
  const { state } = editor;
  const { from, to } = state.selection;
  if (from >= to) return false;
  const text = state.doc.textBetween(from, to, "\n\n");
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

/**
 * Copies the current text selection with formatting (HTML + text).
 */
export const copySelectionWithFormat = async (editor: Editor): Promise<boolean> => {
  const { state } = editor;
  const { from, to } = state.selection;
  if (from >= to) return false;
  try {
    if (typeof document !== "undefined") {
      document.execCommand("copy");
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

/**
 * Pastes clipboard text content strictly as plain text without inline formatting.
 */
export const pasteClipboardAsPlainText = async (editor: Editor): Promise<boolean> => {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return false;
    }
    const text = await navigator.clipboard.readText();
    if (!text) return false;
    editor.commands.insertContent(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * React hook managing format painter active and persistent states.
 */
export const useFormatPainter = (editor: Editor | null) => {
  const [painterState, setPainterState] = useState<{
    active: boolean;
    locked: boolean;
    format: CapturedFormat | null;
  }>({
    active: false,
    locked: false,
    format: null,
  });

  const togglePainter = (locked = false) => {
    if (!editor || editor.isDestroyed) return;
    if (painterState.active && (!locked || painterState.locked === locked)) {
      setPainterState({ active: false, locked: false, format: null });
      return;
    }
    const captured = captureFormatFromEditor(editor);
    if (!captured) return;
    setPainterState({ active: true, locked, format: captured });
  };

  useEffect(() => {
    if (!editor || !painterState.active || !painterState.format) return;

    const dom = editor.view?.dom;
    if (!dom) return;

    dom.classList.add("edgeever-format-painter-active");

    const onMouseUp = () => {
      setTimeout(() => {
        if (!editor || editor.isDestroyed || !painterState.format) return;
        const { from, to } = editor.state.selection;
        if (from < to) {
          applyFormatToEditor(editor, painterState.format, { from, to });
          if (!painterState.locked) {
            setPainterState({ active: false, locked: false, format: null });
          }
        }
      }, 30);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPainterState({ active: false, locked: false, format: null });
      }
    };

    dom.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      dom.classList.remove("edgeever-format-painter-active");
      dom.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [editor, painterState]);

  return {
    isActive: painterState.active,
    isLocked: painterState.locked,
    togglePainter,
    cancelPainter: () => setPainterState({ active: false, locked: false, format: null }),
  };
};

import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { getEditorOutlineItems } from "@/lib/editor-outline-editor";
import type { OutlineItem } from "@/lib/editor-outline";
import { isEditorDocumentReady, type EditorDocumentState } from "./editor-document-state";

const EMPTY_ITEMS: OutlineItem[] = [];

type OutlineSnapshot = {
  editor: Editor;
  documentKey: string | undefined;
  documentState: EditorDocumentState | null | undefined;
  items: OutlineItem[];
};

const sameItems = (left: OutlineItem[], right: OutlineItem[]) =>
  left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other?.level === item.level
      && other.pos === item.pos
      && other.text === item.text
      && JSON.stringify(other.segments) === JSON.stringify(item.segments);
  });

export const useEditorOutlineItems = (
  editor: Editor | null,
  documentKey: string | undefined,
  documentState: EditorDocumentState | null | undefined,
) => {
  const [snapshot, setSnapshot] = useState<OutlineSnapshot | null>(null);
  const ready = isEditorDocumentReady(editor, documentKey, documentState);

  const refresh = useCallback(() => {
    if (!isEditorDocumentReady(editor, documentKey, documentState) || !editor) {
      setSnapshot(null);
      return;
    }
    const items = getEditorOutlineItems(editor);
    setSnapshot((current) => (
      current?.editor === editor
      && current.documentKey === documentKey
      && current.documentState === documentState
      && sameItems(current.items, items)
        ? current
        : { editor, documentKey, documentState, items }
    ));
  }, [editor, documentKey, documentState]);

  useEffect(() => {
    refresh();
    if (!ready || !editor) return;
    editor.on("update", refresh);
    return () => { editor.off("update", refresh); };
  }, [editor, ready, refresh]);

  // Never expose headings sampled for another note, even before effects run.
  const sampled = ready
    && snapshot?.editor === editor
    && snapshot.documentKey === documentKey
    && snapshot.documentState === documentState;
  const items = sampled && snapshot ? snapshot.items : EMPTY_ITEMS;

  return { items, ready, sampled, refresh };
};

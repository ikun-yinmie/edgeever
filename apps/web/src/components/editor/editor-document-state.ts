import type { Editor } from "@tiptap/react";

/** Identifies the document actually applied to a reused editor view. */
export type EditorDocumentState = {
  editor: Editor;
  documentKey: string;
  version: number;
};

export const isEditorDocumentReady = (
  editor: Editor | null,
  documentKey: string | undefined,
  documentState: EditorDocumentState | null | undefined,
) => Boolean(editor && !editor.isDestroyed && (
  documentState === undefined
  || (documentState?.editor === editor && documentState.documentKey === documentKey)
));

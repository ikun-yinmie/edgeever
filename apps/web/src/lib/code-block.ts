import { common, createLowlight } from "lowlight";
import type { Editor } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { createEdgeEverCodeBlock } from "@edgeever/shared";
import { MermaidCodeBlock } from "@/components/MermaidCodeBlock";
import { getCodeBlockPreviewLanguage } from "./code-block-preview";

export const codeBlockLowlight = createLowlight(common);

export const selectCurrentCodeBlockContent = (editor: Editor) => {
  const { $from, $to, from, to } = editor.state.selection;
  if ($from.parent !== $to.parent || $from.parent.type.name !== "codeBlock") {
    return false;
  }

  const blockFrom = $from.start();
  const blockTo = $from.end();
  if (from === blockFrom && to === blockTo) {
    return false;
  }

  return editor.commands.setTextSelection({ from: blockFrom, to: blockTo });
};

/** Hidden contentDOMs are skipped by native arrow navigation; enter explicitly. */
export const enterAdjacentPreviewCodeBlock = (editor: Editor, direction: -1 | 1, vertical = false) => {
  const { $from, empty } = editor.state.selection;
  if (!editor.isEditable || !empty || $from.depth === 0 || !$from.parent.isTextblock) return false;
  const boundary = direction === 1 ? $from.after() : $from.before();
  const $boundary = editor.state.doc.resolve(boundary);
  const adjacent = direction === 1 ? $boundary.nodeAfter : $boundary.nodeBefore;
  if (adjacent?.type.name !== "codeBlock"
    || !getCodeBlockPreviewLanguage(adjacent.attrs.language)
    || adjacent.attrs.meta?.collapsed === true) return false;

  const atBoundary = vertical
    ? editor.view.endOfTextblock(direction === 1 ? "down" : "up")
    : $from.parentOffset === (direction === 1 ? $from.parent.content.size : 0);
  return atBoundary && editor.commands.setTextSelection(boundary + direction);
};

/**
 * The shared codeBlock (meta attrs + markdown round-trip) wired to the React
 * node view and the desktop lowlight highlighter. The options cast is needed
 * because `lowlight` is added by the lowlight adapter's options interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EdgeEverCodeBlock = createEdgeEverCodeBlock().extend<any>({
  addOptions() {
    return {
      ...(this.parent?.() ?? {}),
      lowlight: codeBlockLowlight,
    };
  },

  addKeyboardShortcuts() {
    const inherited = this.parent?.() ?? {};
    const navigate = (key: string, direction: -1 | 1, vertical = false) =>
      enterAdjacentPreviewCodeBlock(this.editor, direction, vertical)
      || inherited[key]?.({ editor: this.editor })
      || false;
    return {
      ...inherited,
      "Mod-a": () => selectCurrentCodeBlockContent(this.editor),
      ArrowRight: () => navigate("ArrowRight", 1),
      ArrowLeft: () => navigate("ArrowLeft", -1),
      ArrowDown: () => navigate("ArrowDown", 1, true),
      ArrowUp: () => navigate("ArrowUp", -1, true),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlock);
  },
});

export const getCodeBlockLanguageValue = (language: unknown) => {
  const previewLanguage = getCodeBlockPreviewLanguage(language);
  if (previewLanguage) return previewLanguage;
  if (typeof language !== "string" || !language) {
    return "plaintext";
  }

  return CODE_BLOCK_LANGUAGES.some((option) => option.value === language) ? language : "plaintext";
};

export const CODE_BLOCK_LANGUAGES = [
  { value: "plaintext", label: "Plain text" },
  { value: "bash", label: "Bash" },
  { value: "c", label: "C" },
  { value: "csharp", label: "C#" },
  { value: "cpp", label: "C++" },
  { value: "css", label: "CSS" },
  { value: "go", label: "Go" },
  { value: "html", label: "HTML" },
  { value: "java", label: "Java" },
  { value: "javascript", label: "JavaScript" },
  { value: "json", label: "JSON" },
  { value: "kotlin", label: "Kotlin" },
  { value: "markdown", label: "Markdown" },
  { value: "mermaid", label: "Mermaid" },
  { value: "php", label: "PHP" },
  { value: "python", label: "Python" },
  { value: "ruby", label: "Ruby" },
  { value: "rust", label: "Rust" },
  { value: "sql", label: "SQL" },
  { value: "swift", label: "Swift" },
  { value: "typescript", label: "TypeScript" },
  { value: "yaml", label: "YAML" },
] as const;

import type { Editor } from "@tiptap/react";
import { trimOutlineSegments, type OutlineItem, type OutlineTextSegment } from "./editor-outline";

/** Reads the current document's headings, keeping strike marks and positions. */
export const getEditorOutlineItems = (editor: Editor): OutlineItem[] => {
  const items: OutlineItem[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") {
      return;
    }

    const rawSegments: OutlineTextSegment[] = [];
    node.forEach((child) => {
      if (!child.isText || !child.text) {
        return;
      }

      const strike = child.marks.some((mark) => mark.type.name === "strike");
      const previous = rawSegments[rawSegments.length - 1];
      if (previous && previous.strike === strike) {
        previous.text += child.text;
      } else {
        rawSegments.push({ text: child.text, strike });
      }
    });

    const segments = trimOutlineSegments(rawSegments);
    const text = segments.map((segment) => segment.text).join("");
    if (text) {
      items.push({
        level: Number(node.attrs.level) || 1,
        pos,
        text,
        segments,
      });
    }
  });

  return items;
};

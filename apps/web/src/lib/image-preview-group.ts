import type { EditorView } from "@tiptap/pm/view";

export type ImagePreviewSlide = {
  src: string;
  alt?: string;
};

export type ImagePreviewGroup = {
  slides: ImagePreviewSlide[];
  index: number;
};

const IMAGE_NODE_NAME = "image";

const readString = (value: unknown) => (typeof value === "string" ? value : "");

const toSlide = (node: { attrs: Record<string, unknown> }): ImagePreviewSlide | null => {
  const src = readString(node.attrs.src);
  if (!src) {
    return null;
  }

  const alt = readString(node.attrs.title) || readString(node.attrs.alt);
  return alt ? { src, alt } : { src };
};

/**
 * Collects the run of image nodes that sit directly next to the clicked image
 * in the same parent. Adjacent images can be stepped through in the viewer;
 * separated images open on their own.
 */
export const getImagePreviewGroup = (view: EditorView, position: number): ImagePreviewGroup | null => {
  const doc = view.state.doc;
  if (position < 0 || position > doc.content.size) {
    return null;
  }

  const resolved = doc.resolve(position);
  const parent = resolved.parent;
  let clickedIndex = resolved.index();
  const isImage = (index: number) => parent.child(index)?.type.name === IMAGE_NODE_NAME;

  if (!isImage(clickedIndex)) {
    if (clickedIndex > 0 && isImage(clickedIndex - 1)) {
      clickedIndex -= 1;
    } else {
      return null;
    }
  }

  let startIndex = clickedIndex;
  let endIndex = clickedIndex;
  while (startIndex > 0 && isImage(startIndex - 1)) {
    startIndex -= 1;
  }
  while (endIndex + 1 < parent.childCount && isImage(endIndex + 1)) {
    endIndex += 1;
  }

  const slides: ImagePreviewSlide[] = [];
  let index = 0;
  for (let childIndex = startIndex; childIndex <= endIndex; childIndex += 1) {
    const slide = toSlide(parent.child(childIndex));
    if (!slide) {
      continue;
    }
    if (childIndex < clickedIndex) {
      index += 1;
    }
    slides.push(slide);
  }

  if (slides.length === 0) {
    return null;
  }

  return { slides, index: Math.min(index, slides.length - 1) };
};

export const getImagePreviewGroupFromDom = (view: EditorView, image: HTMLImageElement): ImagePreviewGroup | null => {
  try {
    return getImagePreviewGroup(view, view.posAtDOM(image, 0));
  } catch {
    return null;
  }
};

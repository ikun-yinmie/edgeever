export type OutlineTextSegment = {
  text: string;
  strike: boolean;
};

export type OutlineItem = {
  level: number;
  pos: number;
  text: string;
  segments?: OutlineTextSegment[];
};

export type OutlineTreeItem = OutlineItem & {
  children: OutlineTreeItem[];
};

const mergeAdjacentSegments = (segments: OutlineTextSegment[]): OutlineTextSegment[] => {
  const merged: OutlineTextSegment[] = [];

  for (const segment of segments) {
    if (!segment.text) {
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.strike === segment.strike) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
};

export const sliceOutlineSegments = (
  segments: OutlineTextSegment[],
  start: number,
  end: number
): OutlineTextSegment[] => {
  const sliced: OutlineTextSegment[] = [];
  let offset = 0;

  for (const segment of segments) {
    const segmentStart = offset;
    const segmentEnd = offset + segment.text.length;
    offset = segmentEnd;

    const from = Math.max(start, segmentStart);
    const to = Math.min(end, segmentEnd);
    if (from >= to) {
      continue;
    }

    sliced.push({
      text: segment.text.slice(from - segmentStart, to - segmentStart),
      strike: segment.strike,
    });
  }

  return mergeAdjacentSegments(sliced);
};

export const trimOutlineSegments = (segments: OutlineTextSegment[]): OutlineTextSegment[] => {
  const fullText = segments.map((segment) => segment.text).join("");
  const start = fullText.length - fullText.trimStart().length;
  const end = fullText.trimEnd().length;
  return sliceOutlineSegments(segments, start, end);
};

export const stripLeadingEmoji = (str: string): string => {
  const leadingEmojiRegex = /^(?:(?:[\u0030-\u0039#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|[\u2460-\u24FF\u2600-\u27BF\u2B00-\u2BFF])[\uFE00-\uFE0F\u200D]*\s*)+/u;
  return str.replace(leadingEmojiRegex, "").trim() || str;
};

export const getOutlineDisplaySegments = (item: OutlineItem): OutlineTextSegment[] => {
  const segments = item.segments?.length ? item.segments : [{ text: item.text, strike: false }];
  const fullText = segments.map((segment) => segment.text).join("");
  const displayText = stripLeadingEmoji(fullText);

  if (displayText === fullText) {
    return segments;
  }

  const start = fullText.lastIndexOf(displayText);
  if (start < 0) {
    return [{ text: displayText, strike: false }];
  }

  return sliceOutlineSegments(segments, start, start + displayText.length);
};

export const buildOutlineTree = (items: OutlineItem[]): OutlineTreeItem[] => {
  const roots: OutlineTreeItem[] = [];
  const ancestors: OutlineTreeItem[] = [];

  for (const item of items) {
    const treeItem: OutlineTreeItem = { ...item, children: [] };

    while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= item.level) {
      ancestors.pop();
    }

    const parent = ancestors[ancestors.length - 1];
    if (parent) {
      parent.children.push(treeItem);
    } else {
      roots.push(treeItem);
    }

    ancestors.push(treeItem);
  }

  return roots;
};

/** Positions of headings that own nested headings, in document order. */
export const getOutlineParentPositions = (tree: OutlineTreeItem[]): number[] => {
  const positions: number[] = [];

  const walk = (nodes: OutlineTreeItem[]) => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        positions.push(node.pos);
        walk(node.children);
      }
    }
  };

  walk(tree);
  return positions;
};

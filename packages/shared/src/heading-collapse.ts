import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const HEADING_COLLAPSE_STYLE_ELEMENT_ID = "edgeever-heading-collapse-styles";

export const HEADING_COLLAPSE_CSS = `
.edgeever-heading-collapsible {
  position: relative;
}
[data-edgeever-heading-hidden="true"] {
  display: none !important;
}
.edgeever-heading-collapse-toggle {
  position: absolute;
  top: 50%;
  left: -1.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0.3rem;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 120ms ease, background-color 120ms ease, color 120ms ease;
  -webkit-user-select: none;
  user-select: none;
}
.edgeever-heading-collapsible:hover > .edgeever-heading-collapse-toggle,
.edgeever-heading-collapsible:focus-within > .edgeever-heading-collapse-toggle,
.edgeever-heading-collapsible[data-edgeever-heading-collapsed="true"] > .edgeever-heading-collapse-toggle {
  opacity: 1;
}
.edgeever-heading-collapse-toggle:hover {
  background: rgba(148, 163, 184, 0.2);
  color: #475569;
}
.edgeever-heading-collapse-toggle:focus-visible {
  opacity: 1;
  outline: 2px solid rgba(22, 160, 110, 0.55);
  outline-offset: 1px;
}
.edgeever-heading-collapse-toggle svg {
  pointer-events: none;
  transition: transform 150ms ease;
  transform: rotate(90deg);
}
.edgeever-heading-collapsible[data-edgeever-heading-collapsed="true"] .edgeever-heading-collapse-toggle svg {
  transform: rotate(0deg);
}
.edgeever-heading-collapse-toggle::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 50%;
  bottom: calc(100% + 6px);
  z-index: 30;
  padding: 3px 7px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.9);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: 0;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%);
  transition: opacity 120ms ease;
}
.edgeever-heading-collapse-toggle:hover::after,
.edgeever-heading-collapse-toggle:focus-visible::after {
  opacity: 1;
}
@media (hover: none) {
  .edgeever-heading-collapse-toggle {
    opacity: 0.55;
  }
}
@media (max-width: 640px) {
  .edgeever-heading-collapse-toggle {
    left: -1.1rem;
    width: 1.1rem;
    height: 1.1rem;
  }
}
:root.dark .edgeever-heading-collapse-toggle {
  color: #64748b;
}
:root.dark .edgeever-heading-collapse-toggle:hover {
  background: rgba(51, 65, 85, 0.65);
  color: #34d399;
}
`;

export const injectHeadingCollapseStyles = (
  targetDocument: Document | null = typeof document === "undefined" ? null : document,
) => {
  if (!targetDocument || targetDocument.getElementById(HEADING_COLLAPSE_STYLE_ELEMENT_ID)) {
    return;
  }
  const style = targetDocument.createElement("style");
  style.id = HEADING_COLLAPSE_STYLE_ELEMENT_ID;
  style.textContent = HEADING_COLLAPSE_CSS;
  targetDocument.head.appendChild(style);
};

const HEADING_COLLAPSE_LABELS = {
  "zh-CN": { collapse: "收起", expand: "展开" },
  "en-US": { collapse: "Collapse", expand: "Expand" },
  ja: { collapse: "折りたたむ", expand: "展開" },
} as const;

export type HeadingCollapseLabels = {
  collapse: string;
  expand: string;
};

export type HeadingCollapseOptions = {
  labels?: Partial<HeadingCollapseLabels>;
};

export const resolveHeadingCollapseLabels = (
  locale?: string,
  overrides?: Partial<HeadingCollapseLabels>,
): HeadingCollapseLabels => {
  const normalized = (
    locale
    ?? (typeof document === "undefined" ? "" : document.documentElement.lang)
    ?? ""
  ).toLowerCase();
  const base = normalized.startsWith("zh")
    ? HEADING_COLLAPSE_LABELS["zh-CN"]
    : normalized.startsWith("ja")
      ? HEADING_COLLAPSE_LABELS.ja
      : HEADING_COLLAPSE_LABELS["en-US"];
  return { ...base, ...overrides };
};

export type HeadingFold = {
  pos: number;
  level: number;
  hideFrom: number;
  hideTo: number;
  hasBody: boolean;
  bodyPositions: number[];
};

export const resolveHeadingLevel = (node: ProseMirrorNode | null | undefined): number => {
  if (!node || node.type.name !== "heading") {
    return 0;
  }
  const level = Number(node.attrs.level);
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    return 0;
  }
  return level;
};

export const resolveHeadingFolds = (doc: ProseMirrorNode): HeadingFold[] => {
  const blocks: Array<{ pos: number; node: ProseMirrorNode }> = [];
  doc.forEach((node, offset) => {
    blocks.push({ pos: offset, node });
  });

  const headings = blocks
    .map((block) => ({ ...block, level: resolveHeadingLevel(block.node) }))
    .filter((block) => block.level > 0);

  return headings.map((heading, index) => {
    const nextSibling = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    const hideFrom = heading.pos + heading.node.nodeSize;
    const hideTo = nextSibling ? nextSibling.pos : doc.content.size;
    const bodyPositions = blocks
      .filter((block) => block.pos >= hideFrom && block.pos < hideTo)
      .map((block) => block.pos);

    return {
      pos: heading.pos,
      level: heading.level,
      hideFrom,
      hideTo,
      hasBody: bodyPositions.length > 0,
      bodyPositions,
    };
  });
};

export const selectionTouchesFold = (
  selection: { from: number; to: number },
  fold: Pick<HeadingFold, "hideFrom" | "hideTo">,
) => {
  if (selection.from === selection.to) {
    return selection.from >= fold.hideFrom && selection.from < fold.hideTo;
  }
  return selection.from < fold.hideTo && selection.to > fold.hideFrom;
};

type HeadingCollapseMeta =
  | { type: "toggle"; pos: number }
  | { type: "expand"; positions: readonly number[] };

export type HeadingCollapseState = {
  collapsed: readonly number[];
};

export const headingCollapsePluginKey = new PluginKey<HeadingCollapseState>("edgeeverHeadingCollapse");

export const getCollapsedHeadingPositions = (state: EditorState): readonly number[] =>
  headingCollapsePluginKey.getState(state)?.collapsed ?? [];

const mapCollapsedPositions = (
  collapsed: readonly number[],
  tr: Transaction,
  doc: ProseMirrorNode,
) => {
  const next: number[] = [];
  for (const pos of collapsed) {
    const mapped = tr.mapping.mapResult(pos, 1);
    if (mapped.deleted) {
      continue;
    }
    if (resolveHeadingLevel(doc.nodeAt(mapped.pos)) === 0) {
      continue;
    }
    if (!next.includes(mapped.pos)) {
      next.push(mapped.pos);
    }
  }
  return next.sort((left, right) => left - right);
};

const replacesWholeDocument = (tr: Transaction, previousDoc: ProseMirrorNode) =>
  tr.steps.some((step) =>
    step instanceof ReplaceStep
    && step.from === 0
    && step.to >= previousDoc.content.size
  );

const createToggleIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.appendChild(path);
  return svg;
};

const createToggleButton = ({
  collapsed,
  labels,
  onToggle,
}: {
  collapsed: boolean;
  labels: () => HeadingCollapseLabels;
  onToggle: () => void;
}) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "edgeever-heading-collapse-toggle";
  button.contentEditable = "false";
  button.setAttribute("data-edgeever-heading-collapse-toggle", "true");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.appendChild(createToggleIcon());

  const syncLabel = () => {
    const current = labels();
    const text = collapsed ? current.expand : current.collapse;
    button.setAttribute("aria-label", text);
    button.setAttribute("data-tooltip", text);
  };
  syncLabel();

  button.addEventListener("mouseenter", syncLabel);
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  });

  return button;
};

const toggleFoldAt = (view: EditorView, pos: number) => {
  const node = view.state.doc.nodeAt(pos);
  if (resolveHeadingLevel(node) === 0 || !node) {
    return;
  }
  const collapsed = getCollapsedHeadingPositions(view.state).includes(pos);
  let tr = view.state.tr;
  if (!collapsed) {
    const fold = resolveHeadingFolds(view.state.doc).find((candidate) => candidate.pos === pos);
    if (fold && fold.hasBody && selectionTouchesFold(view.state.selection, fold)) {
      tr = tr.setSelection(TextSelection.create(view.state.doc, pos + node.nodeSize - 1));
    }
  }
  view.dispatch(tr.setMeta(headingCollapsePluginKey, { type: "toggle", pos } satisfies HeadingCollapseMeta));
};

const resolveHiddenBodyPositions = (state: EditorState) => {
  const collapsed = getCollapsedHeadingPositions(state);
  const hidden = new Set<number>();
  if (collapsed.length === 0) {
    return hidden;
  }
  const collapsedSet = new Set(collapsed);
  for (const fold of resolveHeadingFolds(state.doc)) {
    if (!fold.hasBody || !collapsedSet.has(fold.pos)) {
      continue;
    }
    for (const pos of fold.bodyPositions) {
      hidden.add(pos);
    }
  }
  return hidden;
};

export type CreateHeadingCollapsePluginOptions = HeadingCollapseOptions & {
  getView?: () => EditorView | null;
};

export const createHeadingCollapsePlugin = (
  options: CreateHeadingCollapsePluginOptions = {},
) => new Plugin<HeadingCollapseState>({
  key: headingCollapsePluginKey,
  state: {
    init: () => ({ collapsed: [] }),
    apply(tr, value, oldState, newState) {
      let collapsed = replacesWholeDocument(tr, oldState.doc)
        ? []
        : mapCollapsedPositions(value.collapsed, tr, newState.doc);
      const meta = tr.getMeta(headingCollapsePluginKey) as HeadingCollapseMeta | undefined;
      if (meta?.type === "toggle" && resolveHeadingLevel(newState.doc.nodeAt(meta.pos)) > 0) {
        collapsed = collapsed.includes(meta.pos)
          ? collapsed.filter((pos) => pos !== meta.pos)
          : [...collapsed, meta.pos].sort((left, right) => left - right);
      } else if (meta?.type === "expand") {
        const expanded = new Set(meta.positions);
        collapsed = collapsed.filter((pos) => !expanded.has(pos));
      }
      const unchanged = collapsed.length === value.collapsed.length
        && collapsed.every((pos, index) => pos === value.collapsed[index]);
      return unchanged ? value : { collapsed };
    },
  },
  props: {
    decorations(state) {
      const collapsedSet = new Set(getCollapsedHeadingPositions(state));
      const decorations: Decoration[] = [];
      for (const pos of resolveHiddenBodyPositions(state)) {
        const node = state.doc.nodeAt(pos);
        if (node) {
          decorations.push(Decoration.node(pos, pos + node.nodeSize, {
            "data-edgeever-heading-hidden": "true",
          }));
        }
      }
      for (const fold of resolveHeadingFolds(state.doc)) {
        const node = state.doc.nodeAt(fold.pos);
        if (!node) {
          continue;
        }
        const collapsed = collapsedSet.has(fold.pos);
        const attributes: Record<string, string> = {
          class: "edgeever-heading-collapsible",
        };
        if (collapsed) {
          attributes["data-edgeever-heading-collapsed"] = "true";
        }
        decorations.push(Decoration.node(fold.pos, fold.pos + node.nodeSize, attributes));
        if (!fold.hasBody) {
          continue;
        }
        decorations.push(Decoration.widget(
          fold.pos + 1,
          () => createToggleButton({
            collapsed,
            labels: () => resolveHeadingCollapseLabels(undefined, options.labels),
            onToggle: () => {
              const view = options.getView?.();
              if (view) {
                toggleFoldAt(view, fold.pos);
              }
            },
          }),
          { side: -1, ignoreSelection: true },
        ));
      }
      return DecorationSet.create(state.doc, decorations);
    },
  },
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) {
      return null;
    }
    if (!newState.selection.empty) {
      return null;
    }
    const collapsed = getCollapsedHeadingPositions(newState);
    if (collapsed.length === 0) {
      return null;
    }
    const collapsedSet = new Set(collapsed);
    const head = newState.selection.from;
    const positions = resolveHeadingFolds(newState.doc)
      .filter((fold) =>
        fold.hasBody
        && collapsedSet.has(fold.pos)
        && head >= fold.hideFrom
        && head < fold.hideTo
      )
      .map((fold) => fold.pos);
    if (positions.length === 0) {
      return null;
    }
    return newState.tr.setMeta(headingCollapsePluginKey, { type: "expand", positions } satisfies HeadingCollapseMeta);
  },
});

export const createHeadingCollapseExtension = (options: HeadingCollapseOptions = {}) =>
  Extension.create<HeadingCollapseOptions>({
    name: "edgeeverHeadingCollapse",
    addOptions() {
      return {
        labels: {},
      };
    },
    onBeforeCreate() {
      injectHeadingCollapseStyles();
    },
    addProseMirrorPlugins() {
      return [
        createHeadingCollapsePlugin({
          labels: this.options.labels,
          getView: () => this.editor.view,
        }),
      ];
    },
  });

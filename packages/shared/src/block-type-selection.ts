import { Extension, getNodeType, type CommandProps, type Dispatch } from "@tiptap/core";
import type { Attrs, NodeType, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

type BlockRange = {
  from: number;
  to: number;
};

type SelectionRange = {
  $from: ResolvedPos;
  $to: ResolvedPos;
};

const normalizeRange = (range: SelectionRange): BlockRange => {
  let from = range.$from.pos;
  let to = range.$to.pos;
  const { $from, $to } = range;

  if (from >= to) return { from, to };

  if ($from.parent.isTextblock && $from.parentOffset === $from.parent.content.size) {
    from = $from.after($from.depth);
  }

  if ($to.parent.isTextblock && $to.parentOffset === 0) {
    to = $to.before($to.depth);
  }

  return { from, to };
};

export const normalizeBlockTypeRanges = (state: EditorState): BlockRange[] =>
  state.selection.ranges.map((range) => {
    const normalized = normalizeRange(range);
    return normalized.from < normalized.to
      ? normalized
      : { from: range.$from.pos, to: range.$to.pos };
  });

const canSetBlockType = (
  state: EditorState,
  type: NodeType,
  attrs: Attrs | null,
  from: number,
  to: number,
) => {
  let applicable = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (applicable) return false;
    if (!node.isTextblock || node.hasMarkup(type, attrs)) return;
    if (node.type === type) {
      applicable = true;
      return;
    }
    const $pos = state.doc.resolve(pos);
    const index = $pos.index();
    applicable = $pos.parent.canReplaceWith(index, index + 1, type);
  });
  return applicable;
};

const setBlockTypeInRanges = (
  state: EditorState,
  dispatch: Dispatch | undefined,
  type: NodeType,
  attrs: Attrs | null,
  ranges: BlockRange[],
) => {
  const applicable = ranges.some((range) =>
    canSetBlockType(state, type, attrs, range.from, range.to)
  );
  if (!applicable) return false;

  if (dispatch) {
    const tr = state.tr;
    for (const range of ranges) {
      tr.setBlockType(range.from, range.to, type, attrs);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

const setNode = (typeOrName: string | NodeType, attributes: Attrs = {}) =>
  ({ state, chain }: CommandProps) => {
    const type = getNodeType(typeOrName, state.schema);
    const attributesToCopy = state.selection.$anchor.sameParent(state.selection.$head)
      ? state.selection.$anchor.parent.attrs
      : {};
    if (!type.isTextblock) {
      console.warn("[tiptap warn]: Currently \"setNode()\" only supports text block nodes.");
      return false;
    }

    const mergedAttributes = { ...attributesToCopy, ...attributes };
    return chain()
      .command(({ state: currentState, commands }) => {
        if (setBlockTypeInRanges(
          currentState,
          undefined,
          type,
          mergedAttributes,
          normalizeBlockTypeRanges(currentState),
        )) return true;
        return commands.clearNodes();
      })
      .command(({ state: currentState, dispatch: currentDispatch }) =>
        setBlockTypeInRanges(
          currentState,
          currentDispatch,
          type,
          mergedAttributes,
          normalizeBlockTypeRanges(currentState),
        )
      )
      .run();
  };

export const BlockTypeSelection = Extension.create({
  name: "edgeeverBlockTypeSelection",
  priority: 50,
  addCommands() {
    return {
      setNode,
    };
  },
});

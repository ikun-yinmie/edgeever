import type { Mark, Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type CompositionAnchor = {
  paragraphPos: number;
  paragraph: ProseMirrorNode;
  offset: number;
  storedMarks: readonly Mark[] | null;
  cancelled: boolean;
};

const taskItemCompositionKey = new PluginKey("edgeeverTaskItemComposition");

const isTaskTitle = ($pos: ResolvedPos) => $pos.parent.type.name === "paragraph"
  && $pos.depth > 1
  && $pos.node($pos.depth - 1).type.name === "taskItem"
  && $pos.index($pos.depth - 1) === 0;

export const createTaskItemCompositionPlugin = () => {
  let anchor: CompositionAnchor | null = null;
  const clear = () => { anchor = null; };

  const recoverCaret = (view: EditorView) => {
    const source = anchor;
    if (!source?.cancelled || !view.editable || view.composing || !view.hasFocus()) return;
    const paragraph = view.state.doc.nodeAt(source.paragraphPos);
    if (!paragraph?.eq(source.paragraph)) return;
    if (view.nodeDOM(source.paragraphPos)?.textContent !== source.paragraph.textContent) return;

    const position = source.paragraphPos + 1 + source.offset;
    const isFollowingTaskStart = (candidate: number) => {
      if (candidate <= position || candidate > view.state.doc.content.size) return false;
      const $candidate = view.state.doc.resolve(candidate);
      return isTaskTitle($candidate) && $candidate.parentOffset === 0;
    };
    const native = view.dom.ownerDocument.getSelection();
    const nativeMoved = native?.isCollapsed && native.anchorNode && view.dom.contains(native.anchorNode)
      && isFollowingTaskStart(view.posAtDOM(native.anchorNode, native.anchorOffset));
    const stateMoved = view.state.selection.empty && isFollowingTaskStart(view.state.selection.from);
    if (!nativeMoved && !stateMoved) return;

    // A cancelled preedit must not transfer the next keystroke to another task.
    clear();
    view.dispatch(view.state.tr
      .setSelection(TextSelection.create(view.state.doc, position))
      .setStoredMarks(source.storedMarks)
      .setMeta("addToHistory", false));
    view.focus();
  };

  let scheduled = false;
  const scheduleRecovery = (view: EditorView) => {
    if (scheduled || !anchor?.cancelled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!view.isDestroyed) recoverCaret(view);
    });
  };

  return new Plugin({
    key: taskItemCompositionKey,
    appendTransaction: (transactions) => {
      for (const tr of transactions) {
        if (!anchor || !tr.docChanged) continue;
        const mapped = tr.mapping.mapResult(anchor.paragraphPos, 1);
        anchor = mapped.deleted ? null : { ...anchor, paragraphPos: mapped.pos };
      }
      return null;
    },
    props: {
      handleDOMEvents: {
        compositionstart: (view) => {
          recoverCaret(view);
          const { selection } = view.state;
          if (!view.editable || !selection.empty || !isTaskTitle(selection.$from)) {
            clear();
            return false;
          }
          anchor = {
            paragraphPos: selection.$from.before(),
            paragraph: selection.$from.parent,
            offset: selection.$from.parentOffset,
            storedMarks: view.state.storedMarks,
            cancelled: false,
          };
          return false;
        },
        compositionend: (view, event) => {
          if (anchor) {
            anchor = event.data === "" ? { ...anchor, cancelled: true } : null;
            scheduleRecovery(view);
          }
          return false;
        },
        beforeinput: (view, event) => {
          if (anchor?.cancelled) {
            recoverCaret(view);
            if (event.inputType.startsWith("insert")) clear();
            else scheduleRecovery(view);
          }
          return false;
        },
        blur: () => {
          clear();
          return false;
        },
      },
    },
    view: (view) => {
      const document = view.dom.ownerDocument;
      const pointerIntent = () => clear();
      const keyboardIntent = (event: KeyboardEvent) => {
        if (!anchor) return;
        if (anchor.cancelled) {
          if (view.dom.contains(event.target as Node | null)) recoverCaret(view);
          clear();
        } else if (!view.composing && !event.isComposing && event.keyCode !== 229
          && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Tab)$/.test(event.key)) {
          clear();
        }
      };
      const selectionChanged = () => scheduleRecovery(view);
      document.addEventListener("pointerdown", pointerIntent, true);
      document.addEventListener("keydown", keyboardIntent, true);
      document.addEventListener("selectionchange", selectionChanged);
      return {
        update: () => scheduleRecovery(view),
        destroy: () => {
          clear();
          document.removeEventListener("pointerdown", pointerIntent, true);
          document.removeEventListener("keydown", keyboardIntent, true);
          document.removeEventListener("selectionchange", selectionChanged);
        },
      };
    },
  });
};

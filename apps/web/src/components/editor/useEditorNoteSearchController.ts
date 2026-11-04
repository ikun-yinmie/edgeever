import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Editor } from "@tiptap/react";
import {
  CLOSED_NOTE_SEARCH_STATE,
  createNoteSearchHighlightPlugin,
  formatNoteSearchMatchLabel,
  getNextSearchMatchIndex,
  getSearchMatchesFromDocument,
  getSearchNavigationIdentity,
  NOTE_SEARCH_HIGHLIGHT_PLUGIN_KEY,
  shouldResetNoteSearchForMemoChange,
  type NoteSearchMatch,
} from "./note-search";

type EditorNoteSearchControllerOptions = {
  contentSearchQuery: string;
  hydratedMemoId: string | null;
  editor: Editor | null;
  editorInstanceKey: string | null;
  editorScrollContainerRef: RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  replaceFocusToken: number;
  searchFocusToken: number;
  memoId: string | null;
};

const isEditorReady = (editor: Editor | null | undefined): editor is Editor =>
  Boolean(editor && !editor.isDestroyed && (editor as { extensionManager?: unknown }).extensionManager);

export const useEditorNoteSearchController = ({
  contentSearchQuery,
  hydratedMemoId,
  editor,
  editorInstanceKey,
  editorScrollContainerRef,
  memoId,
  readOnly,
  replaceFocusToken,
  searchFocusToken,
}: EditorNoteSearchControllerOptions) => {
  const [noteSearchOpen, setNoteSearchOpen] = useState(false);
  const [noteSearchQuery, setNoteSearchQuery] = useState("");
  const [noteSearchReplaceOpen, setNoteSearchReplaceOpen] = useState(false);
  const [noteSearchReplacement, setNoteSearchReplacement] = useState("");
  const [noteSearchIndex, setNoteSearchIndex] = useState(0);
  const noteSearchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContextRef = useRef({ noteSearchOpen, contentSearchQuery });
  searchContextRef.current = { noteSearchOpen, contentSearchQuery };
  const automaticSelectionRef = useRef<{ editor: Editor; identity: string } | null>(null);
  const navigationRequestRef = useRef(0);
  const previousEditorInstanceKeyRef = useRef(editorInstanceKey);
  // Reset on a real note switch, not when desktop sync remaps a local id.
  // The editor instance key stays stable across that handoff.
  if (shouldResetNoteSearchForMemoChange(previousEditorInstanceKeyRef.current, editorInstanceKey)) {
    previousEditorInstanceKeyRef.current = editorInstanceKey;
    setNoteSearchOpen(CLOSED_NOTE_SEARCH_STATE.open);
    setNoteSearchQuery(CLOSED_NOTE_SEARCH_STATE.query);
    setNoteSearchReplaceOpen(CLOSED_NOTE_SEARCH_STATE.replaceOpen);
    setNoteSearchReplacement(CLOSED_NOTE_SEARCH_STATE.replacement);
    setNoteSearchIndex(CLOSED_NOTE_SEARCH_STATE.index);
  }

  const searchDocument = isEditorReady(editor) && hydratedMemoId === memoId
    ? editor.state.doc
    : null;
  const noteSearchMatches = useMemo(
    () => searchDocument ? getSearchMatchesFromDocument(searchDocument, noteSearchQuery) : [],
    [searchDocument, noteSearchQuery],
  );
  const contentSearchMatches = useMemo(
    () => searchDocument ? getSearchMatchesFromDocument(searchDocument, contentSearchQuery) : [],
    [searchDocument, contentSearchQuery],
  );
  const activeQuery = noteSearchOpen ? noteSearchQuery : contentSearchQuery;
  const activeMatches = noteSearchOpen ? noteSearchMatches : contentSearchMatches;

  const selectMatch = useCallback(
    (index: number, matches: NoteSearchMatch[]) => {
      const match = matches[index];

      if (!isEditorReady(editor) || !match) {
        return;
      }

      const document = editor.state.doc;
      const requestId = ++navigationRequestRef.current;
      editor.chain().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run();

      window.requestAnimationFrame(() => {
        const scrollContainer = editorScrollContainerRef.current;
        if (
          !scrollContainer
          || !isEditorReady(editor)
          || requestId !== navigationRequestRef.current
          || editor.state.doc !== document
        ) {
          return;
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const nodeRect = editor.view.coordsAtPos(match.from);
        const padding = 24;
        const isAbove = nodeRect.top < containerRect.top + padding;
        const isBelow = nodeRect.bottom > containerRect.bottom - padding;

        if (isAbove || isBelow) {
          const targetTop = scrollContainer.scrollTop + nodeRect.top - containerRect.top
            - (scrollContainer.clientHeight - (nodeRect.bottom - nodeRect.top)) / 2;
          scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
        }
      });
    },
    [editor, editorScrollContainerRef],
  );

  useEffect(() => {
    if (!isEditorReady(editor)) {
      return;
    }

    const searchHighlightPlugin = createNoteSearchHighlightPlugin({
      getQuery: () => activeQuery,
      getActiveIndex: () => noteSearchIndex,
    });

    editor.registerPlugin(searchHighlightPlugin);

    return () => {
      if (isEditorReady(editor)) {
        editor.unregisterPlugin(NOTE_SEARCH_HIGHLIGHT_PLUGIN_KEY);
      }
    };
  }, [activeQuery, editor, noteSearchIndex]);

  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      noteSearchInputRef.current?.focus();
      noteSearchInputRef.current?.select();
    });
  }, [noteSearchInputRef]);

  const openSearch = useCallback((showReplace = false) => {
    const context = searchContextRef.current;
    if (!context.noteSearchOpen && context.contentSearchQuery.trim()) {
      setNoteSearchQuery(context.contentSearchQuery);
    }
    setNoteSearchOpen(true);
    setNoteSearchReplaceOpen(showReplace);
    focusSearchInput();
  }, [focusSearchInput]);

  const openFromSelection = useCallback((text: string, showReplace = false) => {
    setNoteSearchQuery(text);
    setNoteSearchOpen(true);
    setNoteSearchReplaceOpen(showReplace);
    focusSearchInput();
  }, [focusSearchInput]);

  const openWithQuery = useCallback((query: string) => {
    setNoteSearchQuery(query);
    setNoteSearchIndex(0);
    setNoteSearchReplaceOpen(false);
    setNoteSearchOpen(true);
    window.requestAnimationFrame(() => noteSearchInputRef.current?.focus());
  }, []);

  const closeReplace = useCallback(() => {
    setNoteSearchReplaceOpen(false);
  }, []);

  const openReplace = useCallback(() => {
    if (readOnly) return;
    openSearch(true);
  }, [openSearch, readOnly]);

  const closeSearch = useCallback(() => {
    setNoteSearchOpen(false);
    if (isEditorReady(editor)) {
      editor.commands.focus();
    }
  }, [editor, setNoteSearchOpen]);

  useEffect(() => {
    if (!noteSearchOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    };

    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [closeSearch, noteSearchOpen]);

  const moveMatch = useCallback((direction: 1 | -1) => {
    if (activeMatches.length === 0) {
      return;
    }

    const next = getNextSearchMatchIndex(noteSearchIndex, direction, activeMatches.length);
    setNoteSearchIndex(next);
    selectMatch(next, activeMatches);
  }, [activeMatches, noteSearchIndex, selectMatch]);

  useEffect(() => {
    if (searchFocusToken !== 0) {
      openSearch();
    }
  }, [openSearch, searchFocusToken]);

  useEffect(() => {
    if (replaceFocusToken !== 0) {
      openReplace();
    }
  }, [openReplace, replaceFocusToken]);

  useEffect(() => {
    if (!isEditorReady(editor) || !searchDocument) {
      return;
    }

    const source = noteSearchOpen ? "note" : "content";
    const identity = getSearchNavigationIdentity(memoId, source, activeQuery);
    const previousSelection = automaticSelectionRef.current;

    if (previousSelection?.editor === editor && previousSelection.identity === identity) {
      return;
    }

    automaticSelectionRef.current = { editor, identity };
    setNoteSearchIndex(0);

    if (activeMatches[0]) {
      selectMatch(0, activeMatches);
    }
  }, [
    activeMatches,
    activeQuery,
    editor,
    memoId,
    noteSearchOpen,
    searchDocument,
    selectMatch,
    setNoteSearchIndex,
  ]);

  useEffect(() => {
    setNoteSearchIndex((current) => activeMatches.length === 0
      ? 0
      : Math.min(current, activeMatches.length - 1));
  }, [activeMatches.length, setNoteSearchIndex]);

  const replaceAllMatches = useCallback(() => {
    if (!isEditorReady(editor) || readOnly || noteSearchMatches.length === 0) {
      return;
    }

    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        for (const match of [...noteSearchMatches].reverse()) {
          tr.insertText(noteSearchReplacement, match.from, match.to);
        }

        dispatch?.(tr);
        return true;
      })
      .run();

    setNoteSearchIndex(0);
    window.requestAnimationFrame(() => noteSearchInputRef.current?.focus());
  }, [
    editor,
    noteSearchInputRef,
    noteSearchMatches,
    noteSearchReplacement,
    readOnly,
    setNoteSearchIndex,
  ]);

  return {
    closeReplace,
    closeSearch,
    inputRef: noteSearchInputRef,
    matchLabel: formatNoteSearchMatchLabel(
      activeQuery,
      noteSearchIndex,
      activeMatches.length,
    ),
    matches: activeMatches,
    moveMatch,
    openFromSelection,
    openReplace,
    openSearch,
    openWithQuery,
    query: activeQuery,
    replaceAllMatches,
    replaceOpen: noteSearchReplaceOpen,
    replacement: noteSearchReplacement,
    searchOpen: noteSearchOpen,
    setQuery: setNoteSearchQuery,
    setReplacement: setNoteSearchReplacement,
  };
};

import "katex/dist/katex.min.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor } from "@tiptap/react";
import { PdfAttachment } from "@/components/editor/PdfAttachment";
import { FileAttachment } from "@/components/editor/FileAttachment";
import { CollapsibleTaskItem } from "@/components/editor/CollapsibleTaskItem";
import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { createExcerpt, createEdgeEverDocumentExtensions, docToMarkdown, docToText, emptyDoc, getImageReferrerPolicy, isPdfAttachment, wrapDetailsContentHtml, type MemoDetail, type MemoEditSession, type Notebook, type TagSummary, type TiptapDoc } from "@edgeever/shared";
import { createEdgeEverMathematics } from "@edgeever/shared/mathematics";
import { getMobileEditorInputAttributes, getMobileEditorPlaceholder } from "@edgeever/shared/mobile-editor";
import { EdgeEverLink } from "@edgeever/shared/editor-link";
import { createInlineFieldExtension } from "@/components/editor/InlineField";
import {
  MobileEditorFallback,
  MobileEditorHeader,
  MobileEditorNotebookButton,
  MobileEditorNotebookSheet,
  MobileEditorToolbar,
} from "@/components/MobileStandaloneEditorParts";
import { EDITOR_LOCAL_SAVE_DELAY_MS, getEditableMemoTitle, getNotebookMoveOptions } from "@/lib/app-helpers";
import { defaultLocale, normalizeLocale } from "@/i18n/locales";
import { compressImageForUpload } from "@/lib/image-compression";
import { localDb, type LocalDraft, type MemoUpdateSyncPayload } from "@/lib/local-db";
import {
  getStandaloneMobileEditorReturnPath,
  getStandaloneMobileEditorScope,
  markStandaloneMobileEditorReturning,
  writeMobileEditorReturnPreview,
} from "@/lib/mobile-editor";
import {
  MOBILE_EDITOR_INITIAL_FOCUS_DELAY_MS,
  getMobileEditorDraftKey,
  getMobileEditorParams,
  getMobileEditorStatusClassName,
  normalizeMobileEditorDoc,
  parseMobileEditorTags,
  requestMobileEditorJson,
  uploadMobileEditorResource,
  type MobileEditorDraft,
  type MobileEditorMemoResponse,
  type MobileEditorSaveState,
} from "@/lib/mobile-editor-standalone";
import { getMemoUpdateQueueId, isMemoUpdateAlreadyApplied, queueMemoUpdate, shouldQueueMemoSaveError } from "@/lib/sync-queue";
import { createMarkdownImagePasteRule } from "@/lib/markdown-image-paste";
import {
  handleConsecutiveListEnter,
  insertListItemChildParagraph,
  isSelectionInsideListItem,
  preserveEmptyListIndentOnBackspace,
  sinkListItemPreservingAttrs,
  splitTaskItemWithoutInheritedMarks,
  toggleTaskItemCollapseAtSelection,
  wrapIndentedParagraphInList,
} from "@/lib/editor-shortcuts";
import { parseImageWidth, TASK_ITEM_DEFAULT_IMAGE_WIDTH_PERCENT } from "@edgeever/shared/image-display";
import { ThemeBlock } from "./ThemeBlock";
import { EditorTagPicker } from "./EditorTagPicker";
import { cacheSavedLocalMemo, listLocalTags } from "@/lib/local-mirror";
import { writeEditorScrollMemory } from "@/components/editor/editor-scroll-memory";

const ProtectedExternalImage = Image.extend({
  addPasteRules() {
    return [createMarkdownImagePasteRule(this.type)];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => parseImageWidth(
          element.getAttribute("data-width") ?? element.getAttribute("width") ?? element.style.width,
        ),
        renderHTML: (attributes) => {
          const width = parseImageWidth(attributes.width);
          return width ? { "data-width": String(width), style: `width: ${width}%` } : {};
        },
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const referrerPolicy = getImageReferrerPolicy(HTMLAttributes.src);
    return [
      "img",
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        referrerPolicy ? { referrerpolicy: referrerPolicy } : {},
      ),
    ];
  },
});

type ListNotebooksResponse = {
  notebooks: Notebook[];
};

/**
 * Cross-client freshness for the standalone editor. The workspace page cannot
 * help here: this document has its own Tiptap instance and edit session.
 */
const MOBILE_EDITOR_REMOTE_POLL_MS = 5_000;
const MOBILE_EDITOR_REMOTE_POLL_TIMEOUT_MS = 8_000;
/** IndexedDB is normally instant but can stall on iOS; never await it unbounded. */
const MOBILE_EDITOR_LOCAL_STORE_TIMEOUT_MS = 2_500;

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number) => {
  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
};

/**
 * The workspace preview reads the local mirror, not this editor's state. Mirror
 * every memo the server confirms here so Done returns to the edited snapshot
 * instead of the pre-edit one. Mirroring is a cache write: a stall or failure
 * must never turn a successful save into an error.
 */
const cacheSavedMemoInMirror = async (memo: MemoDetail) => {
  const scope = getStandaloneMobileEditorScope();
  if (!scope) {
    return;
  }
  try {
    await withTimeout(cacheSavedLocalMemo(scope, memo), MOBILE_EDITOR_LOCAL_STORE_TIMEOUT_MS);
  } catch {
    // Best effort: the save itself already reaches the server.
  }
};

type MobileStandaloneTiptapEditorProps = {
  memoId?: string | null;
  onLeave?: () => void;
};

export const MobileStandaloneTiptapEditor = ({
  memoId: memoIdProp,
  onLeave,
}: MobileStandaloneTiptapEditorProps = {}) => {
  const params = useMemo(() => getMobileEditorParams(), []);
  const { t, i18n } = useTranslation();
  const memoId = memoIdProp ?? params.get("memoId");
  const locale = normalizeLocale(i18n.resolvedLanguage ?? i18n.language) ?? defaultLocale;
  const draftKey = getMobileEditorDraftKey(memoId);
  const [memo, setMemo] = useState<MemoDetail | null>(null);
  const memoRef = useRef<MemoDetail | null>(null);
  const editSessionRef = useRef<MemoEditSession | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookUpdatePending, setNotebookUpdatePending] = useState(false);
  const [notebookSheetOpen, setNotebookSheetOpen] = useState(false);
  const [title, setTitle] = useState("");
  const titleRef = useRef("");
  const [tagsText, setTagsText] = useState("");
  const tagsTextRef = useRef("");
  const contentJsonRef = useRef<TiptapDoc>(emptyDoc());
  const [saveState, setSaveState] = useState<MobileEditorSaveState>("loading");
  const saveStateRef = useRef<MobileEditorSaveState>("loading");
  const [leavePending, setLeavePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notebookOptions = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const [, setToolbarVersion] = useState(0);
  const dirtyRef = useRef(false);
  const leavingRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const initialFocusTimerRef = useRef<number | null>(null);
  const currentSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const lastSavedSnapshotRef = useRef("");
  const backgroundSavePendingRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const setSaveStateStable = useCallback((nextState: MobileEditorSaveState) => {
    if (saveStateRef.current === nextState) {
      return;
    }

    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  const currentSnapshot = useCallback(
    () =>
      JSON.stringify({
        title: titleRef.current,
        tagsText: tagsTextRef.current,
        contentJson: contentJsonRef.current,
      }),
    []
  );

  const persistLocalDraft = useCallback(() => {
    if (!draftKey) {
      return;
    }

    const currentMemo = memoRef.current;
    const draft: MobileEditorDraft = {
      expectedRevision: currentMemo?.revision,
      title: titleRef.current,
      tagsText: tagsTextRef.current,
      contentJson: contentJsonRef.current,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(draftKey, JSON.stringify(draft));

    if (!currentMemo || currentMemo.isDeleted) {
      return;
    }

    void localDb.drafts.put({
      memoId: currentMemo.id,
      expectedRevision: currentMemo.revision,
      title: draft.title,
      tagsText: draft.tagsText,
      contentJson: draft.contentJson,
      updatedAt: draft.updatedAt,
    });
  }, [draftKey]);

  const readLocalDraft = useCallback((): MobileEditorDraft | null => {
    if (!draftKey) {
      return null;
    }

    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? (JSON.parse(raw) as MobileEditorDraft) : null;
    } catch {
      return null;
    }
  }, [draftKey]);

  const readBestLocalDraft = useCallback(async (): Promise<MobileEditorDraft | null> => {
    const browserDraft = readLocalDraft();
    const persistedDraft = memoId ? await localDb.drafts.get(memoId).catch(() => null) : null;
    const drafts = [browserDraft, persistedDraft].filter(Boolean) as Array<MobileEditorDraft | LocalDraft>;

    if (drafts.length === 0) {
      return null;
    }

    const latest = drafts.reduce((current, candidate) =>
      Date.parse(candidate.updatedAt || "") > Date.parse(current.updatedAt || "") ? candidate : current
    );

    return {
      expectedRevision: latest.expectedRevision,
      title: latest.title,
      tagsText: latest.tagsText,
      contentJson: latest.contentJson,
      updatedAt: latest.updatedAt,
    };
  }, [memoId, readLocalDraft]);

  const inlineFieldExtension = useMemo(() => createInlineFieldExtension(locale), [locale]);
  const editor = useEditor({
    extensions: [
      ...createEdgeEverDocumentExtensions({
        mathematics: createEdgeEverMathematics(),
        starterKit: { link: false },
        image: ProtectedExternalImage.configure({
          allowBase64: false,
          inline: false,
        }),
        taskItem: CollapsibleTaskItem.configure({ nested: true }),
        pdf: PdfAttachment,
        file: FileAttachment,
        table: { table: { renderWrapper: true } },
      }),
      EdgeEverLink,
      inlineFieldExtension,
      ThemeBlock,
      Placeholder.configure({
        placeholder: getMobileEditorPlaceholder(locale),
      }),
    ],
    content: emptyDoc(),
    editorProps: {
      attributes: getMobileEditorInputAttributes("edgeever-mobile-tiptap-content"),
      transformPastedHTML: (html) => wrapDetailsContentHtml(html),
      handleDOMEvents: {
        keydown: (view, event) => view.composing || event.isComposing || event.keyCode === 229,
      },
      handleKeyDown: (view, event) => {
        if (!view.editable || view.composing || event.isComposing || event.keyCode === 229) return false;
        if (event.key === "Backspace" && preserveEmptyListIndentOnBackspace(view.state, view.dispatch)) {
          event.preventDefault();
          return true;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (handleConsecutiveListEnter(view.state, view.dispatch)) {
            event.preventDefault();
            return true;
          }
          if (splitTaskItemWithoutInheritedMarks(view.state, view.dispatch)) {
            event.preventDefault();
            return true;
          }
        }
        if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (insertListItemChildParagraph(view.state, view.dispatch)) {
            event.preventDefault();
            return true;
          }
        }
        if (event.key === "Tab") {
          if (view.state.selection.$from.parent.type.spec.code) return false;
          if (!event.shiftKey) {
            if (wrapIndentedParagraphInList(view.state, view.dispatch)) {
              event.preventDefault();
              return true;
            }
            if (sinkListItemPreservingAttrs(view.state, view.dispatch)) {
              event.preventDefault();
              return true;
            }
          }
          // A task's sub-block (attachment line, note under the title) has no
          // list to indent into. Swallow Tab so focus stays in the editor; it
          // must never spawn a task at the first child position.
          if (isSelectionInsideListItem(view.state)) {
            event.preventDefault();
            return true;
          }
        }
        if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === "t") {
          if (toggleTaskItemCollapseAtSelection(view.state, view.dispatch)) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      contentJsonRef.current = activeEditor.getJSON() as TiptapDoc;
      dirtyRef.current = true;
      persistLocalDraft();

      if (saveStateRef.current !== "dirty") {
        setSaveStateStable("dirty");
      }

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void saveNowRef.current();
      }, EDITOR_LOCAL_SAVE_DELAY_MS);
    },
  });

  const saveNowRef = useRef<({ keepalive }?: { keepalive?: boolean }) => Promise<boolean>>(async () => false);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const refreshToolbar = () => setToolbarVersion((version) => version + 1);

    editor.on("selectionUpdate", refreshToolbar);
    editor.on("transaction", refreshToolbar);
    editor.on("focus", refreshToolbar);
    editor.on("blur", refreshToolbar);

    return () => {
      editor.off("selectionUpdate", refreshToolbar);
      editor.off("transaction", refreshToolbar);
      editor.off("focus", refreshToolbar);
      editor.off("blur", refreshToolbar);
    };
  }, [editor]);

  useEffect(() => {
    memoRef.current = memo;
  }, [memo]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    tagsTextRef.current = tagsText;
  }, [tagsText]);

  const clearPersistedDrafts = useCallback(async (memoId: string) => {
    if (draftKey) {
      localStorage.removeItem(draftKey);
    }

    await Promise.all([
      localDb.drafts.delete(memoId),
      localDb.syncQueue.delete(getMemoUpdateQueueId(memoId)),
    ]);
  }, [draftKey]);

  const buildSavePayload = useCallback((currentMemo: MemoDetail) => {
    const editSession = editSessionRef.current;
    if (!editSession || editSession.memoId !== currentMemo.id) {
      throw new Error(t("editor.saveState.error"));
    }

    return {
      expectedRevision: currentMemo.revision,
      expectedContentHash: currentMemo.contentHash,
      editSessionId: editSession.id,
      title: titleRef.current,
      contentJson: contentJsonRef.current,
      tags: parseMobileEditorTags(tagsTextRef.current),
    };
  }, []);

  const applySavedMemo = useCallback(async (savedMemo: MemoDetail, savedSnapshot: string) => {
    memoRef.current = savedMemo;
    if (editSessionRef.current) {
      editSessionRef.current = {
        ...editSessionRef.current,
        baseRevision: savedMemo.revision,
        baseContentHash: savedMemo.contentHash,
      };
    }
    setMemo(savedMemo);
    backgroundSavePendingRef.current = false;
    lastSavedSnapshotRef.current = savedSnapshot;

    if (currentSnapshot() === savedSnapshot) {
      dirtyRef.current = false;
      await withTimeout(clearPersistedDrafts(savedMemo.id), MOBILE_EDITOR_LOCAL_STORE_TIMEOUT_MS);
      // Do this after the queue entry is gone so the mirror accepts the save.
      await cacheSavedMemoInMirror(savedMemo);
      setSaveStateStable("saved");
      window.setTimeout(() => {
        if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
          setSaveStateStable("idle");
        }
      }, 1200);
      return;
    }

    dirtyRef.current = true;
    persistLocalDraft();
    setSaveStateStable("dirty");
  }, [clearPersistedDrafts, currentSnapshot, persistLocalDraft, setSaveStateStable]);

  const sendBackgroundSave = useCallback(() => {
    const currentMemo = memoRef.current;
    if (!currentMemo || currentMemo.isDeleted || !dirtyRef.current) {
      return false;
    }

    const path = `/api/v1/memos/${encodeURIComponent(currentMemo.id)}/save`;
    const payload = buildSavePayload(currentMemo);
    const body = JSON.stringify(payload);
    const snapshot = currentSnapshot();

    // A direct save supersedes an older retry for this memo. The local draft remains
    // durable until the server response is confirmed, so removing the retry cannot
    // lose the user's latest text even if the page is suspended immediately after.
    void localDb.syncQueue.delete(getMemoUpdateQueueId(currentMemo.id));

    if (typeof navigator.sendBeacon === "function") {
      const accepted = navigator.sendBeacon(path, new Blob([body], { type: "application/json" }));

      if (accepted) {
        backgroundSavePendingRef.current = true;
        return true;
      }
    }

    void requestMobileEditorJson<MobileEditorMemoResponse>(path, {
      method: "POST",
      keepalive: true,
      body,
    })
      .then((data) => applySavedMemo(data.memo, snapshot))
      .catch((saveError) => {
        persistLocalDraft();
        if (shouldQueueMemoSaveError(saveError)) {
          void queueMemoUpdate({ memoId: currentMemo.id, ...payload });
        }
        setSaveStateStable("local-draft");
      });

    return true;
  }, [applySavedMemo, buildSavePayload, currentSnapshot, persistLocalDraft, setSaveStateStable]);

  const reconcileBackgroundSave = useCallback(async () => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !backgroundSavePendingRef.current) {
      return;
    }

    try {
      const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(currentMemo.id)}`);
      const remoteSnapshot = JSON.stringify({
        title: data.memo.title || "",
        tagsText: Array.isArray(data.memo.tags) ? data.memo.tags.join(", ") : "",
        contentJson: normalizeMobileEditorDoc(data.memo),
      });

      memoRef.current = data.memo;
      setMemo(data.memo);
      void cacheSavedMemoInMirror(data.memo);
      backgroundSavePendingRef.current = false;

      if (remoteSnapshot === currentSnapshot()) {
        lastSavedSnapshotRef.current = remoteSnapshot;
        dirtyRef.current = false;
        await clearPersistedDrafts(data.memo.id);
        setSaveStateStable("saved");
        return;
      }

      dirtyRef.current = true;
      persistLocalDraft();
      void saveNowRef.current();
    } catch {
      persistLocalDraft();
      setSaveStateStable("local-draft");
    }
  }, [clearPersistedDrafts, currentSnapshot, persistLocalDraft, setSaveStateStable]);

  const saveNow = useCallback(
    ({ keepalive = false }: { keepalive?: boolean } = {}): Promise<boolean> => {
      if (currentSavePromiseRef.current) {
        return currentSavePromiseRef.current;
      }

      const currentMemo = memoRef.current;
      if (!currentMemo) {
        return Promise.resolve(false);
      }

      const snapshot = currentSnapshot();
      if (!dirtyRef.current && snapshot === lastSavedSnapshotRef.current) {
        // Done without edits still has to leave the mirror at the revision this
        // editor loaded, or the preview would show an older mirrored copy.
        return cacheSavedMemoInMirror(currentMemo).then(() => true);
      }

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      savingRef.current = true;
      setSaveStateStable("saving");
      setError(null);

      // Share the entire save operation, including queue cleanup and error handling,
      // so Done can wait for an autosave without missing its result.
      const savePromise = (async () => {
        let payload: ReturnType<typeof buildSavePayload> | null = null;
        try {
          payload = buildSavePayload(currentMemo);
          await withTimeout(
            localDb.syncQueue.delete(getMemoUpdateQueueId(currentMemo.id)).catch(() => undefined),
            MOBILE_EDITOR_LOCAL_STORE_TIMEOUT_MS,
          );
          const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(currentMemo.id)}`, {
            method: "PATCH",
            keepalive,
            body: JSON.stringify(payload),
          });

          await applySavedMemo(data.memo, snapshot);
          return true;
        } catch (saveError) {
          persistLocalDraft();
          setError(saveError instanceof Error ? saveError.message : t("editor.saveState.error"));
          if (payload && shouldQueueMemoSaveError(saveError)) {
            await queueMemoUpdate({ memoId: currentMemo.id, ...payload });
            setSaveStateStable("local-draft");
            return false;
          }

          setSaveStateStable("error");
          return false;
        }
      })();

      currentSavePromiseRef.current = savePromise.catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : t("editor.saveState.error"));
        setSaveStateStable("error");
        return false;
      }).finally(() => {
        savingRef.current = false;
        currentSavePromiseRef.current = null;
      });
      return currentSavePromiseRef.current;
    },
    [applySavedMemo, buildSavePayload, currentSnapshot, persistLocalDraft, setSaveStateStable, t]
  );

  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  const scheduleMetadataSave = useCallback(() => {
    dirtyRef.current = true;
    persistLocalDraft();
    setSaveStateStable("dirty");

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, EDITOR_LOCAL_SAVE_DELAY_MS);
  }, [persistLocalDraft, saveNow, setSaveStateStable]);

  const persistReturnPreview = useCallback(() => {
    const currentMemo = memoRef.current;
    if (!currentMemo) {
      return;
    }

    // The preview restores this memo's scroll memory on the way back. Record
    // the editor's own position: the entry the preview wrote is where the user
    // left the reading screen, not where they edited.
    const scroller = document.scrollingElement;
    const scrollHeight = Math.max(0, scroller?.scrollHeight ?? document.body.scrollHeight);
    const scrollTop = Math.max(0, window.scrollY || scroller?.scrollTop || 0);
    const maxScrollTop = Math.max(0, scrollHeight - window.innerHeight);
    writeEditorScrollMemory(currentMemo.id, {
      progress: maxScrollTop > 0 ? Math.min(1, Math.max(0, scrollTop / maxScrollTop)) : 0,
      scrollHeight,
      scrollTop,
      updatedAt: Date.now(),
    });

    writeMobileEditorReturnPreview({
      memoId: currentMemo.id,
      baseRevision: currentMemo.revision,
      title: titleRef.current || null,
      excerpt: createExcerpt(docToText(contentJsonRef.current)),
      tags: parseMobileEditorTags(tagsTextRef.current),
      updatedAt: dirtyRef.current ? new Date().toISOString() : currentMemo.updatedAt,
    });
  }, []);

  const navigateBack = useCallback(() => {
    persistReturnPreview();
    markStandaloneMobileEditorReturning(memoId);

    if (onLeave) {
      onLeave();
      return;
    }

    window.location.replace(memoId ? getStandaloneMobileEditorReturnPath(memoId) : "/");
  }, [memoId, onLeave, persistReturnPreview]);

  const leavePageAttemptRef = useRef(0);
  // Resolved by a second tap on ‹ while Done is still waiting for the server.
  const escapeLeaveRef = useRef<(() => void) | null>(null);

  /**
   * Two intents share this path:
   * - "done" waits for a real save and stays put when it fails, so the error is
   *   visible and the edit can be retried.
   * - "back" is an escape hatch: the draft is written synchronously first, so it
   *   navigates immediately instead of waiting on a slow or unreachable server.
   *   A disabled/queued draft is recovered the next time this note is opened.
   */
  const leavePage = useCallback(async (intent: "done" | "back" = "done") => {
    if (leavingRef.current) {
      if (intent === "back") escapeLeaveRef.current?.();
      return;
    }
    if (intent === "done" && (notebookUpdatePending || saveStateRef.current === "compressing" || saveStateRef.current === "uploading")) {
      return;
    }
    if (!memoRef.current) {
      navigateBack();
      return;
    }

    leavingRef.current = true;
    setLeavePending(true);
    const wasEditable = Boolean(editor?.isEditable);
    editor?.commands.blur();
    editor?.setEditable(false, false);
    const attempt = (leavePageAttemptRef.current += 1);
    let releaseEscape!: () => void;
    const escapePromise = new Promise<"escape">((resolve) => {
      releaseEscape = () => resolve("escape");
    });
    escapeLeaveRef.current = releaseEscape;

    const leaveWithDraft = () => {
      persistLocalDraft();
      try {
        sendBackgroundSave();
      } catch {
        // Missing edit session: the draft is still durable.
      }
      navigateBack();
    };

    try {
      if (editor && !editor.isDestroyed) {
        contentJsonRef.current = editor.getJSON() as TiptapDoc;
      }
      const hasUnsavedEdits = dirtyRef.current || currentSnapshot() !== lastSavedSnapshotRef.current;
      if (hasUnsavedEdits) {
        persistLocalDraft();
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (intent === "back") {
        leaveWithDraft();
        return;
      }

      setSaveStateStable("leaving");

      // An in-flight autosave may only contain an earlier snapshot. Flush the
      // latest edits too, and never navigate after a timeout or a failed save.
      // The loop is bounded so a non-converging body cannot hold the header in
      // "leaving" forever, and ‹ can abandon the wait at any point.
      let converged = false;
      for (let round = 0; round < 3 && !converged; round += 1) {
        const outcome = await Promise.race([
          saveNow().then((saved) => (saved ? "saved" as const : "failed" as const)),
          escapePromise,
        ]);
        if (outcome === "escape") {
          leaveWithDraft();
          return;
        }
        if (outcome === "failed") {
          break;
        }
        converged = !dirtyRef.current && currentSnapshot() === lastSavedSnapshotRef.current;
      }
      if (!converged) {
        return;
      }
      navigateBack();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("editor.saveState.error"));
      setSaveStateStable("error");
    } finally {
      escapeLeaveRef.current = null;
      if (leavePageAttemptRef.current === attempt) {
        leavingRef.current = false;
        setLeavePending(false);
      }
      if (editor && !editor.isDestroyed) {
        editor.setEditable(wasEditable, false);
      }
    }
  }, [currentSnapshot, editor, navigateBack, notebookUpdatePending, persistLocalDraft, saveNow, sendBackgroundSave, setSaveStateStable, t]);

  const handleTitleChange = (nextTitle: string) => {
    setTitle(nextTitle);
    titleRef.current = nextTitle;
    scheduleMetadataSave();
  };

  const handleTagsChange = (nextTagsText: string) => {
    setTagsText(nextTagsText);
    tagsTextRef.current = nextTagsText;
    scheduleMetadataSave();
  };

  const loadTags = useCallback(async () => {
    if (memoId) {
      const localMemo = await localDb.memos.filter((candidate) => candidate.id === memoId).first();
      if (localMemo) return listLocalTags(localMemo.scope);
    }
    return requestMobileEditorJson<{ tags: TagSummary[] }>("/api/v1/tags");
  }, [memoId]);

  const handleNotebookChange = async (nextNotebookId: string) => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !nextNotebookId || nextNotebookId === currentMemo.notebookId || notebookUpdatePending) {
      return;
    }

    setNotebookUpdatePending(true);
    setSaveStateStable("saving");
    setError(null);

    try {
      if (dirtyRef.current) {
        const saved = await saveNow();
        if (!saved) {
          return;
        }
      }

      const sourceMemo = memoRef.current;
      if (!sourceMemo || nextNotebookId === sourceMemo.notebookId) {
        return;
      }

      const data = await requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(sourceMemo.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: sourceMemo.revision,
          notebookId: nextNotebookId,
        }),
      });

      memoRef.current = data.memo;
      setMemo(data.memo);
      await cacheSavedMemoInMirror(data.memo);
      setSaveStateStable("saved");
      window.setTimeout(() => {
        if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
          setSaveStateStable("idle");
        }
      }, 1200);
    } catch (notebookError) {
      setError(notebookError instanceof Error ? notebookError.message : t("editor.saveState.error"));
      setSaveStateStable("error");
    } finally {
      setNotebookUpdatePending(false);
      setNotebookSheetOpen(false);
    }
  };

  const handleResourceUpload = async (file?: File | null) => {
    const currentMemo = memoRef.current;
    if (!currentMemo || !editor || !file) {
      return;
    }

    setError(null);
    try {
      const isImage = file.type.startsWith("image/");
      setSaveStateStable(isImage ? "compressing" : "uploading");
      const uploadFile = isImage ? (await compressImageForUpload(file)).file : file;
      setSaveStateStable("uploading");
      const { resource } = await uploadMobileEditorResource(currentMemo.id, uploadFile);
      if (resource.kind === "image") {
        const isTaskItem = editor.isActive("taskItem") || editor.isActive("taskList");
        editor
          .chain()
          .focus()
          .setImage({
            src: resource.url,
            alt: file.name,
            title: file.name,
            ...(isTaskItem ? { width: TASK_ITEM_DEFAULT_IMAGE_WIDTH_PERCENT } : {}),
          })
          .run();
      } else if (isPdfAttachment(file.type, resource.filename || file.name)) {
        editor
          .chain()
          .focus()
          .insertContent({
            type: "paragraph",
            content: [{
              type: "edgeeverPdfAttachment",
              attrs: {
                url: resource.url,
                label: `附件：${resource.filename || file.name}`,
                filename: resource.filename || file.name,
                mimeType: resource.mimeType || file.type || "application/pdf",
                byteSize: resource.byteSize,
                displayMode: "compact",
              },
            }],
          })
          .run();
      } else {
        const filename = resource.filename || file.name;
        editor
          .chain()
          .focus()
          .insertContent({
            type: "paragraph",
            content: [{
              type: "edgeeverFileAttachment",
              attrs: {
                url: resource.url,
                label: `附件：${filename}`,
                filename,
                mimeType: file.type,
                byteSize: resource.byteSize,
              },
            }],
          })
          .run();
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t("editor.uploadState.fileFailed"));
      setSaveStateStable("error");
    }
  };

  const focusEditorAfterLoad = useCallback(() => {
    if (!editor) {
      return;
    }

    if (initialFocusTimerRef.current !== null) {
      window.clearTimeout(initialFocusTimerRef.current);
    }

    initialFocusTimerRef.current = window.setTimeout(() => {
      initialFocusTimerRef.current = null;

      if (leavingRef.current || editor.isDestroyed) {
        return;
      }

      const activeElement = document.activeElement;
      if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) {
        return;
      }

      editor.commands.focus("end");
    }, MOBILE_EDITOR_INITIAL_FOCUS_DELAY_MS);
  }, [editor]);

  useEffect(() => {
    let cancelled = false;

    void requestMobileEditorJson<ListNotebooksResponse>("/api/v1/notebooks")
      .then((data) => {
        if (!cancelled) {
          setNotebooks(data.notebooks);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotebooks([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!memoId || !editor) {
      if (!memoId) {
        setError(t("editor.saveState.error"));
        setSaveStateStable("error");
      }
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [data, sessionData] = await Promise.all([
          requestMobileEditorJson<MobileEditorMemoResponse>(`/api/v1/memos/${encodeURIComponent(memoId)}`),
          requestMobileEditorJson<{ editSession: MemoEditSession }>(`/api/v1/memos/${encodeURIComponent(memoId)}/edit-sessions`, {
            method: "POST",
            body: JSON.stringify({}),
          }),
        ]);
        if (cancelled) {
          return;
        }

        editSessionRef.current = sessionData.editSession;

        const nextTitle = getEditableMemoTitle(data.memo.title);
        const nextTagsText = Array.isArray(data.memo.tags) ? data.memo.tags.join(", ") : "";
        const nextContentJson = normalizeMobileEditorDoc(data.memo);
        let draft = await readBestLocalDraft();
        let queuedUpdate = await localDb.syncQueue.get(getMemoUpdateQueueId(data.memo.id));
        if (queuedUpdate && isMemoUpdateAlreadyApplied(data.memo, queuedUpdate)) {
          await Promise.all([
            localDb.syncQueue.delete(queuedUpdate.id),
            localDb.drafts.delete(data.memo.id),
          ]);
          if (draftKey) {
            localStorage.removeItem(draftKey);
          }
          draft = null;
          queuedUpdate = undefined;
        }
        const useDraft = Boolean(draft && (queuedUpdate || Date.parse(draft.updatedAt || "") >= Date.parse(data.memo.updatedAt || "")));
        const queuedPayload =
          queuedUpdate && queuedUpdate.kind === "memo.update"
            ? (queuedUpdate.payload as MemoUpdateSyncPayload)
            : null;
        const useQueuedPayload = Boolean(
          queuedPayload && !useDraft && queuedUpdate && !isMemoUpdateAlreadyApplied(data.memo, queuedUpdate),
        );

        setMemo(data.memo);
        // The mirror the workspace preview reads may still hold an older
        // revision; align it with the snapshot this editor just loaded.
        void cacheSavedMemoInMirror(data.memo);

        if (useDraft && draft) {
          setTitle(draft.title || "");
          titleRef.current = draft.title || "";
          setTagsText(draft.tagsText || "");
          tagsTextRef.current = draft.tagsText || "";
          contentJsonRef.current = draft.contentJson || emptyDoc();
          editor.commands.setContent(contentJsonRef.current, { emitUpdate: false });
          dirtyRef.current = true;
          setSaveStateStable("local-draft");
          scheduleMetadataSave();
          focusEditorAfterLoad();
        } else if (useQueuedPayload && queuedPayload) {
          const queuedTitle = getEditableMemoTitle(queuedPayload.title);
          const queuedTagsText = queuedPayload.tags.join(", ");
          setTitle(queuedTitle);
          titleRef.current = queuedTitle;
          setTagsText(queuedTagsText);
          tagsTextRef.current = queuedTagsText;
          contentJsonRef.current = queuedPayload.contentJson || emptyDoc();
          editor.commands.setContent(contentJsonRef.current, { emitUpdate: false });
          lastSavedSnapshotRef.current = JSON.stringify({
            title: nextTitle,
            tagsText: nextTagsText,
            contentJson: nextContentJson,
          });
          dirtyRef.current = true;
          setSaveStateStable("local-draft");
          focusEditorAfterLoad();
        } else {
          setTitle(nextTitle);
          titleRef.current = nextTitle;
          setTagsText(nextTagsText);
          tagsTextRef.current = nextTagsText;
          contentJsonRef.current = nextContentJson;
          editor.commands.setContent(nextContentJson, { emitUpdate: false });
          contentJsonRef.current = editor.getJSON() as TiptapDoc;
          lastSavedSnapshotRef.current = JSON.stringify({
            title: nextTitle,
            tagsText: nextTagsText,
            contentJson: contentJsonRef.current,
          });
          dirtyRef.current = false;
          setSaveStateStable("idle");
          focusEditorAfterLoad();
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : t("editor.loading"));
        setSaveStateStable("error");
      }
    })();

    return () => {
      cancelled = true;
      if (initialFocusTimerRef.current !== null) {
        window.clearTimeout(initialFocusTimerRef.current);
        initialFocusTimerRef.current = null;
      }
    };
  }, [editor, focusEditorAfterLoad, memoId, readBestLocalDraft, scheduleMetadataSave, setSaveStateStable, t]);

  useEffect(() => {
    const handlePageHide = () => {
      if (dirtyRef.current) {
        persistLocalDraft();
        if (!sendBackgroundSave()) {
          void saveNow({ keepalive: true });
        }
      }
      persistReturnPreview();
      markStandaloneMobileEditorReturning(memoId);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && dirtyRef.current) {
        persistLocalDraft();
        if (!sendBackgroundSave()) {
          void saveNow({ keepalive: true });
        }
        markStandaloneMobileEditorReturning(memoId);
        return;
      }

      if (document.visibilityState === "hidden") {
        markStandaloneMobileEditorReturning(memoId);
        return;
      }

      if (document.visibilityState === "visible") {
        void (async () => {
          await reconcileBackgroundSave();
          if (dirtyRef.current && !backgroundSavePendingRef.current) {
            await saveNowRef.current();
          }
        })();
      }
    };
    const handleOnline = () => {
      void (async () => {
        if (backgroundSavePendingRef.current) {
          await reconcileBackgroundSave();
        }
        if (dirtyRef.current && !backgroundSavePendingRef.current) {
          await saveNowRef.current();
        }
      })();
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (initialFocusTimerRef.current !== null) {
        window.clearTimeout(initialFocusTimerRef.current);
      }
    };
  }, [currentSnapshot, draftKey, memoId, persistLocalDraft, persistReturnPreview, reconcileBackgroundSave, saveNow, sendBackgroundSave, setSaveStateStable]);

  // Adopt edits made elsewhere while this note is open and untouched. A dirty
  // editor is never overwritten: the local draft wins until it is saved, which
  // then surfaces the usual revision conflict instead of losing keystrokes.
  useEffect(() => {
    if (!memoId || !editor) {
      return;
    }

    let disposed = false;
    let timer: number | null = null;

    const pollRemoteMemo = async () => {
      if (disposed) return;

      const canAdopt = document.visibilityState !== "hidden"
        && !dirtyRef.current
        && !savingRef.current
        && !leavingRef.current
        && !backgroundSavePendingRef.current;

      if (canAdopt) {
        try {
          const data = await requestMobileEditorJson<MobileEditorMemoResponse>(
            `/api/v1/memos/${encodeURIComponent(memoId)}`,
            { timeoutMs: MOBILE_EDITOR_REMOTE_POLL_TIMEOUT_MS },
          );
          const current = memoRef.current;
          if (
            !disposed
            && current
            && !dirtyRef.current
            && data.memo.revision > current.revision
          ) {
            // The old edit session is bound to the previous revision and would
            // reject the next save, so rebind before adopting the content.
            const sessionData = await requestMobileEditorJson<{ editSession: MemoEditSession }>(
              `/api/v1/memos/${encodeURIComponent(memoId)}/edit-sessions`,
              { method: "POST", body: JSON.stringify({}) },
            );
            if (disposed || dirtyRef.current) return;

            const nextTitle = getEditableMemoTitle(data.memo.title);
            const nextTagsText = Array.isArray(data.memo.tags) ? data.memo.tags.join(", ") : "";
            const nextContentJson = normalizeMobileEditorDoc(data.memo);
            memoRef.current = data.memo;
            editSessionRef.current = sessionData.editSession;
            setMemo(data.memo);
            void cacheSavedMemoInMirror(data.memo);
            setTitle(nextTitle);
            titleRef.current = nextTitle;
            setTagsText(nextTagsText);
            tagsTextRef.current = nextTagsText;
            editor.commands.setContent(nextContentJson, { emitUpdate: false });
            contentJsonRef.current = editor.getJSON() as TiptapDoc;
            lastSavedSnapshotRef.current = JSON.stringify({
              title: nextTitle,
              tagsText: nextTagsText,
              contentJson: contentJsonRef.current,
            });
            dirtyRef.current = false;
            setSaveStateStable("saved");
            window.setTimeout(() => {
              if (!dirtyRef.current && !savingRef.current && !leavingRef.current) {
                setSaveStateStable("idle");
              }
            }, 1200);
          }
        } catch {
          // Network hiccups only delay the next attempt.
        }
      }

      if (!disposed) {
        timer = window.setTimeout(pollRemoteMemo, MOBILE_EDITOR_REMOTE_POLL_MS);
      }
    };

    timer = window.setTimeout(pollRemoteMemo, MOBILE_EDITOR_REMOTE_POLL_MS);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [editor, memoId, setSaveStateStable]);

  const saveLabel =
    saveState === "loading"
      ? t("editor.loading")
      : saveState === "saving"
        ? t("editor.saveState.saving")
        : saveState === "compressing"
          ? t("editor.uploadState.compressing")
          : saveState === "uploading"
            ? t("editor.uploadState.uploading")
            : saveState === "dirty"
              ? t("editor.saveState.unsaved")
              : saveState === "saved"
                ? t("editor.saveState.saved")
                : saveState === "local-draft"
                  ? t("editor.saveState.queued")
                  : saveState === "leaving"
                    ? t("editor.saveState.saving")
                    : saveState === "error"
                      ? t("editor.saveState.error")
                      : t("editor.saveState.saved");
  const statusClassName = getMobileEditorStatusClassName(saveState);
  const editorActionDisabled =
    !memo || !editor || leavePending || notebookUpdatePending || saveState === "loading" || saveState === "compressing" || saveState === "uploading" || saveState === "leaving";
  const currentNotebookLabel =
    notebookOptions.find((notebook) => notebook.id === memo?.notebookId)?.name ?? t("editor.notebookFallback");
  const activeListItemType = editor?.isActive("taskItem") ? "taskItem" : "listItem";
  const canWrapIndentedParagraph = Boolean(editor && wrapIndentedParagraphInList(editor.state, undefined));

  const fallbackMarkdown = memo ? docToMarkdown(contentJsonRef.current) : "";
  const runEditorCommand = (command: () => boolean) => {
    if (editorActionDisabled || !editor) {
      return;
    }

    command();
    editor.commands.focus();
  };

  return (
    <div className="mobile-editor-shell">
      <MobileEditorHeader
        saveLabel={saveLabel}
        statusClassName={statusClassName}
        saveState={saveState}
        leavePending={leavePending || notebookUpdatePending}
        onLeave={() => void leavePage("done")}
        onBack={() => void leavePage("back")}
      />

      <main className="mobile-editor-main">
        {error && <div className="mobile-editor-error">{error}</div>}
        <input
          className="mobile-editor-title"
          value={title}
          disabled={!memo || leavePending || saveState === "loading"}
          autoComplete="on"
          autoCorrect="on"
          inputMode="text"
          placeholder={t("common.untitledMemo")}
          onChange={(event) => handleTitleChange(event.target.value)}
        />
        <div className="mobile-editor-meta-row">
          <MobileEditorNotebookButton
            label={currentNotebookLabel}
            disabled={!memo || leavePending || notebookUpdatePending || saveState === "loading" || notebookOptions.length === 0}
            onOpen={() => setNotebookSheetOpen(true)}
          />
          <EditorTagPicker
            contentMarkdown={fallbackMarkdown}
            disabled={!memo || leavePending || saveState === "loading"}
            loadTags={loadTags}
            title={title}
            value={tagsText}
            onChange={handleTagsChange}
          />
        </div>

        <MobileEditorToolbar
          disabled={editorActionDisabled}
          boldActive={Boolean(editor?.isActive("bold"))}
          bulletListActive={Boolean(editor?.isActive("bulletList"))}
          taskListActive={Boolean(editor?.isActive("taskList"))}
          increaseListIndentAvailable={canWrapIndentedParagraph || Boolean(editor && sinkListItemPreservingAttrs(editor.state, undefined))}
          decreaseListIndentAvailable={Boolean(editor?.can().chain().focus().liftListItem(activeListItemType).run())}
          blockquoteActive={Boolean(editor?.isActive("blockquote"))}
          locale={locale}
          onPickImage={() => imageInputRef.current?.click()}
          onToggleBold={() => runEditorCommand(() => editor?.chain().focus().toggleBold().run() ?? false)}
          onToggleBulletList={() => runEditorCommand(() => (
            editor ? wrapIndentedParagraphInList(editor.state, editor.view.dispatch, "bulletList") || editor.commands.toggleBulletList() : false
          ))}
          onToggleTaskList={() => runEditorCommand(() => (
            editor ? wrapIndentedParagraphInList(editor.state, editor.view.dispatch, "taskList") || editor.commands.toggleTaskList() : false
          ))}
          onIncreaseListIndent={() => runEditorCommand(() => (
            editor ? wrapIndentedParagraphInList(editor.state, editor.view.dispatch) || sinkListItemPreservingAttrs(editor.state, editor.view.dispatch) || editor.commands.sinkListItem(activeListItemType) : false
          ))}
          onDecreaseListIndent={() => runEditorCommand(() => editor?.chain().focus().liftListItem(activeListItemType).run() ?? false)}
          onToggleBlockquote={() => runEditorCommand(() => editor?.chain().focus().toggleBlockquote().run() ?? false)}
          onSetHorizontalRule={() => runEditorCommand(() => editor?.chain().focus().setHorizontalRule().run() ?? false)}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="*/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleResourceUpload(file);
          }}
        />

        {notebookSheetOpen && (
          <MobileEditorNotebookSheet
            options={notebookOptions}
            selectedNotebookId={memo?.notebookId}
            updating={notebookUpdatePending}
            onClose={() => setNotebookSheetOpen(false)}
            onSelect={(notebookId) => void handleNotebookChange(notebookId)}
          />
        )}

        <div className="edgeever-mobile-tiptap-editor">
          <EditorContent editor={editor} />
        </div>

        {saveState === "error" && fallbackMarkdown && <MobileEditorFallback markdown={fallbackMarkdown} />}
      </main>
    </div>
  );
};

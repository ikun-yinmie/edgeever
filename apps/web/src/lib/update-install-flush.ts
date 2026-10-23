// The active editor registers a synchronous flush hook here so the desktop
// update handshake can persist the current draft before the renderer reports
// that it is safe to restart. Only one editor can be visible at a time.

type EditorUpdateFlush = () => Promise<void>;

let activeFlush: EditorUpdateFlush | null = null;

export const registerEditorUpdateFlush = (flush: EditorUpdateFlush) => {
  activeFlush = flush;
  return () => {
    if (activeFlush === flush) activeFlush = null;
  };
};

export const flushEditorBeforeUpdateInstall = async () => {
  await activeFlush?.();
};

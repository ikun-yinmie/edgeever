const desktopBridge = () => (
  typeof window === "undefined" ? undefined : window.edgeeverDesktop
);

export const canRevealMemoMarkdown = () => {
  const bridge = desktopBridge();
  return Boolean(bridge?.isAvailable && bridge.memoMarkdownStatus && bridge.revealMemoMarkdown);
};

export const isMemoMarkdownAvailable = async (memoId: string) => {
  const bridge = desktopBridge();
  if (!bridge?.isAvailable || !bridge.memoMarkdownStatus || !memoId) return false;
  try {
    return Boolean((await bridge.memoMarkdownStatus(memoId))?.available);
  } catch {
    return false;
  }
};

export const revealMemoMarkdown = async (memoId: string) => {
  const bridge = desktopBridge();
  if (!bridge?.isAvailable || !bridge.revealMemoMarkdown || !memoId) return false;
  try {
    return Boolean((await bridge.revealMemoMarkdown(memoId))?.ok);
  } catch {
    return false;
  }
};

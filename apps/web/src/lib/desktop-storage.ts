const desktopBridge = () => (
  typeof window === "undefined" ? undefined : window.edgeeverDesktop
);

export const canRevealLocalStorage = () => {
  const bridge = desktopBridge();
  return Boolean(bridge?.isAvailable && (bridge.revealStorageLocation || bridge.openStorageLocation));
};

export const revealLocalStorage = async () => {
  const bridge = desktopBridge();
  if (!bridge?.isAvailable) return false;
  if (bridge.revealStorageLocation) {
    return Boolean((await bridge.revealStorageLocation())?.ok);
  }
  if (bridge.openStorageLocation) {
    return Boolean((await bridge.openStorageLocation())?.ok);
  }
  return false;
};

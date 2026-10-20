export const isNativeDesktopRuntime = () =>
  Boolean(typeof window !== "undefined" && window.edgeeverDesktop?.isAvailable);

export const isDesktopRenderer = () =>
  Boolean(
    (typeof __EDGEEVER_DESKTOP_BUILD__ !== "undefined" && __EDGEEVER_DESKTOP_BUILD__) ||
      (typeof window !== "undefined" && window.edgeeverDesktop?.isAvailable)
  );

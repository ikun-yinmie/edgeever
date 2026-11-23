const MOBILE_USER_AGENT = /Android|Mobile|iPhone|iPad|iPod|IEMobile|Windows Phone|Opera Mini|Silk|Kindle|BlackBerry|BB10|webOS/i;
export const DESKTOP_WEB_VIEWPORT_WIDTH = 1280;

type WebViewportEnvironment = {
  userAgent: string;
  touchDevice: boolean;
  narrowViewport: boolean;
  desktopRuntime: boolean;
};

/** A desktop UA on a narrow touch device is a request for the desktop site. */
export const shouldUseDesktopWebViewport = ({
  userAgent,
  touchDevice,
  narrowViewport,
  desktopRuntime,
}: WebViewportEnvironment) =>
  !desktopRuntime && touchDevice && narrowViewport && Boolean(userAgent.trim()) && !MOBILE_USER_AGENT.test(userAgent);

export const initializeWebViewport = ({ desktopRuntime = false } = {}) => {
  if (!shouldUseDesktopWebViewport({
    userAgent: navigator.userAgent,
    touchDevice: navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches,
    narrowViewport: window.matchMedia("(max-width: 1023px)").matches,
    desktopRuntime,
  })) {
    return;
  }

  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport) return;

  // Change the layout viewport before React mounts so CSS breakpoints and JS
  // viewport checks agree. Omitting initial-scale lets the browser fit the
  // desktop workspace to the phone instead of showing a zoomed-in corner.
  viewport.content = `width=${DESKTOP_WEB_VIEWPORT_WIDTH}, viewport-fit=cover, interactive-widget=resizes-content`;
};

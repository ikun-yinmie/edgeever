/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __EDGEEVER_BUILD_ID__: string;
declare const __EDGEEVER_BUILD_LABEL__: string;
declare const __EDGEEVER_APP_VERSION__: string;
declare const __EDGEEVER_RELEASED_AT__: string;
declare const __EDGEEVER_RELEASE_SUMMARY__: {
  version: string;
  changes: Record<string, string[]>;
};
declare const __EDGEEVER_DEPLOYMENT_TRIGGER__: string;
declare const __EDGEEVER_DEPLOYMENT_METHOD__: string;
declare const __EDGEEVER_DEVELOPMENT_PROFILE__: "" | "local" | "demo";
declare const __EDGEEVER_DESKTOP_BUILD__: boolean;

interface EdgeEverDesktopBridge {
  isAvailable: boolean;
  canClearLocalData: boolean;
  recoveredAfterAbnormalExit: boolean;
  apiBaseUrl: string;
  setApiBaseUrl(value: string): Promise<string>;
  setPrimaryApiBaseUrl?(value: string): Promise<string>;
  probeInstanceUrls?(urls: string[]): Promise<Array<{ url: string; ms: number | null }>>;
  getProxySettings(): {
    mode: "off" | "auto" | "always";
    protocol: "http" | "socks5";
    host: string;
    port: number;
  } | null;
  setProxySettings(value: {
    mode: "off" | "auto" | "always";
    protocol: "http" | "socks5";
    host: string;
    port: number;
  }): Promise<{
    mode: "off" | "auto" | "always";
    protocol: "http" | "socks5";
    host: string;
    port: number;
  }>;
  probeProxyForSession(baseUrl: string): Promise<{
    directMs: number | null;
    proxyMs: number | null;
    chosen: "direct" | "proxy";
  }>;
  getSessionToken(): string;
  copyText(value: string): Promise<boolean>;
  copyHtml(html: string, plainText: string): Promise<boolean>;
  copyImage?(bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
  setSessionToken(value: string): Promise<{ stored: boolean }>;
  clearSessionToken(): Promise<{ stored: false }>;
  publicNetworkFetch(requestId: string, input: import("@edgeever/shared").PluginPublicFetchRequest): Promise<import("@edgeever/shared").PluginPublicFetchResponse>;
  cancelPublicNetworkFetch(requestId: string): Promise<void>;
  openAiProviderStream(requestId: string, input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body: string;
  }): Promise<{ status: number; headers: Record<string, string> }>;
  cancelAiProviderStream(requestId: string): void;
  onAiProviderStreamChunk(callback: (requestId: string, chunk: {
    type: "data" | "end" | "error";
    bytes?: ArrayBuffer | Uint8Array;
    message?: string;
  }) => void): () => void;
  clearLocalData(): Promise<
    { scheduled: true }
    | { scheduled: false; errorCode: DesktopLocalDataResetErrorCode }
  >;
  storageLocation(): Promise<{
    rootDirectory: string;
    accountDirectory: string;
    defaultRootDirectory: string;
    isCustom: boolean;
    usageBytes: number;
    usageFiles: number;
  }>;
  chooseStorageLocation(): Promise<{ path: string | null }>;
  setStorageLocation(directory: string): Promise<
    { ok: true; rootDirectory: string }
    | { ok: false; errorCode: DesktopStorageLocationErrorCode }
  >;
  resetStorageLocation(): Promise<
    { ok: true; rootDirectory: string }
    | { ok: false; errorCode: DesktopStorageLocationErrorCode }
  >;
  openStorageLocation(): Promise<{ ok: boolean }>;
  revealStorageLocation?(): Promise<{ ok: boolean }>;
  markdownMirrorStatus(): Promise<DesktopMarkdownMirrorStatus>;
  setMarkdownMirrorEnabled(enabled: boolean): Promise<DesktopMarkdownMirrorStatus>;
  chooseMarkdownMirrorDirectory(): Promise<DesktopMarkdownMirrorResult>;
  resetMarkdownMirrorDirectory(): Promise<DesktopMarkdownMirrorResult>;
  syncMarkdownMirror(): Promise<DesktopMarkdownMirrorStatus>;
  openMarkdownMirrorDirectory(): Promise<{ ok: boolean }>;
  memoMarkdownStatus?(memoId: string): Promise<{ available: boolean }>;
  revealMemoMarkdown?(memoId: string): Promise<{ ok: boolean }>;
  recordRendererError(details: DesktopRendererErrorDetails): Promise<{ recorded: true }>;
  openRendererIssue(details: DesktopRendererErrorDetails): Promise<{ opened: true }>;
  rendererBootstrapReady(): void;
  getClientBranding?(): Promise<{
    customName: string | null;
    customIcon: string | null;
    serverName: string | null;
    serverIcon: string | null;
    effectiveName: string;
    effectiveIcon: string | null;
    nameSource: "custom" | "server" | "default";
    iconSource: "custom" | "server" | "default";
  }>;
  setClientCustomBranding?(input: {
    name?: string | null;
    icon?: string | null;
  }): Promise<{
    customName: string | null;
    customIcon: string | null;
    serverName: string | null;
    serverIcon: string | null;
    effectiveName: string;
    effectiveIcon: string | null;
    nameSource: "custom" | "server" | "default";
    iconSource: "custom" | "server" | "default";
  }>;
  syncServerBranding?(input: {
    name?: string | null;
    icon?: string | null;
  }): Promise<{
    customName: string | null;
    customIcon: string | null;
    serverName: string | null;
    serverIcon: string | null;
    effectiveName: string;
    effectiveIcon: string | null;
    nameSource: "custom" | "server" | "default";
    iconSource: "custom" | "server" | "default";
  }>;
  sidecarStatus(): Promise<{ available: boolean; path: string; scope: string }>;
  systemInfo(): Promise<{
    appVersion: string;
    autoUpdateSupported: boolean;
    platform: string;
    architecture: string;
    deviceModel: string;
    osVersion: string;
    osRelease: string;
    electron: string;
    chrome: string;
    dataDir: string;
  }>;
  setAccountScope(accountId: string | null): Promise<{ ready: true; scope: string }>;
  updateStatus(): Promise<DesktopUpdateStatus>;
  updatePreferences(): Promise<DesktopUpdatePreferences>;
  setUpdatePreferences(value: DesktopUpdatePreferenceInput): Promise<DesktopUpdatePreferences>;
  checkUpdate(): Promise<DesktopUpdateStatus>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<DesktopUpdateInstallResult>;
  onUpdateStatus(callback: (status: DesktopUpdateStatus) => void): () => void;
  onUpdateInstallPrepare?(
    callback: () => Promise<DesktopUpdateInstallPreparation>,
  ): () => void;
  sidecarRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  beginStagedResource(input: { memoId: string; name: string; type: string; size: number }): Promise<{ id: string; partSize: number }>;
  appendStagedResource(id: string, bytes: ArrayBuffer): Promise<{ receivedBytes: number }>;
  completeStagedResource(id: string): Promise<{ id: string }>;
  abortStagedResource(id: string): Promise<void>;
  listStagedResources(): Promise<Array<{ id: string; memoId: string; name: string; type: string; size: number }>>;
  remapStagedResourceMemoIds?(mappings: Array<[string, string]>): Promise<{ updated: number }>;
  readStagedResource(id: string): Promise<{ name: string; type: string; bytes: Uint8Array }>;
  readStagedResourcePart(id: string, start: number, length: number): Promise<ArrayBuffer>;
  readResource(id: string): Promise<{ type: string; bytes: Uint8Array }>;
  removeStagedResource(id: string): Promise<void>;
  onCommand(callback: (command: string) => void): () => void;
  onHibernatePrepare?(callback: () => void | Promise<void>): () => void;
  syncScheduledTasks(tasks: import("@edgeever/shared").ScheduledTask[]): Promise<{ scheduled: number }>;
  onScheduledTask(callback: (payload: {
    task: import("@edgeever/shared").ScheduledTask;
    scheduledFor: string;
  }) => void | Promise<void>): () => void;
  onImportMarkdown(callback: (payload: { name: string; content: string }) => void): () => void;
  onImportScreenshot?(callback: (payload: { captureId?: string; name: string; type: string; title?: string; bytes: Uint8Array }) => void): () => void;
}

type DesktopMarkdownMirrorStatus = {
  enabled: boolean;
  directory: string;
  defaultDirectory: string;
  isCustom: boolean;
  lastSyncedAt: string;
  fileCount: number;
  lastError: string;
  syncing: boolean;
};

type DesktopMarkdownMirrorErrorCode = "invalid-directory" | "target-not-writable" | "sync-failed";

type DesktopMarkdownMirrorResult = DesktopMarkdownMirrorStatus & {
  ok: boolean;
  canceled?: boolean;
  errorCode?: DesktopMarkdownMirrorErrorCode;
};

interface DesktopUpdateStatus {
  state: "idle" | "available" | "downloaded";
  version: string | null;
  currentVersion: string;
  error?: {
    kind: "network" | "other";
    message: string;
    at: string;
  } | null;
}

interface DesktopUpdatePreferenceInput {
  autoUpdateEnabled: boolean;
  windowEnabled: boolean;
  windowStart: string;
  windowEnd: string;
}

type DesktopUpdatePreferences = DesktopUpdatePreferenceInput & {
  autoUpdateSupported: boolean;
};

type DesktopUpdateInstallPreparation = {
  ok: boolean;
  reason?: string | null;
  pending?: number;
};

type DesktopUpdateInstallResult = {
  started: boolean;
  reason?: string;
  pending?: number;
};

type DesktopLocalDataResetErrorCode =
  | "unsafe-data-directory"
  | "application-bundle-not-found"
  | "helper-start-failed"
  | "unexpected";

type DesktopStorageLocationErrorCode =
  | "invalid-directory"
  | "unsupported-directory"
  | "target-has-data"
  | "target-not-writable"
  | "migration-in-progress"
  | "migration-failed";

interface DesktopRendererErrorDetails {
  kind: string;
  message?: string;
  stack?: string;
  componentStack?: string;
  reason?: string;
  exitCode?: number;
}

interface Window {
  edgeeverDesktop?: EdgeEverDesktopBridge;
}

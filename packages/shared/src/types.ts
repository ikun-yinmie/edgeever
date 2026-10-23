import type { TiptapDoc } from "./content";
import type { AiAction, AiPromptParameterKind, AiPromptResultMode } from "./ai-assistant";
import type { DiagramKind, DiagramSummaryPreview } from "./diagram";

export type Notebook = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  memoCount: number;
  lastMemoUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoSummary = {
  id: string;
  notebookId: string;
  title: string | null;
  excerpt: string;
  diagramKind?: DiagramKind | null;
  diagramPreview?: DiagramSummaryPreview;
  tags: string[];
  /**
   * Per-note editor theme. `null`/missing keeps the note on the native theme;
   * a named theme id is shared with everyone who can read it.
   */
  theme?: string | null;
  isPinned: boolean;
  isArchived: boolean;
  isDeleted: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type MemoDetail = MemoSummary & {
  contentJson: TiptapDoc;
  contentMarkdown: string;
  contentText: string;
  contentHash: string;
  sourceMemoIds: string[];
  mergeSourceCount: number;
  mergedIntoMemoId: string | null;
  /**
   * Present only when the detail came from an offline shared-note snapshot
   * (desktop sidecar) instead of the live API. Readers must treat it as
   * read-only and possibly stale; it is never written back anywhere.
   */
  snapshot?: {
    groupName: string | null;
  } | null;
};

export type MemoTemplate = {
  id: string;
  name: string;
  description: string | null;
  title: string | null;
  contentJson: TiptapDoc;
  contentMarkdown: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceExtensionSourceKind = "marketplace" | "github" | "manifest";

export type WorkspaceExtension = {
  extensionId: string;
  type: "plugin" | "theme";
  version: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  deletedAt: string | null;
  manifestUrl: string;
  sourceKind: WorkspaceExtensionSourceKind;
  verified: boolean;
  repositoryUrl: string | null;
  releaseTag: string | null;
  publisher: "edgeever" | null;
};

export type ScheduledTaskMissedRunPolicy = "run-once" | "skip";

export type ScheduledPluginCommandPayload = {
  pluginId: string;
  commandId: string;
};

export type ScheduledTask = {
  id: string;
  name: string;
  taskType: "plugin-command";
  taskPayload: ScheduledPluginCommandPayload;
  ownerPluginId: string | null;
  pluginScheduleKey: string | null;
  cronExpression: string;
  timezone: string;
  executorDeviceId: string;
  missedRunPolicy: ScheduledTaskMissedRunPolicy;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun: ScheduledTaskRun | null;
};

export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  scheduledFor: string;
  executorDeviceId: string;
  status: "running" | "succeeded" | "failed";
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type MemoEditSession = {
  id: string;
  memoId: string;
  baseRevision: number;
  baseContentHash: string;
  expiresAt: string;
};

export type MemoRevision = {
  id: string;
  memoId: string;
  revision: number;
  title: string | null;
  tags: string[];
  contentMarkdown: string;
  contentText: string;
  contentHash: string;
  createdBy: string;
  createdByType?: "user" | "agent" | "system";
  createdByName?: string | null;
  createdAt: string;
};

export type ResourceKind = "image" | "attachment";

export type Resource = {
  id: string;
  memoId: string;
  originalMemoId: string | null;
  kind: ResourceKind;
  mimeType: string | null;
  filename: string | null;
  byteSize: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type ResourceListItem = Resource & {
  memoTitle: string | null;
  memoExcerpt: string | null;
  memoDeleted: boolean;
};

export type ResourceStorageSummary = {
  totalCount: number;
  totalBytes: number;
  imageCount: number;
  attachmentCount: number;
};

export type ObjectStorageSettings = {
  provider: "builtin" | "s3";
  displayName: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyId: string | null;
  hasSecretAccessKey: boolean;
  forcePathStyle: boolean;
  objectPrefix: string;
  encryptionConfigured: boolean;
};

export type AiProvider = "openai-compatible" | "anthropic" | "google";

export type AiModelConfig = {
  id: string;
  providerConfigId: string;
  modelId: string;
  displayName: string;
};

export type AiProviderConfig = {
  id: string;
  provider: AiProvider;
  displayName: string;
  baseUrl: string;
  isEnabled: boolean;
  hasApiKey: boolean;
  models: AiModelConfig[];
  credentialsUnavailable?: boolean;
};

export type AiSettings = {
  providers: AiProviderConfig[];
  defaultModelId: string | null;
  tagSuggestionPrompt: string;
  tagSuggestionPromptCustomized: boolean;
  encryptionConfigured: boolean;
  readOnly: boolean;
};

export type AiPromptTemplate = {
  id: string;
  origin: "default" | "custom";
  seedKey: Exclude<AiAction, "custom"> | null;
  action: AiAction;
  parameterKind: AiPromptParameterKind;
  resultMode: AiPromptResultMode;
  nameCustomized: boolean;
  descriptionCustomized: boolean;
  instructionCustomized: boolean;
  name: string;
  description: string | null;
  instruction: string;
  createdAt: string;
  updatedAt: string;
};

export type AiDiscoveredModel = {
  modelId: string;
  displayName: string;
};

export type AiStreamEvent =
  | { type: "start" }
  | { type: "text-delta"; text: string }
  | { type: "finish"; finishReason?: string; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code: string; message: string };

export type AiTagSuggestion = {
  name: string;
  existing: boolean;
};

export type AiTagSuggestionsResponse = {
  suggestions: AiTagSuggestion[];
};

export type ApiToken = {
  id: string;
  name: string;
  token: string | null;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
};

export type CreatedApiToken = {
  token: string;
  apiToken: ApiToken;
};

export type TagSummary = {
  name: string;
  memoCount: number;
  updatedAt: string | null;
};

/**
 * Instance-wide role ladder:
 * - "owner"  the site owner (站长), exactly one, can never be demoted via the API
 * - "admin"  an administrator appointed by the site owner, nearly the same powers
 * - "member" a regular member
 */
export type InstanceRole = "owner" | "admin" | "member";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: InstanceRole;
  /** "group" marks a shared account that allows many concurrent sign-ins. */
  accountType?: "user" | "group";
};

export type InstanceUser = AuthUser & {
  email: string | null;
  isDisabled: boolean;
  isDeleted: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  accountType: "user" | "group";
};

export type MemberNotesAccessMode = "off" | "all" | "selected";

export type MemberNotesAccessSettings = {
  mode: MemberNotesAccessMode;
  selectedUserIds: string[];
};

export type MemberNotesMember = {
  id: string;
  username: string;
  displayName: string | null;
  accountType: "user" | "group";
  memoCount: number;
  lastMemoUpdatedAt: string | null;
};

export type MemberNotesMembersResponse = {
  mode: MemberNotesAccessMode;
  members: MemberNotesMember[];
};

export type MemberNotesMemoResponse = {
  memo: MemoDetail;
  member: Pick<MemberNotesMember, "id" | "username" | "displayName">;
};

export type GroupAccount = {
  id: string;
  username: string;
  displayName: string | null;
  isDisabled: boolean;
  createdAt: string;
  groupCount: number;
};

export type AuthSession = {
  authRequired: boolean;
  authenticated: boolean;
  demoMode: boolean;
  user: AuthUser | null;
  sessionToken?: string;
};

export type LoginDeviceSession = {
  id: string;
  userAgent: string | null;
  label: string | null;
  ipAddress: string | null;
  ipCountry: string | null;
  ipRegion: string | null;
  isCurrent: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

import { mergeAttributes, Node } from "@tiptap/core";

export const VIDEO_EMBED_NODE_TYPE = "edgeeverVideoEmbed" as const;
export const VIDEO_EMBED_MARKDOWN_LANGUAGE = "edgeever-video-embed" as const;

export type VideoEmbedAttributes = {
  /** Canonical watch url, used for the fallback link and thumbnail lookup. */
  url: string;
  /** Provider id: bilibili | youtube. */
  provider: string;
  /** Provider-specific video id. */
  videoId: string;
  /** Optional start time in seconds. */
  start: number;
  title: string;
};

const normalizeString = (value: unknown, limit = 500) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

const normalizeStart = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/** Extract provider + video id from a Bilibili or YouTube watch url. */
export const parseVideoEmbedUrl = (rawUrl: string): Omit<VideoEmbedAttributes, "title" | "start"> | null => {
  const url = rawUrl.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "");

  // bilibili.com/video/BV... or b23.tv short links keep the id in the path.
  if (host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv") {
    if (host === "b23.tv") {
      const shortId = parsed.pathname.replace(/^\//, "").split("/")[0] ?? "";
      if (shortId) return { url, provider: "bilibili", videoId: shortId };
      return null;
    }
    const match = /^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(parsed.pathname);
    if (match) {
      const bvid = match[1];
      const pageParam = parsed.searchParams.get("p") ?? "";
      const videoId = pageParam && /^\d+$/.test(pageParam) ? `${bvid}?p=${pageParam}` : bvid;
      return { url, provider: "bilibili", videoId };
    }
    return null;
  }

  if (host === "youtu.be") {
    const videoId = parsed.pathname.replace(/^\//, "").split("/")[0] ?? "";
    if (videoId) return { url, provider: "youtube", videoId };
    return null;
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (parsed.pathname === "/watch") {
      const videoId = parsed.searchParams.get("v") ?? "";
      if (videoId) return { url, provider: "youtube", videoId };
      return null;
    }
    const shortsMatch = /^\/shorts\/([0-9A-Za-z_-]+)/.exec(parsed.pathname);
    if (shortsMatch) return { url, provider: "youtube", videoId: shortsMatch[1] };
    const embedMatch = /^\/embed\/([0-9A-Za-z_-]+)/.exec(parsed.pathname);
    if (embedMatch) return { url, provider: "youtube", videoId: embedMatch[1] };
    return null;
  }

  return null;
};

/** Player iframe src for the provider. */
export const buildVideoEmbedFrameSrc = (attributes: Pick<VideoEmbedAttributes, "provider" | "videoId" | "start">) => {
  const start = normalizeStart(attributes.start);
  if (attributes.provider === "bilibili") {
    const [bvid, page] = attributes.videoId.split("?p=");
    const params = new URLSearchParams({ autoplay: "0" });
    if (page) params.set("p", page);
    if (start) params.set("t", String(start));
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid ?? "")}&${params.toString()}`;
  }
  const params = new URLSearchParams({ rel: "0" });
  if (start) params.set("start", String(start));
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(attributes.videoId)}?${params.toString()}`;
};

export const normalizeVideoEmbedAttributes = (value: unknown): VideoEmbedAttributes | null => {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const url = normalizeString(input.url);
  if (!url) return null;
  const parsed = parseVideoEmbedUrl(url);
  if (!parsed) return null;
  const provider = normalizeString(input.provider, 40);
  return {
    url: parsed.url,
    provider: provider === "youtube" ? "youtube" : "bilibili",
    videoId: normalizeString(input.videoId, 120) || parsed.videoId,
    start: normalizeStart(input.start),
    title: normalizeString(input.title),
  };
};

export const videoEmbedToMarkdown = (attributes: VideoEmbedAttributes) =>
  `\`\`\`${VIDEO_EMBED_MARKDOWN_LANGUAGE}\n${JSON.stringify(attributes)}\n\`\`\``;

const FENCE_PATTERN = /^```edgeever-video-embed[ \t]*\n([^\n]+)\n```(?:\n|$)/;

export const VideoEmbed = Node.create({
  name: VIDEO_EMBED_NODE_TYPE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: "" },
      provider: { default: "bilibili" },
      videoId: { default: "" },
      start: { default: 0 },
      title: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="edgeever-video-embed"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = typeof node.attrs.title === "string" && node.attrs.title ? node.attrs.title : "Video embed";
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-type": "edgeever-video-embed",
        "data-provider": node.attrs.provider,
        class: "edgeever-video-embed",
        contenteditable: "false",
      }),
      ["figcaption", {}, title],
    ];
  },

  parseMarkdown: (token) => ({
    type: VIDEO_EMBED_NODE_TYPE,
    attrs: token.attrs,
  }),

  renderMarkdown: (node) => {
    const attributes = normalizeVideoEmbedAttributes(node.attrs);
    return attributes ? videoEmbedToMarkdown(attributes) : "";
  },

  markdownTokenizer: {
    name: VIDEO_EMBED_NODE_TYPE,
    level: "block",
    start(source: string) {
      return source.indexOf(`\`\`\`${VIDEO_EMBED_MARKDOWN_LANGUAGE}`);
    },
    tokenize(source: string) {
      const match = FENCE_PATTERN.exec(source);
      if (!match) return undefined;
      try {
        const attrs = normalizeVideoEmbedAttributes(JSON.parse(match[1]));
        if (!attrs) return undefined;
        return { type: VIDEO_EMBED_NODE_TYPE, raw: match[0], attrs };
      } catch {
        return undefined;
      }
    },
  },
});

import { useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Play, Trash2 } from "lucide-react";
import {
  buildVideoEmbedFrameSrc,
  normalizeVideoEmbedAttributes,
  VIDEO_EMBED_NODE_TYPE,
} from "@edgeever/shared";

const PROVIDER_LABELS: Record<string, string> = {
  bilibili: "Bilibili",
  youtube: "YouTube",
};

export const VideoEmbedView = ({ node, deleteNode, editor }: NodeViewProps) => {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const attributes = normalizeVideoEmbedAttributes(node.attrs);
  const canEdit = editor.isEditable;

  if (!attributes) {
    return (
      <NodeViewWrapper className="edgeever-video-embed" data-type={VIDEO_EMBED_NODE_TYPE}>
        <p className="edgeever-video-embed__missing">{t("videoEmbed.invalid")}</p>
      </NodeViewWrapper>
    );
  }

  const providerLabel = PROVIDER_LABELS[attributes.provider] ?? attributes.provider;
  const frameSrc = buildVideoEmbedFrameSrc(attributes);
  const title = attributes.title || `${providerLabel} · ${attributes.videoId}`;

  return (
    <NodeViewWrapper className="edgeever-video-embed" data-type={VIDEO_EMBED_NODE_TYPE} data-provider={attributes.provider}>
      <figure className="edgeever-video-embed__frame" contentEditable={false}>
        {playing ? (
          <iframe
            src={frameSrc}
            title={title}
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <button
            type="button"
            className="edgeever-video-embed__poster"
            aria-label={t("videoEmbed.play", { provider: providerLabel })}
            onClick={() => setPlaying(true)}
          >
            <span className="edgeever-video-embed__play-icon" aria-hidden="true">
              <Play />
            </span>
            <span className="edgeever-video-embed__meta">
              <span className="edgeever-video-embed__provider">{providerLabel}</span>
              <span className="edgeever-video-embed__id">{attributes.videoId}</span>
            </span>
          </button>
        )}
        <figcaption className="edgeever-video-embed__caption">
          <span className="edgeever-video-embed__title">{title}</span>
          <span className="edgeever-video-embed__actions">
            <a
              href={attributes.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("videoEmbed.openOriginal")}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            </a>
            {canEdit && (
              <button
                type="button"
                aria-label={t("common.delete")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => deleteNode()}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        </figcaption>
      </figure>
    </NodeViewWrapper>
  );
};

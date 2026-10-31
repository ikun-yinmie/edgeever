import "katex/dist/katex.min.css";
import { Node, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock3, FileText, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { ApiRequestError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EdgeEverCodeBlock, codeBlockLowlight } from "@/lib/code-block";
import { withEnvironmentTitlePrefix } from "@/lib/environment-title";
import { resolvePublicShareBody } from "@/lib/public-share-body";
import {
  parseImageWidth,
  getImageReferrerPolicy,
  createEdgeEverDocumentExtensions,
  type PublicMemoShare,
} from "@edgeever/shared";
import { createEdgeEverMathematics } from "@edgeever/shared/mathematics";
import { PdfAttachment } from "@/components/editor/PdfAttachment";
import { FileAttachment } from "@/components/editor/FileAttachment";
import { EditorOutline } from "@/components/EditorOutline";
import { ScrollToEdgeButtons } from "@/components/ScrollToEdgeButtons";
import { ImageViewer } from "@/components/ImageViewer";
import { MobileOutlineSheet } from "@/components/MobileOutlineSheet";
import {
  getImagePreviewGroup,
  getImagePreviewGroupFromDom,
  type ImagePreviewGroup,
} from "@/lib/image-preview-group";
import { resolveMemoEditorTheme } from "@/components/ThemeProvider";
import { isPaperEditorTheme, publishEditorCssVars, resolvePaperEditorTheme } from "@/lib/publish-layout";

const ReadOnlyX6Diagram = lazy(() => import("@/components/ReadOnlyX6Diagram"));

const SharedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => parseImageWidth(element.getAttribute("data-width") ?? element.style.width),
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

const SharedThemeBlock = Node.create({
  name: "edgeeverThemeBlock",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      kind: {
        default: "intro",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-theme-block-kind") || "intro",
        renderHTML: (attributes: { kind?: string }) => ({ "data-theme-block-kind": attributes.kind || "intro" }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "section[data-theme-block-kind]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes, { "data-edgeever-theme-block": "true" }), 0];
  },
});

const SharedRichText = ({
  content,
  onEditorReady,
}: {
  content: PublicMemoShare["contentJson"];
  onEditorReady?: (editor: Editor | null) => void;
}) => {
  const { t } = useTranslation();
  const [viewerImage, setViewerImage] = useState<ImagePreviewGroup | null>(null);
  const editor = useEditor({
    extensions: [
      ...createEdgeEverDocumentExtensions({
        mathematics: createEdgeEverMathematics(),
        starterKit: { codeBlock: false, link: { openOnClick: true } },
        image: SharedImage.configure({ allowBase64: false, inline: false }),
        pdf: PdfAttachment,
        file: FileAttachment,
        table: { table: { renderWrapper: true } },
      }),
      EdgeEverCodeBlock.configure({ lowlight: codeBlockLowlight, defaultLanguage: "plaintext" }),
      SharedThemeBlock,
    ],
    content,
    editable: false,
    editorProps: {
      attributes: {
        class: "prose prose-slate max-w-none focus:outline-none",
        "aria-label": "Shared note content",
      },
      handleDoubleClick: (view, pos, event) => {
        const target = event.target;
        if (target instanceof HTMLImageElement && target.src) {
          const group = getImagePreviewGroup(view, pos) ?? getImagePreviewGroupFromDom(view, target);
          setViewerImage(group ?? {
            slides: [{
              src: target.currentSrc || target.src,
              alt: target.alt || undefined,
            }],
            index: 0,
          });
          return true;
        }
        return false;
      },
    },
  }, [content]);

  useEffect(() => {
    onEditorReady?.(editor ?? null);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <>
      <EditorContent editor={editor} />
      <ImageViewer
        open={viewerImage}
        closeLabel={t("common.close")}
        resetZoomLabel={t("sharing.imageResetZoom")}
        viewerLabel={t("sharing.imageViewer")}
        zoomInLabel={t("sharing.imageZoomIn")}
        zoomOutLabel={t("sharing.imageZoomOut")}
        previousLabel={t("editor.imagePrevious")}
        nextLabel={t("editor.imageNext")}
        onClose={() => setViewerImage(null)}
      />
    </>
  );
};

const SharedDocument = ({
  locale,
  share,
  token,
  onEditorReady,
}: {
  locale: "zh-CN" | "en-US" | "ja";
  share: PublicMemoShare;
  token: string;
  onEditorReady?: (editor: Editor | null) => void;
}) => {
  const body = useMemo(() => resolvePublicShareBody(share, token), [share, token]);
  if (body.type === "diagram") {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-[360px] items-center justify-center text-slate-400">
            <LoaderCircle className="h-6 w-6 animate-spin" />
          </div>
        }
      >
        <ReadOnlyX6Diagram diagram={body.diagram} locale={locale} theme="light" />
      </Suspense>
    );
  }
  return <SharedRichText content={body.content} onEditorReady={onEditorReady} />;
};

const isSharePasswordError = (error: unknown, code: string) =>
  error instanceof ApiRequestError && error.code === code;

const PublicSharePasswordForm = ({
  token,
  onUnlocked,
}: {
  token: string;
  onUnlocked: () => Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const unlockMutation = useMutation({
    mutationFn: () => api.unlockPublicMemoShare(token, password),
    onSuccess: () => onUnlocked(),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim() || unlockMutation.isPending) return;
    unlockMutation.mutate();
  };
  const errorKey = isSharePasswordError(unlockMutation.error, "share_unlock_rate_limited")
    ? "sharing.passwordRateLimited"
    : unlockMutation.error
      ? "sharing.passwordInvalid"
      : null;

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-5">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-card p-8 shadow-sm">
        <LockKeyhole className="mx-auto h-9 w-9 text-emerald-600" />
        <h1 className="mt-4 text-center text-xl font-semibold text-slate-900">{t("sharing.passwordRequiredTitle")}</h1>
        <p className="mt-2 text-center text-sm leading-6 text-slate-500">{t("sharing.passwordRequiredHint")}</p>
        <form className="mt-6 space-y-3" onSubmit={submit}>
          <Input
            type="password"
            value={password}
            autoComplete="off"
            autoFocus
            aria-label={t("sharing.passwordLabel")}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button className="w-full" variant="solid" type="submit" disabled={!password.trim() || unlockMutation.isPending}>
            {unlockMutation.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
            {t("sharing.passwordSubmit")}
          </Button>
          {errorKey ? <p className="text-sm text-rose-600" role="alert">{t(errorKey)}</p> : null}
        </form>
      </section>
    </main>
  );
};

export const PublicSharePage = () => {
  const { t, i18n } = useTranslation();
  const { token = "" } = useParams();
  const [shareEditor, setShareEditor] = useState<Editor | null>(null);
  const [articleScroller, setArticleScroller] = useState<HTMLElement | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const shareQuery = useQuery({
    queryKey: ["public-share", token],
    queryFn: () => api.getPublicMemoShare(token),
    enabled: Boolean(token),
    retry: false,
  });
  const share = shareQuery.data?.share;
  const passwordRequired = isSharePasswordError(shareQuery.error, "share_password_required");

  useEffect(() => {
    const previousTitle = document.title;
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex,nofollow,noarchive";
    document.head.appendChild(robots);
    if (share) {
      document.title = withEnvironmentTitlePrefix(
        `${share.title?.trim() || t("common.untitledMemo")} · EdgeEver`,
        { development: import.meta.env.DEV, profile: __EDGEEVER_DEVELOPMENT_PROFILE__ },
      );
    } else if (passwordRequired) {
      document.title = withEnvironmentTitlePrefix(t("sharing.passwordRequiredTitle"), {
        development: import.meta.env.DEV,
        profile: __EDGEEVER_DEVELOPMENT_PROFILE__,
      });
    }
    return () => {
      document.title = previousTitle;
      robots.remove();
    };
  }, [passwordRequired, share, t]);

  if (shareQuery.isLoading) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 text-slate-500">
        <LoaderCircle className="h-6 w-6 animate-spin" aria-label={t("sharing.publicLoading")} />
      </main>
    );
  }

  if (passwordRequired) {
    return <PublicSharePasswordForm token={token} onUnlocked={() => shareQuery.refetch()} />;
  }

  if (!share) {
    // Prefer the owner-customized message returned by the API when present.
    const customMessage =
      shareQuery.error instanceof ApiRequestError && shareQuery.error.code === "not_found"
        ? (shareQuery.error.message || "").trim()
        : "";
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-5">
        <section className="max-w-md rounded-2xl border border-slate-200 bg-card p-8 text-center shadow-sm">
          <FileText className="mx-auto h-9 w-9 text-slate-400" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">{t("sharing.publicUnavailable")}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">{customMessage || t("sharing.publicUnavailableHint")}</p>
        </section>
      </main>
    );
  }

  const shareEditorTheme = resolveMemoEditorTheme(share.theme ?? null);

  return (
    <main className="edgeever-public-share min-h-[100dvh] bg-slate-50 px-4 py-6 sm:px-8 sm:py-10 lg:h-[100dvh] lg:overflow-hidden lg:py-6">
      <div className="mx-auto flex w-full max-w-[77rem] items-start justify-center gap-8 lg:h-full lg:items-stretch">
        <div className="relative flex min-w-0 max-w-4xl flex-1 flex-col lg:h-full">
          <article
            ref={setArticleScroller}
            className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-card shadow-sm lg:min-h-0 lg:overflow-y-auto"
          >
            <header className="border-b border-slate-200 px-5 py-6 sm:px-10 sm:py-8">
              <div className="mb-5 flex items-center justify-between gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5 font-semibold text-emerald-700">
                  <UserRound className="h-4 w-4" />
                  {share.sharedByName ? `${share.sharedByName} · ${t("sharing.readOnly")}` : t("sharing.readOnly")}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock3 className="h-4 w-4" />
                  {t("sharing.publicUpdated", {
                    time: new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(share.updatedAt)),
                  })}
                </span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                {share.title?.trim() || t("common.untitledMemo")}
              </h1>
              {share.tags.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {share.tags.map((tag) => <span key={tag} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">#{tag}</span>)}
                </div>
              ) : null}
            </header>
            <div
              className="edgeever-editor px-5 py-6 sm:px-10 sm:py-8"
              data-editor-theme={shareEditorTheme ?? "default"}
              data-paper-theme={isPaperEditorTheme(shareEditorTheme) ? "true" : undefined}
              style={
                isPaperEditorTheme(shareEditorTheme)
                  ? publishEditorCssVars(
                      shareEditorTheme,
                      resolvePaperEditorTheme(shareEditorTheme)?.palette ?? "emerald",
                      "desktop",
                    ) as CSSProperties
                  : undefined
              }
            >
              <SharedDocument
                locale={(i18n.resolvedLanguage || i18n.language || "zh-CN").startsWith("en") ? "en-US" : "zh-CN"}
                share={share}
                token={token}
                onEditorReady={setShareEditor}
              />
            </div>
          </article>
          <ScrollToEdgeButtons
            scrollContainer={articleScroller}
            contentKey={token}
            className="absolute bottom-6 right-6 z-10 max-lg:hidden"
          />
          <ScrollToEdgeButtons
            contentKey={token}
            className="fixed bottom-6 right-4 z-30 lg:hidden"
          />
          <MobileOutlineSheet
            editor={shareEditor}
            scrollContainer={articleScroller}
            documentKey={token}
          />
        </div>
        <EditorOutline
          editor={shareEditor}
          scrollContainer={articleScroller}
          collapsed={outlineCollapsed}
          documentKey={token}
          docked
          className="max-lg:hidden"
          onCollapsedChange={setOutlineCollapsed}
        />
      </div>
    </main>
  );
};

import type { AnyExtension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { createEdgeEverDetailsExtensions } from "./details";
import { FileAttachment } from "./file-attachment";
import { ImageGallery } from "./image-gallery";
import { MergeDivider } from "./merge-divider";
import { PdfAttachment } from "./pdf-attachment";
import { PluginEmbed } from "./plugin-embed";
import { createEdgeEverCodeBlock } from "./code-block-meta";
import { EdgeEverTextStyle } from "./text-style";

export type CreateEdgeEverDocumentExtensionsOptions = {
  mathematics: AnyExtension[];
  starterKit?: Parameters<typeof StarterKit.configure>[0];
  image?: AnyExtension | false;
  gallery?: AnyExtension | false;
  pdf?: AnyExtension | false;
  file?: AnyExtension | false;
  pluginEmbed?: AnyExtension | false;
  table?: Parameters<typeof TableKit.configure>[0];
  /** Replace the EdgeEver codeBlock codec (meta attrs + markdown round-trip). */
  codeBlock?: AnyExtension | false;
  markdown?: boolean;
};

const withOptional = (value: AnyExtension | false | undefined, fallback: AnyExtension) => {
  if (value === false) return [];
  return [value ?? fallback];
};

/**
 * Document-schema TipTap extensions shared by Markdown codecs and editors.
 * Pass KaTeX math from `@edgeever/shared/mathematics` in browsers; Worker
 * codecs must keep using `createEdgeEverMarkdownMathematics()`.
 */
export const createEdgeEverDocumentExtensions = (
  options: CreateEdgeEverDocumentExtensionsOptions,
): AnyExtension[] => {
  // The stock StarterKit codeBlock would win the markdown registry race against
  // the EdgeEver codec (first registration serves the fence token), so disable
  // it in the kit and append the EdgeEver codeBlock instead.
  const starterKitConfig = { codeBlock: false, ...options.starterKit } as NonNullable<
    CreateEdgeEverDocumentExtensionsOptions["starterKit"]
  >;
  return [
    StarterKit.configure(starterKitConfig),
    EdgeEverTextStyle,
    TaskList,
    TaskItem.configure({ nested: true }),
    options.table === undefined ? TableKit : TableKit.configure(options.table),
    ...withOptional(options.image, Image),
    ...withOptional(options.gallery, ImageGallery),
    ...withOptional(options.pdf, PdfAttachment),
    ...withOptional(options.file, FileAttachment),
    ...withOptional(options.codeBlock, createEdgeEverCodeBlock()),
    MergeDivider,
    ...createEdgeEverDetailsExtensions(),
    ...withOptional(options.pluginEmbed, PluginEmbed),
    ...options.mathematics,
    ...(options.markdown
      ? [Markdown.configure({ markedOptions: { gfm: true } })]
      : []),
  ];
};

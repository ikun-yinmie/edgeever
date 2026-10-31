import type { AnyExtension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { BlockTypeSelection } from "./block-type-selection";
import { createEdgeEverDetailsExtensions } from "./details";
import { createHeadingCollapseExtension, type HeadingCollapseOptions } from "./heading-collapse";
import { VideoEmbed } from "./video-embed";
import { FileAttachment } from "./file-attachment";
import { ImageGallery } from "./image-gallery";
import { MergeDivider } from "./merge-divider";
import { PdfAttachment } from "./pdf-attachment";
import { PluginEmbed } from "./plugin-embed";
import { createEdgeEverCodeBlock } from "./code-block-meta";
import { EdgeEverTextStyle } from "./text-style";
import { ParagraphFormat } from "./paragraph-format";

export type CreateEdgeEverDocumentExtensionsOptions = {
  mathematics: AnyExtension[];
  starterKit?: Parameters<typeof StarterKit.configure>[0];
  image?: AnyExtension | false;
  taskList?: AnyExtension | false;
  taskItem?: AnyExtension | false;
  gallery?: AnyExtension | false;
  pdf?: AnyExtension | false;
  file?: AnyExtension | false;
  pluginEmbed?: AnyExtension | false;
  table?: Parameters<typeof TableKit.configure>[0];
  /** Replace the EdgeEver codeBlock codec (meta attrs + markdown round-trip). */
  codeBlock?: AnyExtension | false;
  headingCollapse?: HeadingCollapseOptions | false;
  markdown?: boolean;
};

/**
 * Task lists keep the stock schema and add an optional numbered rendering.
 * The flag lives on the list node so one note can mix numbered and plain
 * checklists; the web layer renders the numbers with CSS counters.
 */
export const EdgeEverTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      numbered: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-task-numbered") === "true",
        renderHTML: (attributes: { numbered?: unknown }) =>
          attributes.numbered ? { "data-task-numbered": "true" } : {},
      },
    };
  },
});

export const EdgeEverTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-collapsed") === "true",
        renderHTML: (attributes: { collapsed?: unknown }) =>
          attributes.collapsed ? { "data-collapsed": "true" } : {},
      },
    };
  },
});

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
    ParagraphFormat,
    ...withOptional(options.taskList, EdgeEverTaskList),
    ...withOptional(options.taskItem, EdgeEverTaskItem.configure({ nested: true })),
    options.table === undefined ? TableKit : TableKit.configure(options.table),
    ...withOptional(options.image, Image),
    ...withOptional(options.gallery, ImageGallery),
    ...withOptional(options.pdf, PdfAttachment),
    ...withOptional(options.file, FileAttachment),
    ...withOptional(options.codeBlock, createEdgeEverCodeBlock()),
    MergeDivider,
    ...createEdgeEverDetailsExtensions(),
    ...(options.headingCollapse === false ? [] : [createHeadingCollapseExtension(options.headingCollapse)]),
    ...withOptional(options.pluginEmbed, PluginEmbed),
    VideoEmbed,
    ...options.mathematics,
    BlockTypeSelection,
    ...(options.markdown
      ? [Markdown.configure({ markedOptions: { gfm: true } })]
      : []),
  ];
};

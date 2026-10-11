// Seeding and materializing collaboration documents.
//
// A collab room is a Yjs document, but memos are stored as TipTap JSON. The
// two representations meet in exactly two places, both schema-free:
//
//   - seed:      TipTap JSON  -> Yjs update, applied once when a room opens
//                with no usable persisted state;
//   - materialize: Yjs state -> TipTap JSON, written back to memo_contents so
//                list previews, search, mobile and the LWW save path keep
//                seeing the merged document.
//
// Neither direction needs a ProseMirror schema: elements are keyed by node
// name, attributes ride as Y attributes, and marks ride as Y text format
// attributes keyed by mark name — the exact encoding @tiptap/y-tiptap uses,
// so the browser binding and this module read each other's output verbatim.
//
// The initial-state decision lives here too: a persisted merge is reused only
// while its content hash still matches the memo. A non-collaboration writer
// (mobile, desktop outbox, the LWW web path) leaves the hashes out of sync
// and the room is re-seeded from the memo content instead of resurrecting a
// stale merge.
//
// This module never touches storage; callers pass rows in and get bytes out.

import { yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

/** The Yjs fragment the browser Collaboration extension binds to. */
export const COLLAB_DOCUMENT_FIELD = "default";

type JsonAttrs = Record<string, unknown>;

type TiptapJsonNode = {
  type?: unknown;
  attrs?: JsonAttrs | null;
  content?: TiptapJsonNode[] | null;
  marks?: Array<{ type?: unknown; attrs?: JsonAttrs | null }> | null;
  text?: unknown;
};

const isPlainObject = (value: unknown): value is JsonAttrs =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Yjs attributes must be JSON-encodable: undefined is illegal, null is fine. */
const cleanAttributes = (attrs: JsonAttrs | null | undefined): Record<string, any> => {
  const cleaned: Record<string, any> = {};
  if (!isPlainObject(attrs)) return cleaned;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
};

const nodeToYType = (node: TiptapJsonNode): Y.XmlElement | Y.XmlText | null => {
  if (!isPlainObject(node) || typeof node.type !== "string" || !node.type) return null;

  if (node.type === "text") {
    const textContent = node.text;
    if (typeof textContent !== "string" || textContent.length === 0) return null;
    const text = new Y.XmlText();
    const format: Record<string, any> = {};
    for (const mark of Array.isArray(node.marks) ? node.marks : []) {
      if (!isPlainObject(mark) || typeof mark.type !== "string" || !mark.type) continue;
      format[mark.type] = cleanAttributes(mark.attrs);
    }
    text.insert(0, textContent, Object.keys(format).length > 0 ? format : undefined);
    return text;
  }

  const element = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(cleanAttributes(node.attrs))) {
    element.setAttribute(key, value);
  }
  const children = (Array.isArray(node.content) ? node.content : [])
    .map((child) => nodeToYType(child))
    .filter((child): child is Y.XmlElement | Y.XmlText => child !== null);
  if (children.length > 0) element.insert(0, children);
  return element;
};

/**
 * Convert a stored TipTap document into a single Yjs update for the given
 * field. Returns null when there is nothing seedable (missing or malformed
 * document) so the caller can leave the room empty instead of pushing junk.
 */
export const tiptapJsonToYjsUpdate = (
  contentJson: unknown,
  field: string = COLLAB_DOCUMENT_FIELD,
): Uint8Array | null => {
  if (!isPlainObject(contentJson) || contentJson.type !== "doc") return null;
  const children = (Array.isArray(contentJson.content) ? contentJson.content : [])
    .map((child) => nodeToYType(child as TiptapJsonNode))
    .filter((child): child is Y.XmlElement | Y.XmlText => child !== null);
  if (children.length === 0) return null;

  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(field);
  doc.transact(() => {
    fragment.insert(0, children);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

/**
 * Render a persisted Yjs update back into TipTap JSON for memo_contents.
 * Returns null for an unreadable state; callers must then skip the write
 * rather than storing a placeholder.
 */
export const yjsUpdateToTiptapJson = (
  state: Uint8Array | null | undefined,
  field: string = COLLAB_DOCUMENT_FIELD,
): { type: string; content: unknown[] } | null => {
  if (!state || !(state instanceof Uint8Array) || state.byteLength === 0) return null;
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(field)) as {
      type?: unknown;
      content?: unknown;
    };
    doc.destroy();
    if (!json || json.type !== "doc" || !Array.isArray(json.content)) return null;
    return { type: "doc", content: json.content };
  } catch {
    return null;
  }
};

export type CollabInitialStateInput = {
  /** Merged state from memo_collab_documents, when any. */
  persistedState: Uint8Array | null;
  /** Content hash that state was last materialized with, when any. */
  persistedContentHash: string | null;
  /** The memo's current contentJson, parsed. */
  memoContentJson: unknown;
  /** The memo's current content_hash. */
  memoContentHash: string | null;
  field?: string;
};

/**
 * Decide what a fresh room starts from: reuse the persisted merge while it is
 * still fresh, otherwise re-seed from the memo content. Returns null when
 * neither source yields a document.
 */
export const resolveCollabInitialState = (input: CollabInitialStateInput): Uint8Array | null => {
  const field = input.field ?? COLLAB_DOCUMENT_FIELD;
  const persistedFresh =
    input.persistedState &&
    input.persistedState.byteLength > 0 &&
    typeof input.persistedContentHash === "string" &&
    input.persistedContentHash !== "" &&
    input.persistedContentHash === input.memoContentHash;

  if (persistedFresh) return input.persistedState;

  const seed = input.memoContentJson ? tiptapJsonToYjsUpdate(input.memoContentJson, field) : null;
  if (seed) return seed;

  // The memo content is unreadable; a stale merge is better than an empty room.
  return input.persistedState && input.persistedState.byteLength > 0 ? input.persistedState : null;
};

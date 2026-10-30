/**
 * Local-first notebook creates start with a `local_*` id. The queued sync
 * replaces that row with the server notebook, so the sidebar selection and the
 * pending new-note target must follow the same rename — otherwise the
 * selection points at a notebook that no longer exists and new notes fall back
 * to the Inbox.
 */
export function remapNotebookId(notebookId: string, mappings: ReadonlyMap<string, string>): string;
export function remapNotebookId(notebookId: string | null, mappings: ReadonlyMap<string, string>): string | null;
export function remapNotebookId(notebookId: string | null, mappings: ReadonlyMap<string, string>): string | null {
  return notebookId && mappings.has(notebookId) ? mappings.get(notebookId)! : notebookId;
}

/** Validated payload of NOTEBOOK_ID_REMAPPED_EVENT. */
export const notebookIdMappingsFromEvent = (event: Event): ReadonlyMap<string, string> | null => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!(detail instanceof Map) || detail.size === 0) return null;
  return detail as ReadonlyMap<string, string>;
};

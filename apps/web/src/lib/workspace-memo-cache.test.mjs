import { describe, expect, test } from "bun:test";
import { evictIdleMemoDetails, memoToSummary } from "./workspace-memo-cache.ts";

const summaryMemo = {
  id: "status-summary", notebookId: "inbox", title: "Status", excerpt: "Summary", tags: [],
  isPinned: false, isArchived: false, isDeleted: false, revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null,
  contentJson: { type: "doc", content: [] }, contentText: "Summary", contentMarkdown: "Summary",
};

for (const status of ["in_progress", "completed", "cancelled", null, undefined]) {
  test(`memo summaries preserve status ${status} and theme`, () => {
    expect(memoToSummary({ ...summaryMemo, status, theme: "letter" })).toMatchObject({ status: status ?? null, theme: "letter" });
  });
}

describe("idle memo detail eviction", () => {
  test("drops cached memo bodies except the open note", () => {
    const removed = [];
    const queryClient = {
      removeQueries({ predicate }) {
        for (const query of [
          { queryKey: ["memo", "memo_old", "notebook"] },
          { queryKey: ["memo", "memo_open", "notebook"] },
          { queryKey: ["memos", "notebook"] },
          { queryKey: ["memo-link-search", "q"] },
        ]) {
          if (predicate(query)) removed.push(query.queryKey);
        }
      },
    };

    evictIdleMemoDetails(queryClient, "memo_open");
    expect(removed).toEqual([["memo", "memo_old", "notebook"]]);
  });
});

import type { MemoFilterMode } from "@edgeever/client";

export const getMobileMemoStatusFilter = (filter: MemoFilterMode) => {
  if (filter === "no-status") {
    return { sql: "json_extract(data_json, '$.status') IS NULL" };
  }

  if (filter === "in_progress" || filter === "completed" || filter === "cancelled") {
    return { sql: "json_extract(data_json, '$.status') = ?", value: filter };
  }

  return null;
};

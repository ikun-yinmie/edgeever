import { expect, test } from "bun:test";
import { getMobileMemoStatusFilter } from "./mobile-memo-status-filter";

test("maps each selected status to a parameterized local SQLite condition", () => {
  expect(getMobileMemoStatusFilter("in_progress")).toEqual({
    sql: "json_extract(data_json, '$.status') = ?",
    value: "in_progress",
  });
  expect(getMobileMemoStatusFilter("completed")).toEqual({
    sql: "json_extract(data_json, '$.status') = ?",
    value: "completed",
  });
  expect(getMobileMemoStatusFilter("cancelled")).toEqual({
    sql: "json_extract(data_json, '$.status') = ?",
    value: "cancelled",
  });
});

test("matches missing and explicit null statuses with the no-status filter", () => {
  expect(getMobileMemoStatusFilter("no-status")).toEqual({
    sql: "json_extract(data_json, '$.status') IS NULL",
  });
});

test("does not add status SQL for unrelated memo filters", () => {
  expect(getMobileMemoStatusFilter("all")).toBeNull();
  expect(getMobileMemoStatusFilter("pinned")).toBeNull();
});

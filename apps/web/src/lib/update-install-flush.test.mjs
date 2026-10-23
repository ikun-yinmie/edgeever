import { describe, expect, test } from "bun:test";
import { flushEditorBeforeUpdateInstall, registerEditorUpdateFlush } from "./update-install-flush.ts";

describe("editor update-install flush registry", () => {
  test("runs the registered editor flush and ignores stale unregister calls", async () => {
    const calls = [];
    const unregisterFirst = registerEditorUpdateFlush(async () => { calls.push("first"); });
    const unregisterSecond = registerEditorUpdateFlush(async () => { calls.push("second"); });

    await flushEditorBeforeUpdateInstall();
    expect(calls).toEqual(["second"]);

    // An older editor unmounting must not remove the newer registration.
    unregisterFirst();
    await flushEditorBeforeUpdateInstall();
    expect(calls).toEqual(["second", "second"]);

    unregisterSecond();
    await flushEditorBeforeUpdateInstall();
    expect(calls).toEqual(["second", "second"]);
  });

  test("rejects when the active editor cannot save", async () => {
    const unregister = registerEditorUpdateFlush(async () => { throw new Error("save failed"); });
    await expect(flushEditorBeforeUpdateInstall()).rejects.toThrow("save failed");
    unregister();
  });
});

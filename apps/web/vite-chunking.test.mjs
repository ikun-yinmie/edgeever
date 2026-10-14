import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const viteConfig = readFileSync(new URL("./vite.config.ts", import.meta.url), "utf8");

describe("web chunking contracts", () => {
  test("keeps the Yjs collaboration graph in one atomic chunk", () => {
    // yjs Doc extends lib0's ObservableV2 while y-protocols/y-websocket
    // import yjs back. Splitting that cycle across size-based chunks
    // evaluates the subclass before its superclass ("Class extends value
    // undefined") and takes down the lazy editor on every note.
    expect(viteConfig).toContain('name: "vendor-yjs-collab"');
    expect(viteConfig).toContain("yjs|y-protocols|y-websocket|lib0");
    expect(viteConfig).toContain("extends value undefined");
  });
});

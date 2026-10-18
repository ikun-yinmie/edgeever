import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PublicSharePage.tsx", import.meta.url), "utf8");

describe("PublicSharePage header", () => {
  test("shows who shared the note with a generic icon instead of brand marks", () => {
    expect(source).toContain("share.sharedByName");
    expect(source).toContain("<UserRound");
    expect(source).toContain("sharing.readOnly");
    expect(source).not.toContain("ShieldCheck");
    expect(source).not.toContain("EdgeEver ·");
  });
});

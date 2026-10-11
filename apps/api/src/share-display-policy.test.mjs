import { describe, expect, test } from "bun:test";
import {
  applyShareDisplayPolicyToDoc,
  DEFAULT_SHARE_DISPLAY_POLICY,
  isDefaultShareDisplayPolicy,
  parseShareDisplayPolicy,
} from "./share-display-policy.ts";

const codeBlock = (language, text) => ({
  type: "codeBlock",
  attrs: { language },
  content: [{ type: "text", text }],
});

const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const doc = (content) => ({ type: "doc", content });

describe("share display policy", () => {
  test("defaults to fully rendered and detects the default policy", () => {
    expect(parseShareDisplayPolicy(null)).toEqual(DEFAULT_SHARE_DISPLAY_POLICY);
    expect(parseShareDisplayPolicy("not json")).toEqual(DEFAULT_SHARE_DISPLAY_POLICY);
    expect(parseShareDisplayPolicy('{"html":"weird"}')).toEqual(DEFAULT_SHARE_DISPLAY_POLICY);
    expect(isDefaultShareDisplayPolicy(DEFAULT_SHARE_DISPLAY_POLICY)).toBe(true);
    expect(isDefaultShareDisplayPolicy({ html: "hidden", markdown: "rendered" })).toBe(false);
  });

  test("hidden replaces html and markdown blocks with a notice, wherever they nest", () => {
    const source = doc([
      paragraph("intro"),
      {
        type: "blockquote",
        content: [codeBlock("html", "<script>alert(1)</script>")],
      },
      codeBlock("markdown", "# secret plan"),
      codeBlock("javascript", "const keep = true;"),
    ]);
    const filtered = applyShareDisplayPolicyToDoc(source, { html: "hidden", markdown: "hidden" });

    const quote = filtered.content[1].content[0];
    expect(quote.type).toBe("codeBlock");
    expect(quote.attrs.language).toBe("html");
    expect(JSON.stringify(quote.content[0].text)).toContain("不公开");
    expect(JSON.stringify(quote.content[0].text)).not.toContain("alert");

    const markdownBlock = filtered.content[2];
    expect(markdownBlock.content[0].text).not.toContain("secret plan");

    // Non-display code blocks stay untouched.
    expect(filtered.content[3].content[0].text).toBe("const keep = true;");
  });

  test("source keeps the block but as plain text so viewers cannot translate it", () => {
    const source = doc([codeBlock("html", "<h1>Hello</h1>")]);
    const filtered = applyShareDisplayPolicyToDoc(source, { html: "source", markdown: "rendered" });
    expect(filtered.content[0].attrs.language).toBe("plaintext");
    expect(filtered.content[0].content[0].text).toContain("源码已按作者设置");
  });

  test("rendered policy returns the exact same object (no rewrite cost)", () => {
    const source = doc([codeBlock("markdown", "# title")]);
    expect(applyShareDisplayPolicyToDoc(source, DEFAULT_SHARE_DISPLAY_POLICY)).toBe(source);
  });

  test("policy parsing keeps unknown fields from breaking reads", () => {
    const policy = parseShareDisplayPolicy('{"html":"source","markdown":"hidden","extra":1}');
    expect(policy).toEqual({ html: "source", markdown: "hidden" });
  });
});

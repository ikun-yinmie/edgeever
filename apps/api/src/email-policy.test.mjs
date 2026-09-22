import { describe, expect, test } from "bun:test";
import { evaluateEmailPolicy, parseEmailPolicyEntries } from "./email-policy.ts";

describe("email policy entries", () => {
  test("normalizes case, leading @ and duplicates", () => {
    expect(parseEmailPolicyEntries(" QQ.com \n@Gmail.com, qq.com;  \n A@B.com ")).toEqual([
      "qq.com",
      "gmail.com",
      "a@b.com",
    ]);
  });

  test("returns an empty list for missing or blank input", () => {
    expect(parseEmailPolicyEntries(null)).toEqual([]);
    expect(parseEmailPolicyEntries("   \n\n ")).toEqual([]);
  });
});

describe("email policy verdicts", () => {
  test("allows everything when no policy is configured", () => {
    expect(evaluateEmailPolicy({ email: "anyone@gmail.com", allowlistEnabled: false, allowlist: null, blocklist: null }))
      .toBe("allowed");
  });

  test("blocks a domain rule without an allowlist", () => {
    const verdict = evaluateEmailPolicy({
      email: "someone@gmail.com",
      allowlistEnabled: false,
      allowlist: null,
      blocklist: "gmail.com",
    });
    expect(verdict).toBe("blocked");
  });

  test("blocks subdomains of a blocked domain", () => {
    const verdict = evaluateEmailPolicy({
      email: "someone@mail.google.com",
      allowlistEnabled: false,
      allowlist: null,
      blocklist: "google.com",
    });
    expect(verdict).toBe("blocked");
  });

  test("blocks a full address rule without affecting its domain", () => {
    const blocked = evaluateEmailPolicy({
      email: "banned@example.com",
      allowlistEnabled: false,
      allowlist: null,
      blocklist: "banned@example.com",
    });
    const sibling = evaluateEmailPolicy({
      email: "friend@example.com",
      allowlistEnabled: false,
      allowlist: null,
      blocklist: "banned@example.com",
    });
    expect(blocked).toBe("blocked");
    expect(sibling).toBe("allowed");
  });

  test("only allows listed domains once the allowlist is enabled", () => {
    const common = { allowlistEnabled: true, allowlist: "qq.com\nfoxmail.com", blocklist: null };
    expect(evaluateEmailPolicy({ email: "someone@qq.com", ...common })).toBe("allowed");
    expect(evaluateEmailPolicy({ email: "someone@vip.qq.com", ...common })).toBe("allowed");
    expect(evaluateEmailPolicy({ email: "someone@foxmail.com", ...common })).toBe("allowed");
    expect(evaluateEmailPolicy({ email: "someone@gmail.com", ...common })).toBe("not-allowlisted");
  });

  test("lets a full address through an enabled allowlist", () => {
    const verdict = evaluateEmailPolicy({
      email: "partner@outlook.com",
      allowlistEnabled: true,
      allowlist: "qq.com\npartner@outlook.com",
      blocklist: null,
    });
    expect(verdict).toBe("allowed");
    expect(evaluateEmailPolicy({
      email: "other@outlook.com",
      allowlistEnabled: true,
      allowlist: "qq.com\npartner@outlook.com",
      blocklist: null,
    })).toBe("not-allowlisted");
  });

  test("lets the blocklist win over the allowlist", () => {
    const verdict = evaluateEmailPolicy({
      email: "someone@qq.com",
      allowlistEnabled: true,
      allowlist: "qq.com",
      blocklist: "qq.com",
    });
    expect(verdict).toBe("blocked");
  });

  test("fails closed when the allowlist is enabled but empty", () => {
    const verdict = evaluateEmailPolicy({
      email: "someone@qq.com",
      allowlistEnabled: true,
      allowlist: "  ",
      blocklist: null,
    });
    expect(verdict).toBe("not-allowlisted");
  });

  test("ignores surrounding whitespace and casing in the email", () => {
    const verdict = evaluateEmailPolicy({
      email: "  Someone@QQ.com ",
      allowlistEnabled: true,
      allowlist: "qq.com",
      blocklist: null,
    });
    expect(verdict).toBe("allowed");
  });
});

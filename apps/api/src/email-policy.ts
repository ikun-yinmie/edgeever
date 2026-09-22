// Email policy for self-registration.
//
// Rules are written one per line and accept either a domain (example.com) or a
// full address (name@example.com). A domain rule also covers its subdomains, so
// "google.com" blocks "mail.google.com" as well. The blocklist always wins over
// the allowlist.

export type EmailPolicyVerdict = "allowed" | "blocked" | "not-allowlisted";

export type EmailPolicyInput = {
  email: string;
  allowlistEnabled: boolean;
  allowlist: string | null | undefined;
  blocklist: string | null | undefined;
};

const normalizeEntry = (raw: string) => raw.trim().toLowerCase().replace(/^@/, "");

export const parseEmailPolicyEntries = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  const entries = raw
    .split(/[\n,;]+/)
    .map(normalizeEntry)
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(entries));
};

const matchesEntry = (email: string, domain: string, entry: string) => {
  if (entry.includes("@")) return entry === email;
  return domain === entry || domain.endsWith(`.${entry}`);
};

export const evaluateEmailPolicy = (input: EmailPolicyInput): EmailPolicyVerdict => {
  const email = input.email.trim().toLowerCase();
  const atIndex = email.lastIndexOf("@");
  const domain = atIndex === -1 ? "" : email.slice(atIndex + 1);

  const blocked = parseEmailPolicyEntries(input.blocklist);
  if (domain && blocked.some((entry) => matchesEntry(email, domain, entry))) return "blocked";

  if (!input.allowlistEnabled) return "allowed";

  const allowed = parseEmailPolicyEntries(input.allowlist);
  if (!domain || allowed.length === 0) return "not-allowlisted";
  return allowed.some((entry) => matchesEntry(email, domain, entry)) ? "allowed" : "not-allowlisted";
};

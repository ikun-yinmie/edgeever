import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SITE_NAME,
  getSiteDisplayName,
  setClientOverrideName,
  applySiteBranding,
} from "./site-branding";

describe("site-branding library", () => {
  it("defaults to EdgeEver", () => {
    setClientOverrideName(null);
    expect(getSiteDisplayName({ name: null, description: null, iconUpdatedAt: null })).toBe(DEFAULT_SITE_NAME);
  });

  it("uses server site name when no client override is active", () => {
    setClientOverrideName(null);
    expect(getSiteDisplayName({ name: "Server Wiki", description: null, iconUpdatedAt: null })).toBe("Server Wiki");
  });

  it("prefers client override name when provided", () => {
    setClientOverrideName("My Desktop Notes");
    expect(getSiteDisplayName({ name: "Server Wiki", description: null, iconUpdatedAt: null })).toBe("My Desktop Notes");

    // Clean up
    setClientOverrideName(null);
    expect(getSiteDisplayName({ name: "Server Wiki", description: null, iconUpdatedAt: null })).toBe("Server Wiki");
  });

  it("handles empty or whitespace strings safely", () => {
    setClientOverrideName("   ");
    expect(getSiteDisplayName({ name: "   ", description: null, iconUpdatedAt: null })).toBe(DEFAULT_SITE_NAME);
  });
});

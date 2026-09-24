import { describe, expect, test } from "bun:test";
import { imageNameFromRemote, isImageBuildTriggered, parseDeployEnv } from "./deploy-main.mjs";

describe("fork deployment trigger detection", () => {
  test("matches the paths that make the custom Docker image workflow build", () => {
    expect(isImageBuildTriggered(["apps/web/src/components/AdminConsolePane.tsx"])).toBe(true);
    expect(isImageBuildTriggered(["packages/shared/src/i18n/zh-CN.ts"])).toBe(true);
    expect(isImageBuildTriggered(["apps/api/src/index.ts"])).toBe(true);
    expect(isImageBuildTriggered(["Dockerfile"])).toBe(true);
    expect(isImageBuildTriggered(["scripts/self-hosted-server.mjs"])).toBe(true);
    expect(isImageBuildTriggered(["./.github/workflows/custom-docker-image.yml"])).toBe(true);
  });

  test("ignores changes that never reach the image", () => {
    expect(isImageBuildTriggered(["README.zh-CN.md", "docs/admin.md"])).toBe(false);
    expect(isImageBuildTriggered(["AGENTS.md"])).toBe(false);
    expect(isImageBuildTriggered([])).toBe(false);
  });
});

describe("fork deployment targets", () => {
  test("derives the GHCR repository from the origin remote", () => {
    expect(imageNameFromRemote("git@github.com:ikun-yinmie/edgeever.git")).toBe("ghcr.io/ikun-yinmie/edgeever");
    expect(imageNameFromRemote("https://github.com/ikun-yinmie/edgeever.git")).toBe("ghcr.io/ikun-yinmie/edgeever");
    expect(imageNameFromRemote("git@gitlab.com:someone/edgeever.git")).toBe(null);
  });

  test("reads only the deployment keys from the compose env file", () => {
    const env = parseDeployEnv(
      ["# EdgeEver 本地部署", "EDGE_EVER_IMAGE=ghcr.io/ikun-yinmie/edgeever", 'EDGE_EVER_VERSION="main"', "EDGE_EVER_PORT=9634", "EDGE_EVER_AUTH_PASSWORD=secret"].join("\n"),
    );
    expect(env).toEqual({
      EDGE_EVER_IMAGE: "ghcr.io/ikun-yinmie/edgeever",
      EDGE_EVER_VERSION: "main",
      EDGE_EVER_PORT: "9634",
    });
  });
});

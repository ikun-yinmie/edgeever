import { describe, expect, test } from "bun:test";
import {
  CRON_BLOCK_END,
  CRON_BLOCK_START,
  buildAlertPayload,
  buildCronLines,
  decideWatchAction,
  formatLogLine,
  isProcessAlive,
  nextStateAfterDeploy,
  stripManagedCronBlock,
  upsertManagedCronBlock,
} from "./watch-image.mjs";

describe("image watch decisions", () => {
  const base = { containerRevision: "aaaa", imageRevision: "bbbb", blockedRevision: null };

  test("only deploys when the published revision differs from the running one", () => {
    expect(decideWatchAction(base)).toEqual({ type: "deploy", reason: "new-revision" });
    expect(decideWatchAction({ ...base, imageRevision: "aaaa" })).toEqual({ type: "up-to-date" });
    expect(decideWatchAction({ ...base, force: true })).toEqual({ type: "deploy", reason: "forced" });
  });

  test("skips a revision that already failed, but not a newer one", () => {
    expect(decideWatchAction({ ...base, blockedRevision: "bbbb" })).toEqual({ type: "blocked" });
    expect(decideWatchAction({ ...base, blockedRevision: "cccc" }).type).toBe("deploy");
  });

  test("reports missing container and unreadable image instead of deploying blind", () => {
    expect(decideWatchAction({ ...base, containerRevision: "" })).toEqual({ type: "no-container" });
    expect(decideWatchAction({ ...base, imageRevision: "" })).toEqual({ type: "unknown-image" });
  });
});

describe("image watch state", () => {
  const state = { deployedRevision: "aaaa", blockedRevision: null, previous: null, pullFailures: 4 };

  test("a successful deploy clears the block and resets the pull counters", () => {
    const next = nextStateAfterDeploy({
      state,
      deployedRevision: "bbbb",
      previous: { imageId: "sha256:1", revision: "aaaa" },
      succeeded: true,
    });
    expect(next.deployedRevision).toBe("bbbb");
    expect(next.blockedRevision).toBe(null);
    expect(next.previous).toEqual({ imageId: "sha256:1", revision: "aaaa" });
    expect(next.pullFailures).toBe(0);
  });

  test("a failed deploy keeps the running revision and blocks the broken one", () => {
    const next = nextStateAfterDeploy({ state, deployedRevision: "bbbb", previous: null, succeeded: false });
    expect(next.deployedRevision).toBe("aaaa");
    expect(next.blockedRevision).toBe("bbbb");
  });
});

describe("managed crontab block", () => {
  const existing = ["*/2 * * * * /home/hashiqi/easytier/scripts/easytier-healthcheck.sh", ""].join("\n");

  test("keeps foreign entries and replaces only the managed block", () => {
    const lines = buildCronLines({
      repoRoot: "/repo",
      bunPath: "/bun",
      scriptPath: "/repo/scripts/watch-image.mjs",
      deployDir: "/deploy",
      intervalMinutes: 5,
    });
    const once = upsertManagedCronBlock(existing, lines);
    const twice = upsertManagedCronBlock(once, lines);
    expect(once).toContain("easytier-healthcheck.sh");
    expect(once).toBe(twice);
    expect(once.match(new RegExp(CRON_BLOCK_START, "g"))).toHaveLength(1);
    expect(once.indexOf(existing.trim())).toBe(0);
    expect(once.trimEnd().endsWith(CRON_BLOCK_END)).toBe(true);
    expect(lines[0]).toContain("export PATH=/usr/local/bin:/usr/bin:/bin;");
    expect(lines[0]).toContain("[ -f '/repo/scripts/watch-image.mjs' ]");
    expect(lines[0]).toContain("*/5 * * * *");
    expect(lines[0]).toContain("cd '/repo'");
    expect(lines[0]).toContain(">> '/deploy/.image-watch.log' 2>&1");
  });

  test("bakes the alert webhook into the cron line, because cron never reads a shell profile", () => {
    const withWebhook = buildCronLines({
      repoRoot: "/repo",
      bunPath: "/bun",
      scriptPath: "/repo/scripts/watch-image.mjs",
      deployDir: "/deploy",
      webhookUrl: "https://example.com/hook",
    });
    expect(withWebhook[0]).toContain("EDGE_EVER_ALERT_WEBHOOK='https://example.com/hook'");
    const withoutWebhook = buildCronLines({ repoRoot: "/repo", bunPath: "/bun", scriptPath: "/s", deployDir: "/deploy" });
    expect(withoutWebhook[0]).not.toContain("EDGE_EVER_ALERT_WEBHOOK");
  });

  test("removing the block restores the original crontab", () => {
    const withBlock = upsertManagedCronBlock(existing, ["*/5 * * * * true"]);
    expect(stripManagedCronBlock(withBlock)).toBe(existing.trim());
  });
});

describe("alerting helpers", () => {
  test("webhook payload carries the text, kind and revision", () => {
    expect(buildAlertPayload({ kind: "deploy-success", title: "已自动更新", detail: "revision bbbb", image: "ghcr.io/a/b:main", revision: "bbbb" })).toEqual({
      source: "edgeever-image-watch",
      kind: "deploy-success",
      image: "ghcr.io/a/b:main",
      revision: "bbbb",
      text: "已自动更新\nrevision bbbb",
    });
  });

  test("log lines are timestamped and prefixed with the level", () => {
    const line = formatLogLine("WARN", "拉取失败", new Date("2026-09-24T03:05:00Z"));
    expect(line).toBe("[2026-09-24T03:05:00.000Z] WARN 拉取失败");
  });

  test("pid liveness detection rejects impossible pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_000)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

#!/usr/bin/env bun
/**
 * 服务器端镜像跟随器：发现 GHCR `:main` 的新 revision 就拉取、重建容器、
 * 校验健康；新版本起不来时自动回滚到上一个镜像并告警。
 *
 * 由 crontab 周期性调用（每次只跑一轮，默认静默）：
 *   bun scripts/watch-image.mjs --install-cron --interval-minutes 5
 *   bun scripts/watch-image.mjs --verbose          # 手动跑一轮看细节
 *   bun scripts/watch-image.mjs --dry-run          # 只报告将要做什么
 *
 * 告警通道（全部可选，互不冲突）：日志文件、桌面通知（notify-send）、
 * `EDGE_EVER_ALERT_WEBHOOK` 指向的 HTTP 端点（收到 JSON）。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseDeployEnv } from "./deploy-main.mjs";

export const CRON_BLOCK_START = "# >>> edgeever-image-watch >>>";
export const CRON_BLOCK_END = "# <<< edgeever-image-watch <<<";
export const WATCH_STATE_FILE = ".image-watch.json";
export const WATCH_LOG_FILE = ".image-watch.log";
export const WATCH_LOCK_FILE = ".image-watch.lock";
export const PULL_FAILURE_ALERT_THRESHOLD = 3;
export const LOCK_STALE_MINUTES = 20;

/** 汇总本轮需要人关注的日志行，供 cron 邮件等非 verbose 场景使用。 */
const notableLogLines = [];

/** 一轮检查的决策：只看 revision 与状态，不碰 docker。 */
export const decideWatchAction = ({ containerRevision, imageRevision, blockedRevision, force = false }) => {
  if (!containerRevision) return { type: "no-container" };
  if (force) return { type: "deploy", reason: "forced" };
  if (!imageRevision) return { type: "unknown-image" };
  if (imageRevision === containerRevision) return { type: "up-to-date" };
  if (blockedRevision && blockedRevision === imageRevision) return { type: "blocked" };
  return { type: "deploy", reason: "new-revision" };
};

/** 部署失败的版本要记住，避免每轮都重试同一个坏镜像。 */
export const nextStateAfterDeploy = ({ state, deployedRevision, previous, succeeded }) => ({
  ...state,
  deployedRevision: succeeded ? deployedRevision : state.deployedRevision,
  blockedRevision: succeeded ? null : deployedRevision,
  previous: previous ?? state.previous ?? null,
  pullFailures: 0,
  lastDeployAt: new Date().toISOString(),
});

export const stripManagedCronBlock = (crontab) => {
  const lines = crontab.split("\n");
  const kept = [];
  let insideBlock = false;
  for (const line of lines) {
    if (line.trim() === CRON_BLOCK_START) {
      insideBlock = true;
      continue;
    }
    if (line.trim() === CRON_BLOCK_END) {
      insideBlock = false;
      continue;
    }
    if (!insideBlock) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

export const upsertManagedCronBlock = (crontab, blockLines) => {
  const base = stripManagedCronBlock(crontab);
  const block = [CRON_BLOCK_START, ...blockLines, CRON_BLOCK_END].join("\n");
  return base ? `${base}\n${block}\n` : `${block}\n`;
};

/** cron 的 PATH 通常只有 /usr/bin:/bin，而 docker 常装在 /usr/local/bin。 */
export const DEFAULT_CRON_PATH = "/usr/local/bin:/usr/bin:/bin";

export const buildCronLines = ({
  repoRoot,
  bunPath,
  scriptPath,
  deployDir,
  intervalMinutes = 5,
  pathValue = DEFAULT_CRON_PATH,
  webhookUrl = null,
}) => [
  // cron 不读 shell profile，告警地址必须在行内显式声明；
  // 仓库盘没挂上时静默跳过，避免 cron 每 5 分钟发一封失败邮件。
  `*/${intervalMinutes} * * * * ${webhookUrl ? `EDGE_EVER_ALERT_WEBHOOK='${webhookUrl}' ` : ""}export PATH=${pathValue}; [ -f '${scriptPath}' ] && cd '${repoRoot}' && '${bunPath}' '${scriptPath}' --deploy-dir '${deployDir}' >> '${path.join(deployDir, WATCH_LOG_FILE)}' 2>&1`,
];

export const buildAlertPayload = ({ kind, title, detail, image, revision }) => ({
  source: "edgeever-image-watch",
  kind,
  image,
  revision,
  text: detail ? `${title}\n${detail}` : title,
});

export const formatLogLine = (level, message, at = new Date()) => `[${at.toISOString()}] ${level} ${message}`;

export const isNotableLevel = (level) => level === "WARN" || level === "ALERT" || level === "ERROR";

const run = (command, args, { cwd, capture = true } = {}) => {
  const output = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return capture && typeof output === "string" ? output.trim() : "";
};

const runQuiet = (command, args, options) => {
  try {
    return run(command, args, options);
  } catch {
    return "";
  }
};

const containerRevision = (container) =>
  runQuiet("docker", ["inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', container]);

const containerImageId = (container) => runQuiet("docker", ["inspect", "-f", "{{.Image}}", container]);

const containerStartedAt = (container) => runQuiet("docker", ["inspect", "-f", "{{.State.StartedAt}}", container]);

const containerHealth = (container) => runQuiet("docker", ["inspect", "-f", "{{.State.Health.Status}}", container]);

const imageRevision = (image) =>
  runQuiet("docker", ["image", "inspect", image, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}']);

const pullImage = (image) => {
  try {
    runQuiet("docker", ["pull", "-q", image]);
    return null;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : error?.stderr?.toString?.() ?? "";
    const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.at(-1) ?? error?.message ?? "unknown docker pull failure";
  }
};

const readState = (statePath) => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
};

const writeState = (statePath, state) => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

export const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquireLock = (lockPath, now = Date.now()) => {
  if (existsSync(lockPath)) {
    const [rawPid, rawStartedAt] = readFileSync(lockPath, "utf8").trim().split("\n");
    const pid = Number.parseInt(rawPid ?? "", 10);
    const startedAt = Date.parse(rawStartedAt ?? "");
    const fresh = Number.isFinite(startedAt) && now - startedAt < LOCK_STALE_MINUTES * 60_000;
    if (fresh && isProcessAlive(pid)) return { acquired: false, holder: pid };
  }
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  return { acquired: true };
};

const sendWebhook = async (url, payload) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const notifyDesktop = (title, detail) => {
  const runtimeDir = `/run/user/${process.getuid?.() ?? 1000}/bus`;
  const env = { ...process.env };
  if (!env.DBUS_SESSION_BUS_ADDRESS && existsSync(runtimeDir)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}`;
  if (!env.DISPLAY) env.DISPLAY = ":0";
  try {
    execFileSync("notify-send", ["--urgency=normal", "--app-name=EdgeEver", title, detail || ""], {
      env,
      stdio: "ignore",
      timeout: 10_000,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * 等新容器健康：先确认跑的是新镜像（镜像 ID 变了，或容器被重建过），再看 health。
 * 只看 StartedAt 会在“镜像没变、容器未重建”时误报失败。
 */
const waitForHealthy = async ({ container, expectedImageId, expectedStartedAt, timeoutSeconds, fetchPort }) => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const currentImageId = containerImageId(container);
    const startedAt = containerStartedAt(container);
    const isNewContainer =
      (expectedImageId && currentImageId === expectedImageId) ||
      (!expectedImageId && startedAt && startedAt !== expectedStartedAt);
    if (isNewContainer) {
      lastStatus = containerHealth(container) || "unknown";
      if (lastStatus === "healthy") {
        const httpStatus = await fetch(`http://127.0.0.1:${fetchPort}/`)
          .then((response) => response.status)
          .catch(() => 0);
        return { healthy: true, httpStatus };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { healthy: false, httpStatus: 0, lastStatus };
};

const usage = () => {
  console.log(`用法: bun scripts/watch-image.mjs [options]

选项:
  --deploy-dir <dir>         compose.yaml 所在目录（默认 $EDGE_EVER_DEPLOY_DIR 或 ~/Documents/EdgeEver）
  --service <name>           compose 服务名 / 容器名（默认 edgeever）
  --image <ref>              覆盖被跟踪的镜像（默认取部署目录 .env 的 EDGE_EVER_IMAGE:EDGE_EVER_VERSION）
  --webhook <url>            覆盖 EDGE_EVER_ALERT_WEBHOOK
  --poll-seconds <n>         单次运行内轮询健康检查的总时长（默认 120）
  --interval-minutes <n>     --install-cron 的时间间隔（默认 5）
  --force                    即使 revision 相同也重新部署一次（用于演练）
  --skip-pull                假定镜像已在本地，不访问 registry（本地构建/离线场景与演练用）
  --dry-run                  只报告将要执行的动作
  --verbose                  把日志同时打到 stdout
  --install-cron             写入用户 crontab 的托管块
  --uninstall-cron           移除用户 crontab 的托管块
  --help, -h                 显示帮助`);
};

const parseArgs = (argv) => {
  const options = { service: "edgeever", pollSeconds: 120, intervalMinutes: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`缺少 ${arg} 的参数值`);
      index += 1;
      return value;
    };
    if (arg === "--deploy-dir") options.deployDir = next();
    else if (arg === "--service") options.service = next();
    else if (arg === "--image") options.image = next();
    else if (arg === "--webhook") options.webhook = next();
    else if (arg === "--poll-seconds") options.pollSeconds = Number(next()) || 120;
    else if (arg === "--interval-minutes") options.intervalMinutes = Number(next()) || 5;
    else if (arg === "--force") options.force = true;
    else if (arg === "--skip-pull") options.skipPull = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--install-cron") options.installCron = true;
    else if (arg === "--uninstall-cron") options.uninstallCron = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
};

const installCron = ({ repoRoot, deployDir, intervalMinutes, webhookUrl = null, remove = false }) => {
  const existing = runQuiet("crontab", ["-l"]) || "";
  if (remove) {
    run("bash", ["-c", `crontab - <<'CRON'\n${stripManagedCronBlock(existing)}\nCRON`], { capture: false });
    return "已移除 crontab 托管块";
  }
  const lines = buildCronLines({
    repoRoot,
    bunPath: process.execPath,
    scriptPath: path.join(repoRoot, "scripts", "watch-image.mjs"),
    deployDir,
    intervalMinutes,
    webhookUrl,
  });
  run("bash", ["-c", `crontab - <<'CRON'\n${upsertManagedCronBlock(existing, lines)}\nCRON`], { capture: false });
  return `已写入 crontab 托管块（每 ${intervalMinutes} 分钟检查一次${webhookUrl ? "，告警已接入 webhook" : ""}）`;
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }

  const repoRoot = run("git", ["rev-parse", "--show-toplevel"]);
  process.chdir(repoRoot);

  const deployDir = options.deployDir ?? process.env.EDGE_EVER_DEPLOY_DIR ?? path.join(homedir(), "Documents", "EdgeEver");
  const composeFile = path.join(deployDir, "compose.yaml");
  if (!existsSync(composeFile)) throw new Error(`找不到 compose 文件: ${composeFile}`);

  if (options.installCron || options.uninstallCron) {
    const result = installCron({
      repoRoot,
      deployDir,
      intervalMinutes: options.intervalMinutes,
      webhookUrl: options.webhook ?? process.env.EDGE_EVER_ALERT_WEBHOOK ?? null,
      remove: options.uninstallCron,
    });
    console.log(result);
    return 0;
  }

  const envFile = path.join(deployDir, ".env");
  const deployEnv = existsSync(envFile) ? parseDeployEnv(readFileSync(envFile, "utf8")) : {};
  const image = options.image ?? `${deployEnv.EDGE_EVER_IMAGE ?? "ghcr.io/ikun-yinmie/edgeever"}:${deployEnv.EDGE_EVER_VERSION ?? "main"}`;
  const port = deployEnv.EDGE_EVER_PORT ?? "8787";
  const webhookUrl = options.webhook ?? process.env.EDGE_EVER_ALERT_WEBHOOK ?? null;
  const statePath = path.join(deployDir, WATCH_STATE_FILE);
  const logPath = path.join(deployDir, WATCH_LOG_FILE);
  const lockPath = path.join(deployDir, WATCH_LOCK_FILE);
  const state = readState(statePath);

  const write = (level, message) => {
    const line = formatLogLine(level, message);
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // 日志失败不能影响部署本身
    }
    if (isNotableLevel(level)) notableLogLines.push(line);
    if (options.verbose) console.log(line);
  };

  const alert = async ({ kind, title, detail = "", revision = null, dedupe = true }) => {
    write("ALERT", `${kind}: ${title}${detail ? ` — ${detail}` : ""}`);
    if (dedupe && state.lastAlertKind === kind && state.lastAlertRevision === revision) return;
    state.lastAlertKind = kind;
    state.lastAlertRevision = revision;
    writeState(statePath, state);

    const payload = buildAlertPayload({ kind, title, detail, image, revision });
    notifyDesktop(`EdgeEver ${title}`, detail);
    if (webhookUrl) {
      const failure = await sendWebhook(webhookUrl, payload);
      write(failure ? "WARN" : "INFO", failure ? `webhook 发送失败: ${failure}` : "webhook 已发送");
    }
  };

  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    write("INFO", `上一轮仍在运行（pid ${lock.holder}），跳过本次检查`);
    return 0;
  }

  try {
    state.lastCheckAt = new Date().toISOString();
    const currentRevision = options.skipPull ? imageRevision(image) : null;

    if (!options.skipPull) {
      const pullFailure = pullImage(image);
      if (pullFailure) {
        state.pullFailures = (state.pullFailures ?? 0) + 1;
        writeState(statePath, state);
        write("WARN", `拉取镜像失败（连续 ${state.pullFailures} 次）：${pullFailure}`);
        const shouldAlertOnPullFailures =
          state.pullFailures === PULL_FAILURE_ALERT_THRESHOLD || state.pullFailures % 12 === 0;
        if (shouldAlertOnPullFailures) {
          await alert({
            kind: "pull-failing",
            title: "镜像连续拉取失败",
            detail: `连续 ${state.pullFailures} 次失败：${pullFailure}`,
            revision: `pull-failing-${state.pullFailures}`,
            dedupe: false,
          });
        }
        return 1;
      }
      state.pullFailures = 0;
    }

    const targetRevision = options.skipPull ? currentRevision : imageRevision(image);
    const runningRevision = containerRevision(options.service);
    const action = decideWatchAction({
      containerRevision: runningRevision,
      imageRevision: targetRevision,
      blockedRevision: state.blockedRevision,
      force: options.force,
    });
    write(
      "INFO",
      `检查完成 container=${runningRevision || "-"} image=${targetRevision || "-"} action=${action.type}${action.reason ? `(${action.reason})` : ""}`,
    );

    if (action.type === "no-container") {
      writeState(statePath, state);
      await alert({
        kind: "container-missing",
        title: "找不到运行中的容器",
        detail: `服务 ${options.service} 未运行，自动更新已暂停`,
        revision: null,
        dedupe: false,
      });
      return 1;
    }
    if (action.type === "up-to-date") {
      state.blockedRevision = null;
      writeState(statePath, state);
      return 0;
    }
    if (action.type === "blocked") {
      write("WARN", `版本 ${targetRevision.slice(0, 7)} 上次部署失败，已跳过；等新提交发布后再试`);
      writeState(statePath, state);
      await alert({
        kind: "blocked-skipped",
        title: "跳过已知失败的版本",
        detail: `${targetRevision.slice(0, 7)} 上次未通过健康检查，等待更新的镜像`,
        revision: targetRevision,
      });
      return 0;
    }
    if (action.type === "unknown-image") {
      write("WARN", "无法读取镜像的 revision 标签，暂不部署");
      writeState(statePath, state);
      return 1;
    }

    if (options.dryRun) {
      write("INFO", `dry-run：将把 ${options.service} 更新到 ${targetRevision.slice(0, 7)}`);
      writeState(statePath, state);
      return 0;
    }

    const previous = {
      imageId: containerImageId(options.service) || null,
      revision: runningRevision || null,
    };
    const startedBefore = containerStartedAt(options.service);
    const targetImageId = runQuiet("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);

    state.status = "deploying";
    writeState(statePath, state);
    write("INFO", `开始部署 ${targetRevision.slice(0, 7)}（上一个 ${previous.revision?.slice(0, 7) ?? "-"}）`);

    if (!options.skipPull) {
      run("docker", ["compose", "-f", composeFile, "pull", options.service], { cwd: deployDir, capture: false });
    }
    run("docker", ["compose", "-f", composeFile, "up", "-d", options.service], { cwd: deployDir, capture: false });

    const health = await waitForHealthy({
      container: options.service,
      expectedImageId: targetImageId,
      expectedStartedAt: startedBefore,
      timeoutSeconds: options.pollSeconds,
      fetchPort: port,
    });

    if (health.healthy) {
      Object.assign(state, nextStateAfterDeploy({ state, deployedRevision: targetRevision, previous, succeeded: true }));
      state.status = "idle";
      state.lastHttpStatus = health.httpStatus;
      writeState(statePath, state);
      write("INFO", `部署成功 ${targetRevision.slice(0, 7)}（HTTP ${health.httpStatus || "-"}）`);
      await alert({
        kind: "deploy-success",
        title: "已自动更新",
        detail: `镜像 revision ${targetRevision.slice(0, 7)} 已上线，HTTP ${health.httpStatus || "-"}`,
        revision: targetRevision,
        dedupe: false,
      });
      if (!health.httpStatus) {
        await alert({
          kind: "http-check-failed",
          title: "容器健康但 HTTP 自检未通过",
          detail: `容器 healthy，但 http://127.0.0.1:${port}/ 无响应`,
          revision: targetRevision,
        });
      }
      return 0;
    }

    write("WARN", `新版本未通过健康检查（${health.lastStatus ?? "unknown"}），开始回滚`);
    let rolledBack = false;
    if (previous.imageId) {
      try {
        run("docker", ["tag", previous.imageId, image]);
        run("docker", ["compose", "-f", composeFile, "up", "-d", "--force-recreate", options.service], {
          cwd: deployDir,
          capture: false,
        });
        const rollbackHealth = await waitForHealthy({
          container: options.service,
          expectedImageId: previous.imageId,
          expectedStartedAt: containerStartedAt(options.service),
          timeoutSeconds: options.pollSeconds,
          fetchPort: port,
        });
        rolledBack = rollbackHealth.healthy;
      } catch (error) {
        write("ERROR", `回滚执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      write("ERROR", "没有可回滚的上一个镜像");
    }

    Object.assign(state, nextStateAfterDeploy({ state, deployedRevision: targetRevision, previous, succeeded: false }));
    state.status = rolledBack ? "idle" : "broken";
    state.lastRollbackAt = new Date().toISOString();
    writeState(statePath, state);

    await alert({
      kind: rolledBack ? "deploy-failed-rolled-back" : "rollback-failed",
      title: rolledBack ? "新版本部署失败，已回滚" : "新版本部署失败，回滚未恢复",
      detail: rolledBack
        ? `${targetRevision.slice(0, 7)} 未通过健康检查，已恢复 ${previous.revision?.slice(0, 7) ?? "上一个镜像"}；该版本会被跳过直到有新提交`
        : `${targetRevision.slice(0, 7)} 未通过健康检查，回滚后仍不健康，请手动检查 docker logs ${options.service}`,
      revision: targetRevision,
      dedupe: false,
    });
    return 1;
  } finally {
    rmSync(lockPath, { force: true });
  }
};

if (import.meta.main) {
  const verbose = process.argv.includes("--verbose");
  main()
    .then((code) => {
      // 非 verbose 时只为“需要人看”的结果输出，让 cron 顺带发一封邮件。
      if ((code ?? 0) !== 0 && !verbose && notableLogLines.length > 0) {
        console.log(`EdgeEver 自动更新需要关注：\n${notableLogLines.slice(-6).join("\n")}`);
      }
      process.exit(code ?? 0);
    })
    .catch((error) => {
      console.error(`[watch] 失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

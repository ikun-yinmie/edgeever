#!/usr/bin/env bun
/**
 * One-command fork deployment: commit → push origin main → wait for the GHCR
 * image → recreate the local compose container.
 *
 * 用法（默认作者是 Codebuff，可用 --no-trailer 关闭）：
 *   bun scripts/deploy-main.mjs --message "Fix the member status column" --paths apps/web/src/components/settings/UserManagementCard.tsx
 *   git add -A && bun scripts/deploy-main.mjs --message "..."
 *
 * 只改文档/脚本且没有命中镜像构建路径时，脚本会跳过等待与重建并明确说明原因。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 与 .github/workflows/custom-docker-image.yml 的 push.paths 保持一致。 */
export const IMAGE_BUILD_TRIGGER_PATTERNS = [
  "apps/api/",
  "apps/web/",
  "packages/",
  "migrations/",
  "patches/",
];

export const IMAGE_BUILD_TRIGGER_FILES = [
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  "bunfig.toml",
  "package.json",
  "bun.lock",
  "tailwind.config.ts",
  "tsconfig.json",
  ".github/workflows/custom-docker-image.yml",
];

export const isImageBuildTriggered = (changedFiles) =>
  changedFiles.some((file) => {
    const normalized = file.trim().replace(/^\.\//, "");
    if (!normalized) return false;
    if (IMAGE_BUILD_TRIGGER_FILES.includes(normalized)) return true;
    if (IMAGE_BUILD_TRIGGER_PATTERNS.some((prefix) => normalized.startsWith(prefix))) return true;
    return /^scripts\/self-hosted-.*\.mjs$/.test(normalized);
  });

export const imageNameFromRemote = (remoteUrl) => {
  const sshMatch = /git@([^:]+):(.+?)(?:\.git)?$/.exec(remoteUrl.trim());
  const httpsMatch = /https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl.trim());
  const match = sshMatch ?? httpsMatch;
  if (!match) return null;
  const [, host, repository] = match;
  if (host !== "github.com") return null;
  return `ghcr.io/${repository.toLowerCase()}`;
};

/** 只取部署需要的键，避免把 .env 里的密钥读进日志。 */
export const parseDeployEnv = (content) => {
  const values = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!["EDGE_EVER_IMAGE", "EDGE_EVER_VERSION", "EDGE_EVER_PORT"].includes(key)) continue;
    values[key] = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
  }
  return values;
};

const COMMIT_TRAILER = "🤖 Generated with Codebuff\nCo-Authored-By: Codebuff <noreply@codebuff.com>";

const log = (message) => console.log(`[deploy] ${message}`);

const run = (command, args, { cwd, capture = true } = {}) => {
  const output = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  // stdio: "inherit" returns null.
  return capture && typeof output === "string" ? output.trim() : "";
};

const runQuiet = (command, args, options) => {
  try {
    return run(command, args, options);
  } catch {
    return "";
  }
};

const usage = () => {
  console.log(`用法: bun scripts/deploy-main.mjs --message "<commit message>" [options]

选项:
  --message, -m <text>   提交信息（必填，除非改动已提交）
  --paths <a,b,c>        只提交这些路径（默认提交已暂存的改动）
  --deploy-dir <dir>     承载 compose.yaml 的部署目录（默认 $EDGE_EVER_DEPLOY_DIR 或 ~/Documents/EdgeEver）
  --service <name>       compose 服务名（默认 edgeever）
  --timeout-minutes <n>  等待镜像发布的超时（默认 20）
  --skip-wait            不等待镜像，直接重建容器
  --skip-deploy          只提交并推送
  --no-push              只提交，不推送也不部署（用于整理多个提交后再一次性部署）
  --no-trailer           提交信息不追加 Codebuff 尾注
  --help, -h             显示帮助`);
};

const parseArgs = (argv) => {
  const options = { timeoutMinutes: 20, service: "edgeever" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`缺少 ${arg} 的参数值`);
      index += 1;
      return value;
    };
    if (arg === "--message" || arg === "-m") options.message = next();
    else if (arg === "--paths") options.paths = next().split(",").map((value) => value.trim()).filter(Boolean);
    else if (arg === "--deploy-dir") options.deployDir = next();
    else if (arg === "--service") options.service = next();
    else if (arg === "--timeout-minutes") options.timeoutMinutes = Number(next()) || 20;
    else if (arg === "--skip-wait") options.skipWait = true;
    else if (arg === "--skip-deploy") options.skipDeploy = true;
    else if (arg === "--no-push") options.noPush = true;
    else if (arg === "--no-trailer") options.noTrailer = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
};

const inspectImageRevision = (image) =>
  runQuiet("docker", ["image", "inspect", image, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}']);

/** docker pull 失败时保留同样的话，否则轮询循环会静默超时。 */
export const describePullFailure = (error) => {
  const stderr = typeof error?.stderr === "string" ? error.stderr : error?.stderr?.toString?.() ?? "";
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? error?.message ?? "unknown docker pull failure";
};

const pullImage = (image) => {
  try {
    runQuiet("docker", ["pull", "-q", image]);
    return null;
  } catch (error) {
    return describePullFailure(error);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }

  const repositoryRoot = run("git", ["rev-parse", "--show-toplevel"]);
  process.chdir(repositoryRoot);

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") throw new Error(`当前分支是 ${branch}，本脚本只部署 main`);

  const remoteUrl = run("git", ["remote", "get-url", "origin"]);
  const imageRepository = imageNameFromRemote(remoteUrl);
  if (!imageRepository) throw new Error(`无法从 origin 推导 GHCR 镜像名: ${remoteUrl}`);

  const previousSha = runQuiet("git", ["rev-parse", "origin/main"]) || null;

  if (options.paths?.length) run("git", ["add", "--", ...options.paths], { capture: false });

  const staged = run("git", ["diff", "--cached", "--name-only"]);
  const hasStagedChanges = Boolean(staged);
  let commitSha = run("git", ["rev-parse", "HEAD"]);

  if (hasStagedChanges) {
    if (!options.message) throw new Error("有已暂存的改动，请用 --message 提供提交信息");
    const body = options.noTrailer ? options.message : `${options.message}\n\n${COMMIT_TRAILER}`;
    run("git", ["commit", "-m", body], { capture: false });
    commitSha = run("git", ["rev-parse", "HEAD"]);
    log(`已提交 ${commitSha.slice(0, 7)}（${staged.split("\n").length} 个文件）`);
  } else if (options.message) {
    log("没有已暂存的改动，跳过提交，只推送并部署当前 HEAD");
  }

  if (options.noPush) {
    log("--no-push：已提交，未推送（稍后不带改动再跑一次即可推送并部署）");
    return 0;
  }

  const ahead = runQuiet("git", ["rev-list", "--count", `origin/main..HEAD`]);
  if (ahead && ahead !== "0") {
    run("git", ["push", "origin", "main"], { capture: false });
    log(`已推送到 origin/main（${commitSha.slice(0, 7)}）`);
  } else {
    log("origin/main 已包含当前提交，跳过推送");
  }

  if (options.skipDeploy) {
    log("--skip-deploy：到此结束");
    return 0;
  }

  const deployDir = options.deployDir ?? process.env.EDGE_EVER_DEPLOY_DIR ?? path.join(homedir(), "Documents", "EdgeEver");
  const composeFile = path.join(deployDir, "compose.yaml");
  if (!existsSync(composeFile)) throw new Error(`找不到 compose 文件: ${composeFile}`);
  const envFile = path.join(deployDir, ".env");
  const deployEnv = existsSync(envFile) ? parseDeployEnv(readFileSync(envFile, "utf8")) : {};
  const image = `${deployEnv.EDGE_EVER_IMAGE ?? imageRepository}:${deployEnv.EDGE_EVER_VERSION ?? "main"}`;
  const port = deployEnv.EDGE_EVER_PORT ?? "8787";

  if (previousSha && previousSha !== commitSha) {
    const changedFiles = run("git", ["diff", "--name-only", previousSha, commitSha]).split("\n").filter(Boolean);
    if (!isImageBuildTriggered(changedFiles)) {
      log("本次改动不命中镜像构建路径，CI 不会发布新镜像，跳过重建容器");
      return 0;
    }
  }

  if (!options.skipWait) {
    const deadline = Date.now() + options.timeoutMinutes * 60_000;
    log(`等待 ${image} 发布出 ${commitSha.slice(0, 7)}（最多 ${options.timeoutMinutes} 分钟）`);
    let ready = false;
    let pullFailures = 0;
    while (Date.now() < deadline) {
      const pullFailure = pullImage(image);
      if (pullFailure) {
        pullFailures += 1;
        log(`镜像拉取失败（第 ${pullFailures} 次）：${pullFailure}`);
        if (pullFailures >= 6) throw new Error(`连续拉取失败，放弃等待：${pullFailure}`);
      } else {
        pullFailures = 0;
      }
      if (inspectImageRevision(image) === commitSha) {
        ready = true;
        break;
      }
      await sleep(40_000);
    }
    if (!ready) throw new Error(`等待超时：${image} 还没有发布 ${commitSha.slice(0, 7)}，请检查 CI 构建`);
    log(`镜像就绪：${image} @ ${commitSha.slice(0, 7)}`);
  }

  run("docker", ["compose", "-f", composeFile, "pull", options.service], { cwd: deployDir, capture: false });
  run("docker", ["compose", "-f", composeFile, "up", "-d", options.service], { cwd: deployDir, capture: false });

  let health = "unknown";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    health = runQuiet("docker", ["inspect", "-f", "{{.State.Health.Status}}", options.service]) || "unknown";
    if (health === "healthy" || health === "none") break;
    await sleep(5_000);
  }
  const running = runQuiet("docker", ["inspect", "-f", "{{.State.Status}}", options.service]);
  const revision = inspectImageRevision(image);
  log(`容器状态 ${running} / 健康 ${health} / 镜像 revision ${revision.slice(0, 7)}`);

  const status = runQuiet("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/`]);
  log(`GET http://127.0.0.1:${port}/ -> ${status || "无响应"}`);

  if (health !== "healthy" || status !== "200") throw new Error("部署后自检失败，请查看 docker logs");
  log("部署完成 ✅");
  return 0;
};

if (import.meta.main) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      console.error(`[deploy] 失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

# AGENTS.md

本文件用于约束和指导参与本项目的 AI 代理与协作者。

## 文档与分支约束

- **技术栈与背景**：优先参考 `README.md`。
- **移动端平台边界**：Android 客户端位于 `apps/mobile`，使用 Expo / React Native 实现；iOS 客户端位于 `apps/ios`，使用 Swift / SwiftUI 原生实现。
- **双语同步**：修改中文文档时必须同步更新对应的英文文档。修改根目录 README 时必须同步 `README.md`、`README.zh-CN.md`、`README.zh-TW.md`、`README.ja.md`。
- **分支规范**：严禁创建新分支，所有修改与提交必须直接在 `main` 分支上完成。

## 二开分支约束（最高优先级）

本仓库是**永久二开分支**，与上游 `tianma-if/edgeever` 已经分道扬镳，产品代码以本仓库为唯一真相：

- **严禁合并上游**：不得 `git merge upstream/main`、不得在 GitHub 网页点 **Sync fork**、
  不得恢复已删除的 `.github/workflows/sync-edgeever-upstream.yml`。该 workflow 默认走镜像模式，
  会用上游代码快照整体覆盖本仓库的二开文件（2026-09-23 已发生过一次，删除了后台管理接口、
  注册加固、邀请码与迁移 `0054`–`0058`）。
- **只能手工挑拣**：确需上游某个修复时，用 `git diff upstream/main -- <文件>` 对照后手工改写，
  绝不做整树合并（上游与本仓库目录结构不同，盲目合并会静默删除本仓库独有文件）。
- **推送目标**：`main` 跟踪的是 `upstream/main`，推送必须显式写 `git push origin main`。
- **升级路径**：推送 `origin main` → CI `Build custom Docker image` 发布 `ghcr.io/ikun-yinmie/edgeever:main` →
  本地 `cd ~/Documents/EdgeEver && docker compose pull && docker compose up -d`（已由 `scripts/deploy-main.mjs` 串成一条命令，见下）。

## 一键提交与部署（用户说“提交”即走完整链路）

用户说出“提交 / 提交代码”时，默认把提交、推送、等镜像、重新部署一次做完，不要再分步询问：

1. **只暂存本次改动涉及的文件**：工作区可能同时有其他协作者的改动，严禁 `git add -A`。
2. **一条命令走完**：`bun scripts/deploy-main.mjs --message "<commit message>" --paths <本次改动文件…>`，
   脚本依次执行提交（自动追加 Codebuff 尾注）→ `git push origin main` → 轮询 GHCR 直到
   `org.opencontainers.image.revision` 等于该提交 → 部署目录 `docker compose pull` + `up -d` →
   健康检查与 `GET /` 自检。多个提交想整理成多次提交时，用 `--no-push` 逐个提交，最后再跑一次（不带改动）完成推送与部署。
3. **部署目标**：默认 `~/Documents/EdgeEver`，可用 `--deploy-dir` 或 `EDGE_EVER_DEPLOY_DIR` 覆盖；
   镜像名、版本与端口从该目录 `.env` 的 `EDGE_EVER_IMAGE` / `EDGE_EVER_VERSION` / `EDGE_EVER_PORT` 读取。
4. **未命中构建路径时不算部署**：改动没落在 `.github/workflows/custom-docker-image.yml` 的 `push.paths`
   内时 CI 不会出新镜像，脚本会跳过等待与重建并说明原因，此时不得宣称“已部署”。
5. **部署后必须回报**：提交号、镜像 revision、容器健康状态、HTTP 自检结果；前端带 PWA 缓存，
   提醒用户硬刷新后确认效果。

### 服务器自动跟随镜像（无人值守）

`scripts/watch-image.mjs` 由用户 crontab 每 5 分钟跑一轮：发现镜像 revision 与运行中容器不一致就
拉取、重建、等健康；新版本起不来则自动回滚到上一个镜像，并把该版本记入 `.image-watch.json` 跳过，
直到有新提交发布（避免每轮重试同一个坏镜像）。已命中构建路径的新提交推上去后无需再人工 pull/up。

- **安装与移除**：`bun scripts/watch-image.mjs --install-cron --interval-minutes 5` / `--uninstall-cron`
  （只增删自己的托管块，不动用户其他 crontab 条目；cron 的 PATH 已在行内侧显式导出）。
- **手动检查与演练**：`--verbose`、`--dry-run`、`--force`（同 revision 也重新部署一次）、`--skip-pull`
  （本地构建/离线场景）。
- **告警通道**：部署目录 `.image-watch.log`、桌面通知（notify-send，显式带 DISPLAY/DBUS）、
  `EDGE_EVER_ALERT_WEBHOOK` 指向的 HTTP 端点（收 JSON）。失败时退出码非 0 且打印摘要，cron 顺带发邮件。
  cron 不读 shell profile，所以 webhook 要用 `--install-cron --webhook <url>` 写进 cron 行才能生效。
- **状态文件**：部署目录 `.image-watch.json`（已部署 revision、上一个镜像 ID、被跳过的坏版本、
  连续拉取失败次数）；`.image-watch.lock` 防止重叠执行。
- **与手工部署的关系**：`deploy-main.mjs` 是“立即部署”，`watch-image.mjs` 是“最终一致”；两者同时
  触发也只会收敛到同一个镜像。回滚路径在 `/tmp` 的临时 compose 项目中验证过（健康失败→回滚成功），
  真实部署上的回滚尚未发生，需要时用 `--force` 演练。

## 变更风险评估

- **先评估后实现**：动手前说明功能价值、影响范围、最坏后果、回滚方案和未验证项；低价值但可能扰动成熟链路的需求，默认拒绝或提供低风险替代方案。
- **核心链路从严**：安装器、自动升级、数据存储、认证及迁移的机制或配置变化一律按高风险变更处理，必须验证真实的旧版本到新版本链路，不能只验证新版本自身。
- **禁止无依据保证**：未完成对应平台及跨版本验证时，必须明确标注风险，严禁声称“不影响现有用户”或“不影响自动升级”。

## Android 调测约束

- **USB 真机优先**：Android 功能调测必须使用通过 USB 连接的真实设备和 `adb`，不得启动或使用 QEMU、AVD 等 Android 模拟器；未连接可用真机时，明确标注真机验证未完成，不得以模拟器结果替代。

## GitHub Actions 与 Release 约束及流程

1. **Fork 工作流边界**：配置 GitHub Actions 时必须考虑大量用户会 Fork 仓库进行自部署；仅官方仓库需要的 Job 必须使用 `github.repository == 'tianma-if/edgeever'` 门禁，严禁在下游 Fork 中分配 Runner 或执行。
2. **版本号与基线**：`vX.Y.Z`（非 Draft/Prerelease）。发布须显式 `--bump patch|minor|major`（脚本不自动选级）；按 SemVer 选择，**禁止因发版节奏把用户可感知的新能力或新平台压成 patch**。递增根目录 `package.json`；含移动端修改时同步 `apps/mobile/app.json` 的 `expo.version` 并递增 `android.versionCode`。上一个正式 Release 为审计基线。
3. **跨平台 Release 资产**：每个正式 Release 页面必须同时包含 macOS arm64 DMG、macOS x64 DMG、Windows x64 Preview 安装包、Linux x64 AppImage Preview 和 Android arm64 APK。Windows Preview 未使用 Authenticode 签名时必须同时提供经仓库外 Ed25519 私钥签名的更新清单；Linux Preview 必须包含 `latest-linux.yml` 更新元数据和独立 SHA-256 清单；两者均须在发布前通过独立下载与摘要审计。若本次未修改对应原生运行时代码、依赖、配置或构建工具，直接复用上一个正式 Release 中已验证的原始资产，保留原文件名与校验和，禁止仅为匹配新版本号而重命名。官方仓库正式 Release 中的 Android APK 必须使用固定的 Google Play 应用签名证书；本地上传证书签名的 APK 只能作为 Draft 临时资产，未经 Play 签名替换和发布前门禁核验不得公开。
4. **验证命令**：必须通过 `bun run typecheck`、`bun run typecheck:mobile` 和 `bun run build:web`。
5. **测试职责边界**：正式 Release 必须先在官方仓库及与下游一致的 Ubuntu 环境通过完整非 E2E 测试，严禁将上游自身的测试失败转嫁给下游 Fork 发现。只读部署 Fork 仅同步产品快照且不运行测试；只有显式保留定制改动的 Fork 才验证合并结果，失败时必须保持 `main` 与生产环境不变。
6. **原生资产构建与复用**：由 `scripts/plan-native-release.mjs` 决定重建或复用；桌面资产包含 `apps/web`。修改判定规则时同步更新测试。移动端重建使用 `bun run build:android:apk:local`，签名配置保存在仓库外。
7. **Draft 内准备资产**：通过带 `release_tag` 的 `workflow_dispatch` 在 Draft 中准备并验证资产；Android 重建时须在 Draft 阶段完成 Google Play 交付、用 Play 签名 APK 替换临时资产并通过独立签名门禁；`published` 事件只审计，禁止重新构建或上传，签名不符时恢复 Draft。
8. **桌面验证职责**：桌面 Release 工作流负责测试、包结构检查、签名与公证；代理不再重复下载 Draft 或执行本地首次启动验收，除非用户明确要求。
9. **发布后更新**：正式发布后，发布流程默认不得下载、覆盖安装或启动 `/Applications/EdgeEver.app`；已安装的 macOS、Windows 与 Linux 桌面端通过应用内自动更新机制获取新版，其中 Linux Preview 必须在 Draft 阶段通过真实 AppImage 跨版本更新门禁。仅在用户明确要求时使用 `--install-desktop` 执行原有安装验收，功能体验由用户在实际使用中验证。
10. **失败处理**：Release 阻塞工作流或资产审计失败时保持或恢复 Draft，修复后重跑；不得公开已知损坏的 Release。GHCR 镜像属于阻塞门禁；腾讯云 TCR 公共镜像由独立工作流在正式发布后异步同步和审计，其耗时或失败不得阻塞 GitHub Release 或将已发布版本恢复为 Draft。
11. **Release 说明结构**：使用中英文双语格式（正文禁止包含字面量 `\n`），只写用户可感知的变化、影响以及必要的升级或迁移提醒。类型检查、构建命令、签名、公证、资产复用等技术验证细节保留在 Actions 和关联 Issue 中，不写入公开 Release 正文。功能/修复关联对应 Issue 并标记 Label，发布后回链并关闭 Issue。正文结构：

```md
## 🇨🇳 中文说明 / Chinese Changelog

## 主要更新

- 面向用户说明本次变化及影响。

关联 Issue：#<issue-number>

## Key Changes

- User-facing summary of changes in English.

Related Issue: #<issue-number>
```

## 环境、部署与组件约束

- **Cloudflare 部署**：严格按 `docs/agent-deploy-cloudflare.md` 执行。
- **跨运行时架构**：项目未来将正式支持 Docker 自托管；实现新功能时必须保持业务逻辑与 Cloudflare 解耦，并为其他运行时预留扩展边界。Cloudflare 与 Docker 必须共用同一套业务代码，仅允许保留薄且稳定、不包含业务判断的运行入口和基础设施驱动适配器。
- **数据库 Migration**：数据库或种子变化时，在 `migrations/` 下新增递增编号 SQL，禁止修改已执行的旧 Migration。
- **本地启动**：默认 `bun run dev`（纯本地环境）。用户要求“启动/重启 Web 端”时，默认含 Web 与 API，必须使用 `bun run dev`；只有用户明确要求“纯前端”或明确指定 `dev:web` 时，才使用 `bun run dev:web`。指定远程实例用 `EDGE_EVER_INSTANCE=<实例名> bun run dev:remote`。
- **Demo 示例同步**：修改示例笔记后，在 `main` 分支干净状态下执行 `bun run demo:sync` 重置公开 Demo。
- **禁止重复造轮子**：严禁重复实现已有成熟方案；优先采用维护活跃、广泛验证的开源组件与依赖，并优先复用 `shadcn/ui`；复杂或重复模块封装为独立组件。
- UI和交互的原则是，产品始终表现得可靠、可预测、确定、被接住。
- **悬停提示**：所有悬停或聚焦提示严禁使用 HTML 原生 `title`；Web 端必须统一使用 shadcn/ui 的 Tooltip 组件，并确保键盘聚焦时同样可见。

## 品牌视觉规范 / Brand Identity

- **品牌色**：主绿色 `#16A06E`，Logo 图形色 `#07130B`。
- 修改 Logo 后执行 `bun run prepare:brand:icons` 同步各平台资源。

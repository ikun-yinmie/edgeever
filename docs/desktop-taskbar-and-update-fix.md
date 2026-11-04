# EdgeEver 客户端两处问题：定位结论与修复说明

日期：2026-11-04　基线提交：`1757b87`（v1.103.11）

---

## 一、结论先说

| 问题 | 根因 | 是否已修 |
| --- | --- | --- |
| 任务栏图标仍是旧的，不跟随自定义 | 只写了进程 AUMID，没写 `HKCU\Software\Classes\AppUserModelId\<aumid>` 的 `IconUri` | 已修（客户端代码） |
| 有更新就显示失败 | **线上 Release v1.103.11 缺少 `latest-windows.json.sig`（实测 404）**，签名校验必然失败，且失败被当成整次检查失败 | 客户端已改为可降级 + 提供下载入口；**签名文件需发版侧补传** |

---

## 二、任务栏图标问题

### 为什么改了配置却不生效

Windows 的任务栏按钮图标由「运行窗口 + AppUserModelID 注册项」共同决定，Electron 的 `app.setAppUserModelId()` **只设置了进程身份，不会写注册表**。

代码里原本只有：
- `app.setAppUserModelId(...)` → 进程身份 ✅
- `shell.writeShortcutLink(..., { icon })` → 快捷方式图标 ✅
- `window.setAppDetails({ appIconPath })` → 窗口级图标 ✅
- `window.setIcon(...)` → 窗口图标 ✅

缺的是第 5 条：`HKCU\Software\Classes\AppUserModelId\org.edgeever.desktop` 下的 `IconUri`。Windows 在解析任务栏/开始菜单/跳转列表图标时优先读这个值，读不到就回退到 exe 内嵌图标——于是标题栏变了、任务栏没变。

### 改了什么

新增 `apps/desktop/src/main/windows-aumid-branding.mjs`：

- `syncWindowsAumidBranding()` 用 `reg.exe`（无需管理员，仅写 HKCU）写入 `DisplayName` 与 `IconUri`；
- 清除自定义图标时删除 `IconUri` 值，让 shell 回退到 exe 图标，而不是继续显示缓存里的旧图标；
- 注册表被策略锁死时只返回 `{ ok: false }`，绝不阻塞启动。

接入位置（`index.mjs`）：`applyClientBrandingToSystem`、`createWindow`、`startApplication` 三处，并在 Windows 上写一条 `branding.windows-identity` 诊断日志，方便日后核对是否真的写进去了。

另外把 `setIcon(icoPath)` 改成 `nativeImage.createFromPath(icoPath)` 再传入，避免 shell 已缓存旧 HICON 时路径字符串不触发重载。

### 验证方式

1. 设置中心 → 客户端显示与品牌 → 上传图标并保存；
2. **完全退出**客户端（托盘退出，不是关窗口）后重新打开；
3. 任务栏应显示新图标。首次切换时 Windows 可能仍显示旧图标，取消固定再固定一次即可刷新缓存。

---

## 三、更新失败问题

### 实测证据（不是推测）

对 `v1.103.11` 的实际资产逐个探测：

```text
latest-windows.json       200
latest.yml                200
latest-windows.json.sig   404   ← 缺失
```

该 Release 共 9 个资产，其中没有 `.sig`。

而客户端 `windows-update-trust.mjs` 的流程是：

1. `checkForUpdates()` 拿到新版本号 → 成功；
2. `fetchTrustedWindowsUpdate()` 去拉 `latest-windows.json` 和 `latest-windows.json.sig`；
3. `.sig` 404 → `responseBytes()` 抛错 → 整个 `checkForUpdates` 进入 `.catch`，`updateState = "idle"`、`lastUpdateError` 被赋值。

所以用户看到的现象完全对得上：**能发现新版本，但一律显示失败**。这与代理无关；即使直连成功、清单也能下载，只要 `.sig` 缺失就必然失败。

### 顺带修掉的两个真实缺陷

**缺陷 1：签名清单没走代理。**
原先用 `net.fetch`，它走的是默认 session；而默认 session 在「自动」代理模式下是直连（`startupProxySessionConfig` 只有 `always` 才用代理）。于是出现「主界面能连、更新检查失败」的错位。现在统一改为 `autoUpdater.netSession.fetch`，与更新器同一条链路。

**缺陷 2：校验失败后状态卡在「正在下载」。**
原代码在校验抛错时没有回退 `updateState`，`available` 会一直保留，界面持续显示「正在下载更新…」并每 3 秒轮询。现在失败即置为 `idle`，同时保留已发现的版本号。

**缺陷 3：Windows 清单校验失败后仍可能继续下载。**
`result.downloadPromise` 没有判断签名闸门结果。现在 Windows 上校验未通过时不再触发下载，避免拿到不可信安装包。

### 现在失败时长什么样

`desktopUpdateStatus()` 新增三个字段，随状态一路传到界面：

```ts
downloadUrl      // 精确到资产的直链，如 .../download/v1.103.11/EdgeEver-1.103.11-windows-x64.exe
releasePageUrl   // 对应 tag 的发布页
downloadBlocked  // "verification" 表示"有新版本但无法自动安装"
```

界面（`DesktopUpdateCard`）新增独立状态：

- **已发现新版本、需要手动下载**：琥珀色提示 + 「下载安装包」+「打开发布页」；
- **网络失败**：保留代理配置入口，同时并列给出「下载安装包」；
- **其它失败**：给出「下载安装包」+ 发布页 + 可展开的「错误详情」。

即使用户什么都修不好，也一定有一个能点得动的下载入口。

顺带修正：系统信息里那个按钮原来在 Windows 上也写「下载最新 AppImage」，已改为「下载最新版本」，并改用状态里返回的精确链接。

---

## 四、还需要在发版侧做的一件事

客户端改造只能保证「失败时可用」，**无法凭空补出签名文件**。要让自动更新真正跑通，需要：

1. 用仓库外私钥对 `latest-windows.json` 签名，生成 `latest-windows.json.sig`；
2. 上传到 `v1.103.11` 这个 Release；
3. 之后每次发版确保 `.sig` 与 `.json` 同时上传。

仓库里已有现成能力：

- `scripts/sign-windows-update-manifest.mjs`：本地签名
- `scripts/release.mjs` 的 `signDraftWindowsUpdate()`：自动下载清单 → 签名 → 回传
- `.github/workflows/desktop-build.yml` 的 `windows-update-audit` 作业：发布前审计签名

这次之所以漏掉，是流程在「审计通过」之前就把 Release 发布了。建议在发布前把该审计作业设为必需门禁（required check）。

> 注：签名私钥不在仓库内（`EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY`），我无法代为补签，需在持有密钥的环境执行。

---

## 五、改动清单

**新增**
- `apps/desktop/src/main/windows-aumid-branding.mjs` / `.test.mjs`
- `apps/desktop/src/main/update-release-links.mjs` / `.test.mjs`

**修改**
- `apps/desktop/src/main/index.mjs`：AUMID 注册接入、清单走更新器 session、失败降级、状态新增下载字段
- `apps/desktop/src/main/desktop-update-flow.test.mjs`：新增 3 组回归断言
- `apps/web/src/components/settings/DesktopUpdateCard.tsx`：手动下载状态与下载入口
- `apps/web/src/components/settings/SystemInfoPanel.tsx`：使用精确下载链接 + 手动下载提示
- `apps/web/src/vite-env.d.ts`：`DesktopUpdateStatus` 扩展
- `packages/shared/src/i18n/{zh-CN,en-US,ja}.ts`：新增 6 条文案，三语键值一致

---

## 六、验证结果

| 检查 | 结果 |
| --- | --- |
| 新增/相关单测（5 个文件） | 41 项通过 |
| 更新流程 + 品牌 + i18n + 系统信息（13 个文件） | 77 项通过 |
| `bun run typecheck` | 通过 |
| 前端构建（跳过 PWA SW 生成） | 成功 |
| 桌面端全量单测 | 184 通过 / 14 失败——**这 14 项在原始代码上同样失败**（路径按 POSIX/macOS 语义编写），与本次改动无关 |

### 未验证项（需实机确认）

- **任务栏图标**：需在真实 Windows 上重新打包安装后确认；开发模式（`app.isPackaged === false`）下 `setAppDetails` 的 `relaunchCommand` 分支不生效。
- **自动更新成功路径**：需先补上 `latest-windows.json.sig` 才能验证。
- **完整生产构建**：本机 `bun install` 因 Windows 长路径限制有 9 个可选包链接失败，导致 `vite-plugin-pwa` 的 Service Worker 生成阶段报 `MODULE_NOT_FOUND`；业务代码编译已单独验证通过。CI（Windows runner）通常不受影响。

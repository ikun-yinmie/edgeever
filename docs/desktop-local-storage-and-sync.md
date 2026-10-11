# 客户端本地存储与双向同步 — 可行性评估与实施方案

> 状态：评估完成，方案已按拍板结论收敛（2026-10-11）
> 需求：① 个人笔记支持「网络 + 本地」双向存储，离线也能读写；② 仅桌面客户端（Windows / Linux，含 macOS）
> 需要；③ 支持开启 / 关闭本地存储；④ 设置跟随账号、多设备共享；⑤ Web 直接访问不需要该开关。
> 关联问题：动手前需先确认「现有笔记是否已支持语雀式协同编辑」——见 §0。

**已拍板的两个取舍**（本次收敛的依据）：

1. **只做「开 / 关本地存储」两档**，暂不提供「服务器为主」策略档位（该档位移到 §6 后续可选项）。
2. **设置项跟随账号上云，多设备共享同一设置**——因此必须新增服务端按用户存储 + 接口，不能只存在本地。

---

## 0. 现状核查：协同编辑（先回答那个前置问题）

**结论：自托管运行时已有真正的实时 CRDT 协同；Cloudflare / 移动端仍是
「语雀式协作的可见形态」（在场 + 乐观锁）。**

已实现的部分（migration `0061_group_collab_shared_accounts_display_policy.sql` +
`0062_collab_realtime_documents.sql` + 前端实时通道）：

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 实时房间 | `apps/api/src/collab-realtime.ts`、`scripts/self-hosted-server.mjs`（`/collab-ws`） | 每笔记一篇 Yjs 文档，y-websocket 帧（sync/awareness），只读成员服务端强制不可变更 |
| 种子与写回 | `apps/api/src/collab-seed.ts`、`collab-memo-writer.ts`、`collab-document-store.ts` | 房间创建时服务端单次播种（无 schema 转换）；flush 节流写回 `memo_contents` 并推进 revision，关停时 sweep 补尾 |
| 前端实时 | `apps/web/src/components/editor/collab-realtime.ts`、`EditorPane.tsx` | y-websocket + Collaboration 扩展 + 远端光标；正文走 CRDT，标题/标签走直连元数据保存；进出实时才重建编辑器 |
| 在场提示 | `apps/api/src/collab-presence-service.ts`、`memo-routes.ts`（`/collab-heartbeat`、`/collab-state`、`/collab-release`） | `memo_collab_presence` 表，30s TTL，纯 advisory；实时 live 后自动让位 |
| 前端在场条 | `apps/web/src/components/editor/collab-presence.ts`、`CollabConflictBar.tsx` | 实时 peers 优先，在场轮询做连接/断线窗口的兜底 |
| 冲突保护 | 保存链路（`memo_edit_sessions` 乐观锁 + `revision` / `content_hash`） | 降级模式的后保存者不覆盖：返回 409 `revision_conflict`，协作条给「载入最新（保留我的修改）/ 复制我的版本 / 仍要覆盖」 |
| 公共群组账号 | `group-account-service.ts` | `account_type='group'`，同设备多会话并存，用于多人共用一个账号协作 |
| 共享显示控制 | `memo_shares` / `group_shares.display_policy_json` | 服务端按作者策略过滤 `rendered/source/hidden`；**被过滤的视图永远不进实时房间**（硬边界，防泄漏） |

**模型边界**：实时只活在自托管（Bun/Docker）运行时；Cloudflare Workers 无
socket，Web 在该部署上自动降级；离线 CRDT 合并、移动端协作 UI 明确不做。
保存语义是双轨：实时笔记以 CRDT 合并为准（写回推进 revision），其他笔记仍是
整篇文档粒度的 Last-Write-Wins + 乐观锁。

---

## 1. 现状核查：本地存储与双向同步

**结论：桌面端与 Web 端其实都已经有本地存储 + 双向同步，缺的是「开关」和「设置的归属」。**

### 1.1 桌面客户端（Electron + Rust sidecar）—— 已经是本地为主

- `crates/desktop-sidecar`：独立本地进程，拥有 **本地 SQLite**（`edgeever.sqlite`），
  newline-delimited JSON-RPC over stdio（protocol v2），由主进程启动并负责崩溃重启。
- 数据目录：按账号隔离 `accountDataDirectory(userData, apiBaseUrl, accountId)`；
  含 `resource-outbox`（新附件暂存）、`resource-cache`（附件字节缓存）、`backups`。
  sidecar 启动时按 `migrations/` 执行与云端同一套 DDL。
- 推送链路：所有写操作先落本地并进 `_edgeever_sidecar_outbox`（带 `version` 乐观并发、
  `retryable` / `next_attempt_at` 退避），由 `apps/web/src/lib/desktop-sync.ts` 的
  `syncDesktopData()` 上推；冲突分类见 `classifyDesktopSyncFailure`。
- 拉取链路：`sync.changes` 游标增量 + `sync.bootstrap`（分页快照）重建，
  走 `sync.apply` / `sync.cursor.set`；身份变更或服务端重置由 `hasSyncStateReset` 兜底重建。
- 读路径：`createDesktopRepository()` 全部走 sidecar（`memo.list` / `memo.get` / `notebook.list` …），
  **离线可读可写**；唯一例外是群组共享笔记（别人工作区的笔记）不镜像，直接读 API。
- 附件：`edgeever-resource://` 自定义协议先读 `resource-cache`，失败才回源网络。
- 已就绪但未挂载：`storage.backup` / `storage.restore` / `storage.backups` 与对应组件
  `DesktopLocalBackupCard.tsx`（i18n 文案齐备，但全仓库只被自身定义引用，没有任何地方挂载）。

**结论：桌面端当前是「本地为主」且无法关闭**——需求 ①② 基本吻合，要做的是把已有能力变成可控开关。

### 1.2 Web（浏览器 / PWA）—— 也有本地镜像

- Dexie/IndexedDB `edgeever-local`（v6 schema：memos / notebooks / templates / revisions /
  resources / syncMeta / syncQueue / drafts / idMappings）+ `sync-queue.ts` 出站队列 +
  `syncLocalMirror()` 游标拉取。`repository.ts` 的 Web 分支在本地有数据时优先返回本地并后台刷新。
- README 里的「Offline Drafts & Queueing」在 Web 上同样成立。
- 需求 ⑤ 说「Web 直接访问不需要」——理解为**不新增开关、不改 Web 行为**，而不是删除现有镜像能力
  （它已上线，PWA 依赖它）。**下面 §2.4 的「非桌面端一律忽略该设置」是本方案的硬约束。**

### 1.3 移动端

`apps/mobile/src/lib/sync-queue.ts` 有独立离线队列，属既有能力；本次需求「仅限客户端」，
移动端**不改**（同样必须忽略该设置，见 §2.4）。

### 1.4 缺口清单（真正要做的部分）

1. **没有开关**：本地存储永远开着，用户无法关闭。
2. **设置无处可放**：现有个人偏好全部存在浏览器 `localStorage`
   （`shortcut-settings.ts`、`ai-selection-menu-preference.ts` …），**没有任何按用户的云端设置存储**；
   `instance_settings` 只存实例级（管理员）配置。所以「设置上云、多设备共享」是新增能力。
3. **切换语义未定义**：关本地存储时，未推送的 outbox 会被搁浅 → 数据丢失风险。
4. **缺存储可见性**：设置里看不到本地库位置 / 占用 / 同步状态摘要
   （`sync.status` 已能给出 pending/syncing/conflict/error 与 `lastSyncedAt`，但没有 UI）。
5. **作用域**：设置属于账号（`apiBaseUrl + accountId`），但**执行者只有桌面端**。

---

## 2. 方案

### 2.1 模式模型（单一布尔设置）

新增设置 `desktopLocalStorageEnabled: boolean`，**按用户存于服务端并在多设备间同步**：

| 取值 | 读 | 写 | 离线 |
| --- | --- | --- | --- |
| `true`（默认，= 现状） | sidecar 本地库 | sidecar 本地库 + outbox，后台推拉 | 完整可用（读 + 写） |
| `false` | 直读 API | 直写 API | 不可用（明确提示，非静默失败） |

`false` 的语义细节：sidecar 进程仍会运行（它是桌面端唯一的 RPC 宿主，且资源缓存/暂存仍需要它），
但**不再作为笔记读取来源、不再产生 outbox 条目**。本地已有副本的处置见 §4 待确认项。

### 2.2 服务端：按用户的设置存储 + 接口（新增）

现有 `instance_settings` 是实例级，`users` 表没有偏好字段，因此需要：

1. **迁移**：新增 `migrations/0062_user_preferences.sql`（或按仓库编号继续递增），
   采取**加列式**以匹配 0061 的风格与可回滚性：
   ```sql
   ALTER TABLE users ADD COLUMN settings_json TEXT;
   ```
   加列式的好处：回滚时旧代码忽略该列即可，不需要破坏性 DDL；符合「禁止修改已执行迁移」约束
   （新增文件，不改旧的）。
2. **接口**：`GET /api/v1/me/settings` 与 `PATCH /api/v1/me/settings`（或 `PUT`），
   仅作用当前会话用户，服务端校验取值白名单（先只有 `desktopLocalStorageEnabled`），
   合并写回 `settings_json`。写操作沿用现有约定把 `getAuditActor(context)` / `getActorLabel(context)`
   传给服务层落审计（仓库中并没有同源校验中间件，不要为此凭空引入新的安全机制）。
3. **不入同步日志**：该设置走普通 REST，**不进入 `sync.changes`**——它属于客户端行为开关，
   与笔记数据无关；混进变更日志会让桌面 outbox / 游标逻辑无谓复杂化。

### 2.3 客户端：读缓存 + 应用时机

- **离线启动必须知道当前值**：云端是唯一真相，但启动时可能离线。因此把最近一次取到的值缓存到
  **sidecar 的 `_edgeever_sidecar_meta`**（随账号数据目录走，天然按账号隔离）：
  启动先用缓存值决定行为（避免离线时误用本地库），联网后再拉云端值校正。
- **应用 `false` 需要延迟生效**：设备收到「关闭本地存储」时，若自身 `sync.status` 仍有
  `pending + syncing > 0` 或存在 `conflict` / `error`，**不得立即停用本地库**——先把 outbox 排空
  （或引导用户处理冲突），排空成功后再生效。这是「设置上云」引入的关键新风险：别的设备把开关
  关掉，不能让自己这台机器上的未推送改动变孤儿。
- 落地实现：`apps/web/src/lib/repository.ts` 的 `createRepository` 按该值分派
  （`createDesktopRepository()` ↔ 桌面远端分支），`useWorkspaceQueuedSync.ts` 的 `runQueuedSync`
  在关闭态跳过 sidecar outbox。

### 2.4 硬约束：非桌面端必须忽略该设置

设置是**按账号上云**的，因此同一账号下的 Web、PWA、Android、iOS 都会读到它。
若这些客户端也用 `desktopLocalStorageEnabled` 决定行为，用户在某台 Windows 上关掉本地存储，
会连带把 Web / 移动端的离线能力一起关掉——这直接违反需求 ⑤「仅限客户端」。
**判定入口必须同时要求 `window.edgeeverDesktop?.isAvailable`**，其余端一律走现有逻辑、忽略该字段。

### 2.5 实现落点清单

1. `migrations/0062_*.sql`：`users.settings_json`。
2. `apps/api/src/`：用户设置路由（`GET` / `PATCH /api/v1/me/settings`）+ 校验 + 审计；
   建议单独成文件（如 `user-settings-routes.ts`）并配 `*.test.mjs`。
3. `apps/web/src/lib/`：设置读写客户端（含 sidecar meta 缓存与离线回退），
   与既有偏好写法（localStorage + 事件）保持一致的外部接口。
4. `apps/web/src/lib/repository.ts` + `hooks/useWorkspaceQueuedSync.ts`：按模式分派。
5. `apps/web/src/components/SettingsPane.tsx`：新增 `DesktopStorageCard`（`data` tab 或 `general` tab），
   用 `window.edgeeverDesktop?.isAvailable` 门禁，复用 `Switch` 与 `settings-ui.ts` 常量；
   展示开关、本地库位置与占用（`system.info.dataDir` / `storage.health`）、
   `sync.status` 摘要、以及「立即同步」。i18n 文案改
   `packages/shared/src/i18n/{zh-CN,en-US,ja}.ts` 三份（Web 端 `apps/web/src/i18n/resources/*.ts`
   只是对 shared 的再导出）。
6. **顺带挂载既有能力**：把 `DesktopLocalBackupCard.tsx`（本地 SQLite 备份 / 恢复）在同一区域挂出来，
   否则这份已就绪的能力对用户始终不可见。

---

## 3. 风险评估

- **功能价值**：中高。把已存在的桌面离线能力变成用户可控、可解释的能力，并补上设置页的可见性。
- **影响范围**：新增服务端按用户设置存储与接口、桌面仓库分派、同步调度、设置页与 i18n。
  触及「数据存储」与「认证/会话」周边，按仓库约定属**高风险变更**；迁移是加列式，风险可控。
- **最坏后果**：
  1. 别的设备关闭本地存储后，本机未推送改动被搁浅（数据丢失）——由 §2.3 的延迟生效前置条件控制；
  2. 设置被 Web / 移动端误用，导致非桌面端离线能力被一起关掉——由 §2.4 的门禁约束控制；
  3. 离线启动时读到过期缓存值，短暂用错策略——影响限于启动后到首次拉取之间，且只影响读取来源，
     不改变数据归属。
- **回滚方案**：删除 / 复位该字段即回到现状（默认 `true` = 现有行为）；
  服务端加列式迁移回滚时保留列、旧代码忽略；sidecar 数据库结构无需变更。
  已入 outbox 的条目在任何模式下都继续可推送。
- **未验证项（实现前必须实测，不得口头保证）**：
  1. Windows x64 Preview 与 Linux x64 AppImage 是否真的打包并启动 sidecar
     （`electron-builder.yml` 的 `extraResources` 取 `edgeever-sidecar(.exe)`，
     需确认 CI 为 Linux / Windows 都产出了对应二进制）。AGENTS.md 禁止未验证就宣称「不影响现有用户」。
  2. 桌面端 `readResource()` 目前直接走 API（`desktop-repository.ts`），
     离线时附件 / PDF 预览是否可用，取决于 `edgeever-resource://` 协议缓存命中——需真机断网实测。
  3. 关闭本地存储后再开启，多账号（切换账号）下是否各自正确 bootstrap。
  4. 设置上云后，旧版客户端读到含新字段的 `settings_json` 是否安全忽略（向前兼容）。

---

## 4. 仍需确认的取舍（不阻塞 P0）

1. **关闭本地存储时如何处理已有本地副本？**
   - A（推荐）：保留（仅停止使用），复用已有「清除本地数据」入口。
   - B：关闭即清除（不可逆，需强提示）。
2. **是否允许单机临时覆盖云端值？** 例如云端 `false` 但本机想临时离线用。
   - A（推荐）：不允许，保持「多设备一致」的简单心智。
   - B：允许，本机覆盖优先但会破坏一致性。
3. **设置接口命名**：`/api/v1/me/settings`（推荐，与现有 `/api/v1/me/invite-code` 一致）
   还是 `/api/v1/users/me/settings`。

---

## 5. 分阶段实施计划

1. **P0 — 只读可见性（低风险，无服务端改动）**：新增 `DesktopStorageCard`，仅展示当前模式、
   本地库位置与占用、`sync.status` 摘要与「立即同步」；同时挂载既有的
   `DesktopLocalBackupCard`。不改变任何行为。
2. **P1 — 服务端设置存储（中风险）**：`migrations/0062` 加列 + `/api/v1/me/settings` 读写 + 测试；
   客户端读取与 sidecar meta 缓存。
3. **P2 — 开关生效（中风险）**：桌面仓库分派 + 同步调度改造，含 §2.3 的延迟生效前置条件与
   §2.4 的非桌面端忽略约束。
4. **P3 — 真机验证（阻塞发布）**：Windows x64 与 Linux AppImage 上验证
   离线写 → 联网 → 服务端可见；关闭本地存储后离线行为与提示；重开后 bootstrap 正确；
   同账号在 Web 上不受影响。

## 6. 后续可选项（本次不做）

- **「服务器为主」策略档位**：在线读 API、失败回退本地；离线写入语义需单独决策
  （允许写会削弱「服务器权威」，不允许写会与「离线可用」冲突）。
- ~~**真 CRDT 协同**：需要 Durable Object 或常驻 WS 网关，与现有双运行时约束冲突，需单独立项。~~
  已落地（见 §0 与 `docs/group-collaboration-and-display-control.md`）：常驻 WS
  网关只放在自托管运行时，Cloudflare 侧保持无状态，约束依然成立。

## 7. 验证命令（沿用仓库约定）

```sh
bun run typecheck
bun run test:desktop        # 桌面 main 单测 + apps/web lib 单测 + sidecar 测试
bun run test:bulk           # 全量单测
bun run build:web
cargo test --manifest-path crates/desktop-sidecar/Cargo.toml
```

新增测试建议：`user-settings-routes.test.mjs`（取值白名单、按用户隔离、同源校验）、
`local-storage-mode.test.mjs`（桌面 / 非桌面端分派、outbox 未排空时延迟生效）。

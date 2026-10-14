# 群组协作编辑、公共群组账号与共享显示控制 — 设计与风险评估

> 状态：实时 CRDT 协同已落地（2026-10-11），自托管运行时默认开启；Cloudflare / 移动端 / 受显示策略过滤的视图保持在场+LWW 降级模式
> 需求：① 群组内分享支持语雀式并发协作编辑；② 支持多地同时登录的“公共群组账号”；③ HTML / Markdown
> 的直译渲染与显示控制，两种共享（公开链接、群组）复用同一套控制前置。

## 现状与选型

- 群组层已存在：`groups` / `group_members` / `group_shares`（migration 0058），
  `edit_mode = 'author' | 'group'` 已决定“谁能写”，`resolveMemoAccess` 是唯一判定入口。
- 编辑保存链路：`memo_edit_sessions` 乐观锁 + `revision` / `content_hash` 冲突检测。
  这是**顺序编辑**模型：两人同时编辑，后保存者收到 409。
- 运行时：Cloudflare Workers 与 Docker(Bun) 共用一套业务代码，**没有 Durable Object / WebSocket**。
- 依赖：`@tiptap/extension-collaboration`、`@tiptap/y-tiptap`、`y-protocols`、`yjs@13.6.32`
  已在锁文件中（yjs 已补进 package.json dependencies）。

**选型演进（2026-10-11）：自托管运行时已上线真正的实时 CRDT 协同（Yjs），
Cloudflare 侧仍保持下面的 LWW + 轮询方案。**

- 自托管（Bun/Docker）是唯一服务协同 socket 的运行时：
  `scripts/self-hosted-server.mjs` 挂载 `GET /api/v1/memos/:id/collab-ws`，
  升级前把请求重放给 `GET /api/v1/memos/:id/collab-session` 做鉴权（与 HTTP
  同一入口：scope、分享权限、auth mode 只判断一次）。浏览器走同源 cookie；
  桌面端渲染进程在自定义 scheme 下跨域连接，把 session token 放 `?token=`，
  服务端转成 Bearer 重放（session token 本来就可当 bearer 用，无新表无新端点）。
- 房间核心 `apps/api/src/collab-realtime.ts` 与运行时解耦（只收发 y-websocket
  帧：`0 = sync / 1 = awareness`），只读成员可拉取不可变更（服务端强制执行）。
  状态 400ms 防抖落 `memo_collab_documents`（migration 0062，另带 `content_hash`
  水位）；空房间保留 30s，关停时全量 flush。
- **种子只发生一次且只在服务端**：房间创建时，无可用持久态则把 memo 的
  contentJson 转成 Yjs update（`collab-seed.ts`，与 y-prosemirror 同编码、无需
  schema）；持久态的 content_hash 与 memo 当前 hash 一致才复用——移动端/outbox/
  LWW 路径在空窗期写过，就地用 memo 内容重播种，不复活过期合并。两人同时打开
  也只播种一次，不存在客户端并发播种导致的正文翻倍。
- **写回由服务端做**：flush（节流 2s）+ 关停 sweep 把合并文档转回 TipTap JSON
  写 `memo_contents`（content_json/markdown/text/hash/revision +1）与 `memos`
 （excerpt/updated_at，触发 mobile-sync 触发器，桌面/移动端下次拉取即收敛），
  并刷新搜索索引。审计行与 revision 快照不写（高频合并不是修订）。
- 前端（Web）：群组共享 + 可编辑 + 无非默认显示策略 + socket 运行时才进实时
  模式（`useCollabRealtimeSession` + y-websocket + Collaboration 扩展 + 远端光标；
  进入/退出实时才重建编辑器实例，切笔记不重建）。实时模式下正文不同步保存
 （走 CRDT），标题/标签走直连 API 的纯元数据保存；保存药丸显示“已同步/同步中”；
  在场心跳在 live 前保持运行，断线窗口不闪烁。
- **显示策略是硬边界**：被策略过滤的视图永远不进实时房间（否则 Yjs 文档会把
  原始内容广播给本不该看到的人）；只读成员进房间也只能拉取。
- **明确不做（边界）**：离线 CRDT 合并、移动端(iOS/Android)协作编辑 UI。
  移动端保持现有行为（打开即拉最新、保存遇冲突提示）；
  桌面端走 token 参数连接（尚未在真机上验证，见未验证项）。

理由（沿用原判断并收敛）：Workers/Docker 双运行时下，CRDT 只在有常驻 WS 网关
的自托管侧落地，业务代码（房间/种子/写回）与 Cloudflare 解耦——Cloudflare
worker 仍是纯 fetch handler，不含任何协同状态。语雀模式“多人同时进一篇文档，
系统保证不丢不撞”由 CRDT 的字符级合并实现；连不上 socket 的环境退回 LWW +
冲突条，与现有 `revision_conflict` 语义同构。

## 功能一：群组并发编辑（语雀模式）

## 功能一：群组并发编辑（语雀模式）

- `group_shares.edit_mode = 'group'` 的笔记，所有可编辑成员（含公共账号的会话）**同时**拥有写权限。
- 实时模式（见上文选型演进）下编辑器进入真正的协同态：共用一篇 Yjs 文档，
  远端光标与 peer 名实时呈现；保存药丸显示同步态而非保存态。
- 降级模式（Cloudflare / 移动端 / 被显示策略过滤 / socket 不可达）保持原有
  “协作感知”交互：
  - 显示其他成员/公共会话的“正在编辑”状态（轮询 `GET /api/v1/memos/:id/collab-state`）。
  - 保存时携带 `editSessionId + expectedRevision + expectedContentHash`（现有机制）。
  - 收到 409 `revision_conflict` 时不弹生硬报错，而是展示**协作冲突条**：
    “××× 刚刚更新了这篇笔记”，提供【查看最新 → 载入最新文档（保留我的内容到剪贴板/对话区）】与
    【仍要覆盖】。
- 服务端已有乐观锁，无需新表；新增轻量**在场表**（migration 0061）记录
  `memo_id / actor / last_seen`，仅用于“谁正在编辑”的展示，非权威。
- 实时模式的合并写回会推进 `revision`：降级模式的客户端下次保存时会收到
  409 并走冲突条——这是设计好的收敛语义，不是 bug。
- 风险：低（降级路径未改变存储与冲突语义，只改交互与增一张可丢弃的在场表）；
  实时路径为新增代码，只在自托管 + 群组共享可编辑笔记上激活，个人笔记、
  只读分享、移动端完全不受影响。
  未验证项：D1 高频 upsert 计费（已用节流 + 30s 过期清理缓解）；桌面端真机
  上的 `?token=` 协同连接；大文档（>1MB）种子/写回的耗时。

## 功能二：公共群组账号（多地同时登录）

- 新增用户类型 `account_type = 'user' | 'group'`（migration 0061，users 表加列）。
- 管理员在 **用户账户** 面板创建公共账号（用户名固定前缀 `shared_`），并可直接把它加入任意群组。
- 会话差异（`createSession`）：
  - 普通用户：维持现状——同设备新登录吊销旧会话（device_id 绑定）。
  - 公共群组账号：**不再吊销**同设备旧会话，每个登录都产生独立会话 → 天然支持多地同时在线。
  - 会话 TTL 独立可配（`EDGE_EVER_GROUP_SESSION_TTL_DAYS`，默认 30 天，上限 400）。
- 权限差异：公共账号 `role = 'member'`，没有个人工作区内容（有个人 workspace 但仅作占位），
  登录后主视图为 **“共享”** 视角（Web 端按账号类型默认进 shared-with-me）；禁止创建 API Token、
  禁止作为群组管理员（manager 仅可被管理员授予，加成员写死 `member`，无提权接口）。
  - 服务端 `requireUser` 放行公共账号（它们是交互会话），`requireOwner` 拒绝。
  - `POST /api/v1/api-tokens` 对公共账号返回 403；改密码/禁用时连同其 API Token
    一起吊销（否则 Token 会绕过“重置即全部失效”）。
  - `shared_` 前缀被个人建号三处（公开注册、管理员建成员、成员改名）同时保留，
    防抢注与冒充。
  - 写审计：`actor = user:{id}`，正常落库。
- 登录限流沿用 username+IP 维度，无新面。
- 风险：中。密码共享给多人是产品权衡（这正是需求本意）；技术面不新增存储路径，
  会话表多行同用户已被 `groupLoginDeviceSessions` 的分组逻辑天然兼容。
  回滚：migration 0061 为加列式，新列可保留；功能开关即“是否存在公共账号行”。

## 功能三：HTML / Markdown 直译渲染与显示控制（一套控制前置）

目标：作者控制**别人看到什么**，而不是控制自己编辑器里有什么。三个层面：

1. **内容级 `display-mode` 节点属性**（Markdown/HTML 块）：
   - `rendered`（默认）：转译显示（现状）。
   - `source`：显示源码原文（等宽字体、不转译）。
   - `hidden`：折叠为占位“作者未公开此内容块”。
   - 实现走 TipTap 自定义 Markdown 块扩展（`edgeeverDisplayBlock`），markdown 序列化为
     fenced code block 携带元信息（```html 显示=原文 / ```html 显示=隐藏），向后兼容普通代码块。
2. **共享级显示策略**（一套控制前置，两种共享共用）：
   - `memo_shares.display_policy_json` 与 `group_shares.display_policy_json`（migration 0061 加列）：
     `{ html: "rendered" | "source" | "hidden", markdown: "rendered" | "source" | "hidden" }`。
   - 默认 `rendered`（保持现状）；作者在分享对话框勾选。
   - **服务端执行**（不是前端装饰）：公开分享接口返回前按策略过滤 contentJson；
     群组读取接口同样执行。这样“对方能看到的”由权威接口保证。
3. **公共账号只读透传**：公共账号看群组笔记时应用群组 share 的 display policy（默认 rendered，即当前行为）。

- 渲染安全：转译显示复用现有 TipTap 受控渲染（白名单 schema），不引入
  `dangerouslySetInnerHTML` 新调用点；`source` 模式显示转义文本。无新 XSS 面。
- 风险：中。老客户端读到带 `显示=原文` 的 fence 会当普通代码块显示——可接受且不丢数据。
  服务端过滤器对 contentJson 做深遍历，需单测覆盖嵌套（表格/引用内）情况。

## Migration 0061（单文件，加列式，可回滚=列保留）

```sql
-- users
ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'user' CHECK (account_type IN ('user','group'));
-- group_shares / memo_shares
ALTER TABLE group_shares ADD COLUMN display_policy_json TEXT NOT NULL DEFAULT '{"html":"rendered","markdown":"rendered"}';
ALTER TABLE memo_shares  ADD COLUMN display_policy_json TEXT NOT NULL DEFAULT '{"html":"rendered","markdown":"rendered"}';
-- collab presence
CREATE TABLE IF NOT EXISTS memo_collab_presence (
  memo_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (memo_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_memo_collab_presence_expiry ON memo_collab_presence(expires_at);
```

## 验证计划

- `bun run typecheck`、`bun run test:bulk`（group/memo/share 相关测试全量）、`bun run build:web`。
- 新增测试（已按实际文件名落地）：
  - `apps/api/src/group-collab-http.test.mjs`：群组编辑冲突 → 不丢数据；presence 写入与过期；collab-session 握手鉴权。
  - `apps/api/src/group-account-service.test.mjs`：公共账号创建、加群；多地登录会话并存。
  - `apps/api/src/group-account-guards.test.mjs`：公共账号建 Token 403、私人账号不受影响；
    改密码/禁用连带吊销 sessions + API Token；`shared_` 前缀三处保留。
  - `apps/api/src/share-display-policy.test.mjs`：服务端过滤 contentJson（rendered/source/hidden × 公开/群组两路）。
- 实时协同测试（已落地）：
  - `apps/api/src/collab-realtime.test.mjs`：房间合并、只读隔离、在场清理、持久化重放。
  - `apps/api/src/collab-seed.test.mjs`：TipTap JSON ↔ Yjs 来回无损、初始态决策（复用/重播种/兜底）。
  - `apps/api/src/collab-memo-writer.test.mjs`：写回列全、未变化跳过、删除/未知笔记不动。
  - `apps/api/src/collab-document-store.test.mjs`：持久态 + content_hash 水位。
  - `tests/collab-socket.test.mjs`：真 socket 双端收敛、迟到者拿到种子、写回进
    contentJson（含 revision 推进）、`?token=` 认证与拒绝、重启后合并与写回都在。
  - `apps/web/src/components/editor/collab-realtime.test.mjs`：实时准入（过滤视图禁入）、
    地址推导、peer 列表。
  - `WorkspaceApp.create-memo.test.mjs`：编辑器实例平时复用，进出实时才重建。

# Project Optimization Recommendations

> Status: Proposal; this document does not imply scheduling or implementation
>
> Assessment baseline: 2026-11-04, EdgeEver `1.103.10`
>
> Chinese version: [项目优化建议](project-optimization-recommendations.zh-CN.md)

## 1. Purpose and Principles

EdgeEver has grown from a single Web note-taking application into a multi-runtime product covering Web, desktop, Android, iOS, browser extensions, Cloudflare, and Docker. The next optimization phase should prioritize protecting user data, aligning cross-client behavior, and reducing long-term maintenance cost rather than maximizing the number of new features.

The recommendations follow these principles:

1. **User-data correctness takes priority over interaction convenience**: every automatic overwrite, merge, or conflict recovery behavior needs a verifiable product contract.
2. **Define contracts and tests before changing synchronization implementations**: Android, iOS, Web, and desktop policies must not evolve independently without a shared regression matrix.
3. **Cloudflare and Docker must share business semantics**: infrastructure adapters may differ, but authentication, saving, synchronization, and authorization logic must not fork.
4. **Upgrade compatibility takes priority over local simplification**: changes to authentication, data storage, migrations, installers, and automatic updates require a real old-to-new upgrade test.
5. **Optimization must be measurable**: each item needs a failure scenario, acceptance criteria, rollback path, and explicit unverified assumptions. “Refactoring completed” is not an acceptance result.

## 2. Assessment Baseline

This section records only the assessment snapshot. It must not be treated as continuing evidence for future versions.

Verified:

- Root TypeScript type checking passed.
- Android TypeScript type checking passed.
- The production Web build passed after transforming 3,567 modules.
- The non-E2E suite completed with 2,680 passing tests, 1 skipped test, and 0 failures.
- The Web performance budget check passed; initial module preloads were 753,522 bytes against a 768,000-byte budget.
- The Git working tree remained clean after verification.

Verification limits:

- The project declares Bun `1.3.14`; this assessment used Bun `1.4.2`.
- Playwright E2E was not run.
- Electron installers, the iOS app, and Android APKs were not built or launched.
- Android was not verified on a USB-connected physical device.
- Real Cloudflare and Docker upgrades and old-version migrations were not exercised.
- No concurrency load test was run, so the write-concurrency concern below is a source-visible risk rather than a reproduced production incident.

## 3. Optimization Priorities

### P0: Data Correctness and Product Identity

#### 3.1 Make memo updates an atomic database-level Compare-And-Swap

**Current state**

The normal memo-save path reads and checks `revision` / `content_hash`, but the final `memo_contents` update in `apps/api/src/memo-service.ts` is conditioned only on `memo_id`. Two concurrent requests may pass the earlier checks and then allow the later writer to overwrite the earlier one.

**Recommendation**

- Implement an atomic Compare-And-Swap within transaction semantics supported by both SQLite and D1. The update condition should include the expected revision and content hash, or use a mechanism with equivalent atomicity.
- Verify the number of affected rows. A CAS miss must return an explicit `revision_conflict` and must not continue writing search projections, revisions, audit records, or sync-log entries.
- Normal saves, real-time collaboration materialization, imports/restores, and Agent writes must share the same concurrency semantics.
- Do not rely only on a larger JavaScript critical section or an in-process lock; Cloudflare and multi-process deployments cannot derive correctness from process-local memory.

**Acceptance criteria**

- When two requests save from the same revision concurrently, at most one succeeds and the other consistently receives a conflict.
- Content, revision, search projection, history, audit, and sync logs cannot be partially committed.
- SQLite and D1 adapters run the same concurrency contract tests.
- Older clients preserve their local version when receiving a conflict and can explicitly copy or retry it.

**Risk and rollback**

This is a high-risk change to the core data-save path. Rollback should restore the old implementation while retaining the new tests. Before release, old clients must be tested against the new server for normal saves and conflicts.

#### 3.2 Align conflict policy across Web, desktop, Android, and iOS

**Current state**

Android enters `revision_conflict` when an offline draft has a stale base. iOS currently allows the local body to be resubmitted against the newest server edit session by default, producing a local-body-wins behavior. Desktop and Web have additional conflict classifications and recovery paths.

**Recommendation**

Define a cross-client synchronization contract before changing code. It should answer at least:

- What happens when devices A and B edit the same memo offline and reconnect in different orders?
- Do title, tags, body, notebook moves, and deletion use the same policy?
- Which cases may replay automatically, and which must remain in conflict?
- Are both bodies retained, and where can the user recover the version that was not selected?
- What happens after server-side deletion, account switching, instance rebuilds, or sync-identity changes?

The recommended default is: **do not silently replace one client’s body with another client’s body**. If a safe merge cannot be established, retain the local draft, fetch the server version, and enter an explicit recoverable conflict state.

**Acceptance criteria**

- The same fixtures produce the same classifications in TypeScript, Rust, and Swift synchronization implementations.
- Android, iOS, Web, and desktop present consistent outcomes and recovery actions for critical conflict scenarios.
- Retries after crashes, duplicate requests, and network timeouts do not duplicate memos or lose resource references.
- Product documentation describes conflict behavior without unverified guarantees such as “data can never be lost.”

#### 3.3 Align documentation, images, and upgrade identity for the permanent downstream fork

**Current state**

`AGENTS.md` defines this repository as a permanent downstream product branch and prohibits whole-tree upstream synchronization. However, the README still contains instructions for automatic upstream synchronization, and the root `compose.yaml` still defaults to the upstream image. Users may deploy a different product or overwrite downstream functionality by syncing upstream.

**Recommendation**

- Define the canonical repository, GHCR image, upgrade source, and failure rollback path for this product branch.
- Remove or rewrite user instructions that can trigger a whole-tree upstream replacement.
- Audit repository/image references across README files, Compose, installers, release documentation, the website, and GitHub Actions.
- Keep appropriate upstream attribution and manual comparison guidance, but separate them strictly from automatic upgrade entry points.

**Acceptance criteria**

- A clean deployment following public documentation runs an image whose revision matches a commit in this repository.
- Automatic upgrades never invoke Sync Fork or merge `upstream/main`.
- Documentation contains no conflicting push, upgrade, or image-source instructions.
- Upgrading from the current formal release preserves registration, administration, invite codes, and downstream migrations.

### P1: Synchronization Contracts, Maintainability, and Reproducible Builds

#### 3.4 Build cross-language synchronization conformance tests

The TypeScript shared package can align Web and Android behavior, but it cannot automatically constrain Rust sidecar and Swift implementations. Introduce language-neutral JSON fixtures covering:

- bootstrap, pagination, and cursor advancement;
- temporary-to-server ID remapping;
- duplicate submission, timeout retries, and idempotency;
- interactions between update/delete/restore and pending outbox operations;
- sync-identity resets and account/instance switching;
- revision conflicts and error classification;
- memo synchronization before and after resource-upload completion;
- forward compatibility when older clients do not know new fields.

Each client should consume the same fixtures and emit normalized results. Protocol changes should update the fixtures and compatibility notes before client implementations are changed.

#### 3.5 Split oversized state-orchestration modules along testable boundaries

Several files currently coordinate UI, persistence, synchronization, plugins, and editor lifecycle at the same time, creating high-regression areas, including:

- `apps/web/src/components/EditorPane.tsx`
- `apps/web/src/components/WorkspaceApp.tsx`
- `apps/web/src/components/DiagramEditorPane.tsx`
- `apps/mobile/src/components/LocalTiptapEditor.tsx`
- `apps/desktop/src/main/index.mjs`

The goal is not merely fewer lines. The goal is to establish testable boundaries:

1. Pure content conversion and conflict decisions must not depend on React or Electron.
2. Repositories handle data access, not UI selection state.
3. Sync engines own state machines and retries, not dialogs.
4. UI subscribes to explicit state and emits user intent.
5. Window, sidecar, update, protocol, and system-integration features in Electron main should have separate lifecycle modules.

**Acceptance criteria**

- Extracted modules can be tested without a browser or Electron runtime.
- Synchronization transitions use an explicit state graph or reducer rather than dispersed Boolean combinations.
- Existing tests and new regression tests lock down externally observable behavior before and after refactoring.

#### 3.6 Tighten runtime and dependency versions

The root `package.json` declares a Bun version, but several core dependencies use `latest`. The lockfile freezes the current installation, yet the next lockfile update can introduce several unrelated major upgrades at once.

Recommendations:

- CI validates the Bun version before building and always uses a frozen lockfile.
- React, Hono, TanStack Query, Zod, Vite, TypeScript, and other core dependencies use exact versions or controlled semver ranges.
- Upgrade editor, frontend framework, backend runtime, mobile, and release-tool dependencies in separate batches.
- Record compatibility risks per batch; do not combine broad lockfile refreshes with feature releases.
- Keep a regression test or explanation for why each patched dependency is needed and when the patch can be removed.

#### 3.7 Expand the pre-release verification matrix

The root suite covers substantial pure logic and integration behavior, but release-quality conclusions also require runtime verification:

- Playwright E2E uses a disposable local database and never a personal development database.
- Docker covers clean deployment, persistent restart, old-version upgrade, and graceful shutdown.
- Desktop covers sidecar crash recovery, offline writes, pre-update synchronization, and cross-version startup.
- Android uses a USB-connected physical device; an emulator is not an acceptable substitute.
- iOS covers offline outbox behavior, background recovery, and compatibility with older EditorBundles.
- Cloudflare covers D1 migrations, R2 resources, and large-file/streaming paths under Worker limits.

### P2: Performance, Operations, and Trust Boundaries

#### 3.8 Restore safety margin in the Web startup budget

Initial module preloads currently use about 98.1% of the budget. Large diagram, CodeMirror, X6, and Mermaid chunks are correctly deferred, but adding dependencies to common entry points can easily cross the limit.

Recommendations:

- Add a 90% warning threshold in addition to the 100% hard failure.
- Report which chunk deltas caused startup growth, not only aggregate bytes.
- Resolve modules that are both statically and dynamically imported so intended splitting takes effect.
- Allowlist large chunks only when they are genuinely demand-loaded; each new exception needs a user scenario and load timing.
- Record startup, large-memo opening, memo switching, and first editor-load baselines on low-performance devices.

#### 3.9 Improve synchronization observability and user recovery

Turn existing internal synchronization state into understandable diagnostics:

- current sync identity, cursor, and last successful synchronization time;
- pending/syncing/conflict/error counts;
- category, time, and retryability of the latest error;
- local database and resource-cache locations, sizes, and health;
- a redacted diagnostic export;
- graduated recovery actions such as “retry now,” “copy local version,” “load server version,” and “rebuild local mirror.”

Destructive recovery must back up local drafts and outbox entries first. “Clear local data” must not be the default response to synchronization failures.

#### 3.10 Document privacy and extension trust boundaries

Self-hosting does not imply end-to-end encryption, and plugin permission declarations do not imply an enforced JavaScript sandbox. Product and developer documentation should explain:

- under which policy an instance owner can read member notes;
- what content direct and proxied AI modes send to external providers;
- that client plugins are trusted code and which host capabilities they can access;
- MCP token scopes, revocation, and audit boundaries;
- that logs, diagnostic bundles, and URLs must not persist session or collaboration access tokens.

If untrusted plugins are introduced later, design iframe/worker/separate-process isolation and enforced capability checks separately. Adding manifest fields alone is not a security boundary.

## 4. Recommended Delivery Order

### Phase A: Contracts and Regression Baseline

1. Define the unified conflict policy and client capability matrix.
2. Add a reproducible database-level concurrent-save test.
3. Establish cross-language synchronization fixtures.
4. Correct documentation, Compose, and upgrade-identity conflicts.

### Phase B: Data Correctness

1. Implement database-level CAS.
2. Align conflict handling across clients.
3. Verify old clients, collaboration materialization, and Agent writes.
4. Run a real old-to-new upgrade in a disposable environment.

### Phase C: Maintenance Cost

1. Split large modules around state-machine, repository, and UI boundaries.
2. Tighten Bun and core dependency versions.
3. Include E2E, Docker, and client verification results in release gates.

### Phase D: Performance and User Experience

1. Recover startup-budget headroom.
2. Improve synchronization diagnostics and user recovery.
3. Continue testing large datasets, long memos, large resources, and unreliable networks.

## 5. Minimum Delivery Template for Each Optimization

Every future issue or implementation proposal should include at least:

1. **User value**: which observable problem it solves.
2. **Impact area**: affected runtimes, clients, migrations, and release assets.
3. **Failure scenario**: concrete input or state that produces the wrong outcome.
4. **Worst case**: whether the change can lose data, expose content, block upgrades, or make an instance unavailable.
5. **Compatibility strategy**: behavior for old clients, old databases, and rollback.
6. **Verification matrix**: automated tests, real platforms, and cross-version tests.
7. **Rollback path**: separate treatment for code, configuration, migrations, and data.
8. **Unverified assumptions**: conclusions that remain inferred rather than demonstrated.

## 6. Non-goals

These recommendations do not propose:

- converting the system to microservices for architectural novelty;
- immediately adopting PostgreSQL without a concrete team-scale need and SQL-dialect plan;
- replacing the editor, synchronization protocol, and local database in one large rewrite;
- mechanically splitting files only to reduce line counts;
- promising million-record service levels without capacity testing;
- using additional retries to hide non-idempotency, concurrent overwrites, or data corruption.

The most valuable direction is to preserve the existing modular-monolith and open-data strengths while making synchronization, concurrency, and upgrade behavior testable and consistent across clients.

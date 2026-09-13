# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Profile coordinates on the `memory` tool.** `add` / `replace` / `consolidate` now accept `facet` (one of the seven profile facets) and `level` (1..10) and pass them through to the store; `query` results carry both back. On `replace` an omitted coordinate keeps its current value, so rewriting an entry's text no longer drops its profile coordinates. Both parameters are documented in the English and Chinese tool descriptions.
- **`memory_profile` tool** (S3) — the write channel the per-domain knowledge level table was missing. `set` / `list` / `get` over the 31 fixed knowledge subdomains; `set` is idempotent (`domain` is the primary key), audited as `profile-set`, and rides the same `MemoryProtocolCore` approval gate as entry writes (the tool layer cannot bypass it). `tier` is optional and derives from `level` via `tierForLevel`.
- **`yammory-survey` skill** (S3) — a DSH-native, user-initiated profile questionnaire, source in `skills/yammory-survey/`. It reads the existing profile first, then asks one question at a time across 1–3 facets per round, covering the 24 questionnaire-legal sub-blocks (the five observation-only blocks are deliberately excluded); answers persist through `memory` (facet + tags) and `memory_profile` (per-domain level). Installation and discovery steps: `skills/README.md`.
- `npm run verify:skill` — a frontmatter gate for skill sources: kebab-case `name` matching the directory, `name` / `description` / `whenToUse` present, `description` within the DSH catalog cap, and every `./`-relative resource reference present on disk.
- **`memory_observe` tool** (S4b) — the observation channel: the second leg of profile collection, the one that reads behaviour instead of asking questions. `scan` is a free read that samples the user's own past messages through the public `session-query` service and returns one bounded slice plus an honest coverage bill (`covered` / `uncovered` / `scanned.injected` / `clamped`); `commit` writes 1..8 evidence-backed entries in one approval-gated atomic batch through `service.seed`, with `source` pinned to `observation` (never a model argument). Two whitelists do the narrowing: only sessions whose `cwd` equals the calling session's (or, without a `cwd`, only the calling session itself — there is deliberately no session-id parameter), and only `user/message` events whose `source.kind` is `user` or `user-rpc` (measured on this machine: 9 kinds exist and 910 of 1892 `user/message` events were system-injected pseudo messages). Reads fail loud when the service is missing (`SESSION_QUERY_UNAVAILABLE`) instead of pretending the history is empty.
- **`yammory-observe` skill** (S4b) — user-initiated behavioural observation, source in `skills/yammory-observe/`. It drives `scan` → inference → `commit`, infers only the five faces observation can reach (thinking style, character under difficulty, emotional patterns, self-image, decision style), demands a quotable fragment per conclusion, caps a round at 3 entries, and forbids personality-type labels, diagnoses and negative character judgements. Face manual with evidence thresholds: `skills/yammory-observe/references/observation-facets.md`.
- **`/memory observe`** (S4b) — the command face of the same channel: read-only, prints the slice and its coverage bill, then points at the model-driven inference path. It never writes and never calls a model.
- **A one-line directory at the end of the warm-up block** (S4b-6) — the cheapest answer to the S2 leftover that workspace-layer and agent-track entries are invisible until the model thinks to call `memory_recall`. The block now closes with a count of the entries deliberately kept out of it (never their text), so the model knows something is waiting.

### Changed

- **Renamed the project from `dsh-memento` to `yammory_system`.** The identity face changed (npm package name, Cordis plugin name, settings namespace, client module id, approval markers, snapshot headers, tool descriptions, error prefixes, MCP server name, CI workflow). Upstream attribution and the Apache-2.0 licence are preserved verbatim, and the upstream lineage (`dsh-memento`) is retained in the changelog history and in the export envelope's `plugin` field.
- Distribution pointers now target the new repository: `package.json` (`repository` / `homepage` / `bugs`), the five READMEs, `SECURITY.md`, the protocol schema `$id`, and the README-gate URL check. Upstream-only channels were removed from the READMEs (1024 ranking, Gitee mirror, upstream doctor badge, npm badges).
- The data plane was deliberately left unchanged for compatibility with existing stores: the default store directory `$DSH_HOME/dsh-memento/`, the `DSH_MEMENTO_DB_PATH` environment variable, and the `/api/memento/*` routes keep their original names.
- **Redesigned the `yammory-survey` skill** (still unreleased). The questionnaire is now framed as a supplement to background observation, with a budget note (questionnaire entries should stay under roughly a third of the profile). A round is now **at most 7 questions** ending in a stop-and-choose checkpoint (continue / pause / stop; no overall cap). Facets are picked "both ends first" (user-named > fast-changing > long-neglected > the rest); triggering was broadened (any mention of memory, profile or questionnaire); the question form is chosen per question and kept to one line; ambiguity is judged against a per-question 3–4 point list (≥70% covered passes, otherwise a single follow-up); the per-domain knowledge level is probed a notch above the recorded level; entries may run two to three sentences; re-asking follows half-life plus event triggers rather than a calendar; and survey-vs-observation conflicts resolve per facet (ability → observation, preference → self-report, intent-vs-behaviour → keep both). The question bank now annotates every question with its points.
- **`seed` now carries a single-source batch's `source` into the approval payload** (S4b). Without it the per-source granularity key had no footing for batched writes: `source:observation` could not be resolved, so a user who set `source:observation: off` (or `auto`) would silently get the global `writePolicy` instead. Mixed-source batches still omit it and fall back to `track/scope` and the global policy.
- **The warm-up block no longer emits an empty paragraph** when it has no constraint and no resident profile but does have proposals or a directory line to show.

## [0.5.12] - 2026-09-12

### Changed

- Rename the four translated READMEs to `README-<lang>.md`. npm selects the package-page readme as the first markdown file matching its `{README,README.*}` glob (`@npmcli/package-json`, publish path), and that glob order puts `README.<lang>.md` ahead of `README.md` — so npm was serving the Simplified-Chinese file for this package too (measured on 15/15 sampled packages of the family). The new names sit outside the glob, so the English source is served again. No content changed apart from the language-switcher link each translation holds to its siblings, and the repo readme gate still passes. Takes effect with the next release; an already-published version cannot gain a corrected readme retroactively.

- The release workflow now creates the GitHub Release itself, with the body taken from this version's CHANGELOG section. Until now a `v*` tag published to npm and stopped there, so every Release page had to be created by hand afterwards.
- Pin the `@deepseek-ai/dsh-*` dev/test dependencies to the published `0.1.5-rc.2` line and record `0.1.5-rc.2` in `dshWorkshop.compatibility.dshVersions`; the monthly Compat workflow now runs against `0.1.5-rc.2`. The peer range `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0` is unchanged, so no supported host line is dropped.

## [0.5.11] - 2026-09-10



### Changed

- Pin the `@deepseek-ai/dsh-*` dev/test dependencies to the published `0.1.5-rc.1` line and record `0.1.5-rc.1` in `dshWorkshop.compatibility.dshVersions`; the monthly Compat workflow now runs against `0.1.5-rc.1`. The peer range `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0` is unchanged, so no supported host line is dropped.

### Docs

- Refresh the five-language README compatibility baseline to `dsh-v0.1.5-rc.1` (verified 2026-09-10).

## [0.5.10] - 2026-09-09

### Changed

- Align the `@deepseek-ai/dsh-*` peer ranges to `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0` and pin the dev/test dependencies to the published `0.1.5-alpha.1` line: adaptation to DeepSeek Harness `dsh-v0.1.5-alpha.1` (session format V3, `ctx.agent` removal, `Inbox` type-only interface); runtime behavior is unchanged for every supported host line.
- Record `0.1.5-alpha.1` in `dshWorkshop.compatibility.dshVersions`.

### Docs

- Refresh the five-language README compatibility baseline to `dsh-v0.1.5-alpha.1` (verified 2026-09-09).

## [0.5.9] - 2026-09-08

### Docs

- Repair GBK mojibake in historical CHANGELOG entries: em dashes, arrows, comparison signs, the multiplication sign, a mangled emoji (U+9983 U+E765), and the mangled Chinese appendix label (U+6D93 U+E15F U+6783) are restored to the clean pre-corruption text; no behavior change.


## [0.5.8] - 2026-09-07

### Docs

- Fix the DSH plugin badge URL: shields.io rejects the four-segment static badge form with "404 badge not found"; the label now uses the documented double-dash form (`dsh--plugin`), rendering identically; no behavior change.


## [0.5.7] - 2026-09-07

### Fixed

- Complete the 0.5.6 peer-range alignment: `@deepseek-ai/dsh-settings` was still on the old `>=0.1.0-rc.1 <0.2.0` band (the same prerelease-tuple flaw that 0.5.6 fixed elsewhere), and `package-lock.json` still carried the stale `>=0.1.0-rc.8` ranges; package.json peers and the lockfile are now uniformly `>=0.1.2-rc.1 <0.2.0` (detected by the `dsh-plugin-doctor` R8 check); no behavior change.

## [0.5.6] - 2026-09-07

### Fixed

- Align the `@deepseek-ai/dsh-*` peer ranges to `>=0.1.2-rc.1 <0.2.0`: the older `>=0.1.0-rc.8 <0.2.0` band resolved to only the `0.1.0-rc.8` prerelease under registry-driven resolution and broke fresh tarball installs; no behavior change.

### Docs

- Refresh the five-language README support-version wording: the verified GitHub tag `dsh-v0.1.3-alpha.1` now leads the compatibility claim, while npm `0.1.2-rc.1` stays the published dependency-pin line (peers `>=0.1.2-rc.1 <0.2.0`); no behavior change.


## [0.5.5] - 2026-09-04

### Changed

- Align the devDependency pins to the published dsh `0.1.2-rc.1` line, move the compat CI probes from `0.1.2-alpha.5` to `0.1.2-rc.1`, and refresh the version notes (the adaptive session-event gate keeps staying closed on rc.1); no behavior change.

## [0.5.4] - 2026-09-03

### Added

- **Host settings panel integration** — when the DSH settings service is mounted, the plugin registers the `dsh-memento` settings namespace (every `Config` field except `enabled`, plus a new `panel.enabled`), and its browser half contributes a **top-level `dsh-memento` entry to the DSH settings sidebar** (via the public `settings.section` slot, like the built-in sections). Edits persist to the settings user layer (`settings.yaml`) with staged-draft save/discard/per-field reset semantics. Nearly everything applies live: write policies, language, budgets, limits, proposals, panel; `dbPath` / `auditRetentionDays` apply by reopening the store (old one closed safely); `retrieval.vector` swaps the retriever in place; only `snapshotOrder` needs a DSH reload (changes are recorded as a `settings-startup-fields` audit row). Without the settings service the plugin behaves exactly as composed.
- **Hideable floating panel button** — new `panel.enabled` config (default `true`); `false` stops the web panel from rendering its 🧠 entry button (addresses upstream issue #7). The panel probes its own `/api/memento/entries` response at startup and falls back to showing the button when the probe fails.

### Changed

- Dev pins `@deepseek-ai/cordis-plugin-loader ^1.0.3` / `@deepseek-ai/cordis-plugin-include ^1.0.7` aligned with the `cordis 4.0.2` peer ranges.

## [0.5.3] - 2026-09-02

### Docs

- Sync the five-language READMEs to the 0.1.2-alpha.5 facts; no behavior change.

## [0.5.2] - 2026-09-02

### Changed

- Compatibility baseline raised to **0.1.2-alpha.5**: the `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-attachment` dev dependencies are pinned to `0.1.2-alpha.5`, `dshWorkshop.compatibility.dshVersions` lists `0.1.2-alpha.5`, and the compat probe pins are raised to `0.1.2-alpha.5`. The adaptive session-event gate stays closed on `0.1.2-alpha.5` (`KNOWN_SESSION_EVENT_TYPES` still lacks `memory/*` and `Session.append` still cannot stamp the `ignorable` envelope), so behavior is unchanged.

## [0.5.1] - 2026-09-01

### Changed

- Compatibility baseline raised to **0.1.2-alpha.3**: the `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-attachment` dev dependencies are pinned to `0.1.2-alpha.3`, `cordis`/`schemastery` dev pins move to `^4.0.2`/`^3.18.2` (the `schemastery` peer keeps `>=3.0.0`), `dshWorkshop.compatibility.dshVersions` lists `0.1.2-alpha.3`, and the compat probe pins are raised to `0.1.2-alpha.3`. The adaptive session-event gate stays closed on `0.1.2-alpha.3` (`Session.append` still cannot stamp the `ignorable` envelope), so behavior is unchanged.

## [0.5.0] - 2026-08-26

### Added

- **Embedding Provider seam (`ctx.memoryEmbedding`)** — new `lib/embedding.mjs` registry ships a deterministic fake-hash provider by default, so third-party plugins can register real embedding backends behind the same Service Definition.
- **Retrieval Provider seam (`ctx.memoryRetrieval`)** — new `lib/retrieval.mjs` registry keeps the built-in substring retriever as the zero-dependency main path and adds an optional `VectorRetriever` for semantic recall, enabled when `config.retrieval.vector` is `true` and an embedding provider is detected (graceful fallback to substring otherwise).
- **stdio MCP server export** — new `bin/mcp-server.mjs` and `lib/mcp.mjs` expose the memory seam as an MCP server through the `dsh-memento-mcp` bin.

## [0.4.5] - 2026-08-23

### Changed

- Development docs sync (no functional change): the five-language READMEs now record the current test count (**141**, up from 133) and list the complete gate set (`lint`, `verify:self-contained`, `verify:artifacts`) alongside the existing gates; `AGENTS.md`'s `scripts/` map and command list now include the same three gates plus the `loader-runner.mjs` real-Loader runner.

## [0.4.4] - 2026-08-22

### Changed

- DeepSeek Harness compatibility baseline raised to **0.1.1-rc.2**: `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-tools` dev dependencies pinned to `0.1.1-rc.2`, `dshWorkshop.compatibility.dshVersions` updated to `["0.1.1-rc.2"]`, and the `compat.yml` probe pins raised to `0.1.1-rc.2`. Peer ranges stay `>=0.1.0-rc.8 <0.2.0` (no rc.2-only API is required).
- Adaptive session-event gate re-verified on rc.2 and kept closed: rc.2 still ships no plugin event registration surface (`KNOWN_SESSION_EVENT_TYPES` has no `memory/*`) and `Session.append` still offers no writer-side `ignorable` marker (its third arg is surface intent only), so appending unregistered types would still make a session unloadable. The two-arg `session.append(type, data)` shape remains correct for non-surface events. Comments in `index.mjs` / `types.d.ts` / `AGENTS.md` and the five-language READMEs now record this rc.2 verification. All gates pass against rc.2 (141 tests, protocol conformance 22/22, typecheck, lint, coverage, five-language README check, self-contained/artifact verification).

## [0.4.3] - 2026-08-21

### Changed

- DeepSeek Harness compatibility baseline raised to **0.1.0-rc.8**: `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-tools` peer ranges now `>=0.1.0-rc.8 <0.2.0`, dev dependencies pinned to `0.1.0-rc.8`, and `dshWorkshop.compatibility.dshVersions` updated to `["0.1.0-rc.8"]`. All gates (141 tests, protocol conformance 22/22, typecheck, lint, coverage, five-language README check, self-contained/artifact verification) pass against rc.8.
- Adaptive session-event gate re-verified on rc.8 and kept closed: rc.8 still ships no plugin event registration surface (`KNOWN_SESSION_EVENT_TYPES` has no `memory/*`) and `Session.append` still offers no writer-side `ignorable` marker, so appending unregistered types would still make a session unloadable by the persistence layer. Comments in `index.mjs` / `types.d.ts` / `AGENTS.md` now record this rc.8 verification.

## [0.4.2] - 2026-08-19

### Changed

- `package.json#dshWorkshop.lifecycle.activation` upgraded from `restart-profile` to `hot-reload`: with the panel routes riding the plugin fiber since 0.4.1, dispose-and-reactivate is fully clean. Proven by a Loader-level hot-reload composition test that drives `Include.refresh()` — the same transaction the HMR watcher triggers — through a `language` en → zh → en cycle against a duplicate-strict mock `webServer`, asserting the memory seam, the re-applied config, and the routes re-registering without a duplicate route.

## [0.4.1] - 2026-08-19

### Fixed

- The panel routes now unload with the plugin fiber: the three `/api/memento/*` route disposers ride one `ctx.effect`, so a config hot-reload or disable followed by a remount no longer throws `duplicate exact route` (the host route table previously kept handlers closed over the unloaded fiber). Regression covered by a dispose-and-remount lifecycle test against a duplicate-strict route table.

## [0.4.0] - 2026-08-16

### Added

- **dsh-memory-protocol v1** — the community rehearsal of the DSH memory protocol: normative spec in `docs/protocol-v1.md` (+ 中文), machine-readable JSON Schema in `docs/schemas/dsh-memory-protocol-v1.schema.json`, entry spec extended with `tags` (≤16 × ≤32 chars) and a per-entry `version` that increments on every `replace` (store schema v4, forward-migrated).
- **Protocol/implementation separation** — write semantics moved into `lib/protocol.mjs` (`MemoryProtocolCore`, zero DSH dependencies); `MemoryService` is now a thin subclass that only injects the approval transport and the session-event emission gate. Behavior is unchanged.
- **Adapter registry `ctx.memoryAdapters`** — reversible `register()`/`list()`/`adapt()`/`export()` plus three built-in reference adapters: `mem0`, `hermes-memory-md`, `claude-code-memory-md` (pure data converters — never model extraction). New command verbs: `/memory adapters`, `export --adapter=<id>` (read-only), `import --adapter=<id> <path|inline>` (rides the approval-gated `seed`, per-entry audit). Onboarding guide in `docs/adapters-guide.md` (+ 中文).
- **Protocol conformance suite** — `test/protocol-conformance/`: 22 distributable cases (entry model, write semantics, budget model, audit reconstruction, export envelope) with a `--provider` CLI for third parties; CI runs them against dsh-memento's own provider as the golden reference (`npm run test:conformance`).
- **Upstream proposal material** — `docs/upstream-proposal.md` (+ 中文): why the official `ctx.memory` seam should adopt the protocol, differences from the current seam, and the migration path.
- `memory` tool accepts optional `tags` on add/replace/consolidate; tool results and `/memory export` documents carry `tags`/`version`.

### Changed

- Five-language READMEs: protocol section, adapter matrix, conformance suite, new command verbs, and the development gate list (now 133 tests).
- ARCHITECTURE: decisions 13–15 (protocol separation, schema v4, adapter registry + conformance suite).
- npm package now ships the protocol docs and the conformance suite (`files` whitelist).

## [0.3.1] - 2026-08-15

### Fixed

- Boot crash on default Windows setups (reported in [issue #1](https://github.com/PerryLink/dsh-memento/issues/1)): `dsh web` does not write the harness's resolved home back to `process.env.DSH_HOME`, so `resolveDbPath` threw `MISSING_DSH_HOME` and failed the whole profile load. It now falls back to `~/.dsh` — the same documented fallback as the official harness (`resolveDshHome()`), replicated with `os.homedir()` to keep `lib/` zero-DSH-dependency. Relative `dbPath` values resolve against the same fallback home.
- Removed the now-unreachable `MISSING_DSH_HOME` error code.

## [0.3.0] - 2026-08-15

### Added

- `/memory import` subcommand: restores entries from a `/memory export` document (file path or inline JSON starting with `{`). Validates the `dsh-memento` / `memory-export-v1` markers and entry shapes (unknown schema versions fail loudly), caps one import at 1000 entries, then rides `seed` — single approval, full budget pre-check, one atomic transaction. `source`/`workspaceKey`/`agentKey` survive the round-trip; entries get fresh ids/timestamps and reset recall counts. This completes the backup/migration story.
- Approve-what-you-see approval payloads: `replace` carries `from:` (full previous entry) + `to:` (new text), `remove` carries the full text of the entry being deleted (no more bare substrings), and `consolidate` carries each target's resolved text (300-char excerpt cap per target) — the approval reason now holds the complete change being authorized.
- `*-denied` audit rows: every rejected/cancelled/unavailable write (including the turn-outside `/memory` gate path, which has no approval audit pair) lands a denied row with the real decision source — denials now have their own evidence chain.
- Session-visibility isolation for reads and write targeting: `memory` / `memory_recall` queries filter by the session's `agentPreset` (shared + own agent), and `replace`/`remove`/`consolidate` can only target entries visible to the session (shared + own agent, workspace entries only for the session cwd). Management surfaces (`/memory`, the panel) keep the full cross-agent view and now render non-shared entries' agent keys.
- `query` accepts an explicit `agentKey` option (`service.query(filter, { agentKey })`); without it, behavior is unchanged (full view, backward compatible).

### Fixed

- `proposalDecide` now resolves and updates inside one transaction: concurrent approve/dismiss races settle first-writer-wins instead of double-deciding.
- `/memory proposals approve` no longer masks a successful write when the proposal was concurrently decided elsewhere.
- Release workflow is now idempotent: it skips `npm publish` when the tag's version is already on npm, so re-pushing an old tag cannot fail a run.
- Cross-platform test fix: the `resolveDbPath` absolute-path sample now matches the platform's `path.isAbsolute` semantics (a Windows drive path is relative on POSIX) — CI is green on all three platforms instead of red on Linux/macOS.

### Changed

- Five-language READMEs: npm install line (package published since 0.2.0), `import` in the command list, the approval-payload and visibility semantics, and the test count.
- ARCHITECTURE decisions 2/5/6/8/11 updated for the payload, denied-audit, visibility, and import semantics; the readme gate now also enforces the `import` token across all five languages.

## [0.2.0] - 2026-08-14

### Added

- `language` config (`'en'` default / `'zh'`): model-visible text, the frozen snapshot, `/memory` command output, and the web panel all switch languages; invalid values fail loudly at load.
- `/memory export` subcommand: read-only JSON dump of all entries + budgets (backup / migration / transparency).
- Web panel renders `en`/`zh` labels according to the plugin's `language` (the language travels with the `/api/memento/*` responses).
- Bilingual `memory_recall` tool description, parameter descriptions, and result renderer.
- New README section "What we learned from the terminal memories" (Claude Code / Codex / Hermes), mirrored across all five languages.
- `commandListLimit` (default 50) and `commandAuditLimit` (default 10) config fields for the `/memory` command surface.
- Coverage gate (`npm run check:coverage`: lib ≥90%, index.mjs ≥85%, all files ≥90%) and a weekly `next`-rc compatibility probe workflow.
- Peer dependency ranges widened to `>=0.1.0-rc.6` so later harness rc releases resolve without a coordinated release.
- Package metadata (`repository`/`homepage`/`bugs`), `types` conditions on the `exports` map, and this changelog.

### Fixed

- Web panel entries route now honors the `limit` query parameter and renders a truncation notice (previously >20 entries were silently capped).
- `/memory list` / `query` render at most `commandListLimit` entries and label truncation instead of silently dropping rows.
- `seed` inserts run in one SQLite transaction: any mid-batch failure rolls back the whole batch (the documented all-or-nothing promise now holds).
- `replace` re-resolves the target and recomputes the net budget delta after approval, closing the stale-previous race during the approval wait.
- Audit rows record the real decision source (`via approval, writePolicy …` vs `via write gate`) instead of always labeling the configured policy.
- `memory_recall` description now states the true case semantics (case-sensitive for memory entries, case-insensitive for session history).
- `maxEntriesPerQuery` is documented and enforced as the default result cap; explicit `limit` values are hard-capped at 1000 by the provider.

## [0.1.0] - 2026-08-14

### Added

- `ctx.memory` service seam (Service Definition): `budgets` / `add` / `replace` / `remove` / `query` / `seed`, with the approval gate forced inside the write methods.
- Local SQLite provider (`node:sqlite`, WAL, `0600`): entries + audit tables, unique-substring replace/remove, migrations with loud version checks.
- Approval-gated write policy (`ask` / `auto` / `off`, model-invisible) with a prepend answerer on the `approval/request` waterfall.
- `memory` tool with structured results, Save/Skip guidance, and pure renderers.
- Frozen per-session snapshot injection via a `systemPrompt` section (order `-50`), reconstructed verbatim from `request/header.system` plus audit rows.
- `memory_recall` tool: two-part recall over memory and session history with graceful degradation.
- `/memory` command (`list` / `query` / `add` / `remove` / `budgets` / `audit`) with an out-of-turn write gate sharing the same waterfall and policy.
- Read-only web panel (`dsh.client` drawer): browse entries, search, budget bars, audit tail.
- Session-event vocabulary (`memory/added|updated|removed|recalled|snapshot`) merge-declared in `types.d.ts` with rc.6-adaptive dispatch.
- Hard per-track/per-layer character budgets with structured `BUDGET_EXCEEDED` errors — never truncate, never auto-compact.
- CI matrix (three platforms × Node 22.19/24), typecheck gate, and five-language README consistency gate.

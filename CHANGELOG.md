# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The panel drawer's information hierarchy, and the "tidy the whole library" row that used to wrap.** The migration to React kept the old flex attribute on the tidy note (`flex: 1 1 100%`) inside a non-wrapping header row, so the note claimed the whole line, the basis-based shrink squeezed the button from about 76px to 69px, and the label broke into "整理全" / "库". The note now lives under the button in its own footer block (`.mem-tidy`: button on its own line, note below), and the button asks for its natural width (`flex: none` + `white-space: nowrap`). Same pass, four more corrections: group headings stop wearing the drawer-title class (small, tertiary, tighter — the hierarchy is legible again instead of one flat weight); the tidy block moves from mid-drawer to a pinned drawer footer, so the body scrolls and the action stays put; budget rows read as face name (left) + `used / limit` (right, tabular numerals) + a hairline bar, with an `over the line` warning Tag and warning-coloured numbers **when usage passes the warning line — the wording now matches F3, where the limit warns and never refuses a write**; and Esc closes the drawer, because a 460px overlay that covers the page should not be keyboard-trapped. The refresh and close buttons drop the duplicated tooltip (a button that says "Refresh" needs no bubble repeating it) and go `ghost`, so the header no longer carries three equally heavy buttons. Entry rows lose their per-row card fill in favour of a hairline separator, which is what lets the panel fit more than one thought per screen. Panel copy gains a filter-count line and splits "memory is empty" from "nothing matches the filter", so an empty result stops accusing the store of being empty; the switch's off state drops its strike-through (striking out the word "memory" reads as broken, not as off).
- **Recall now has a weighting formula, and every weight is a setting (spec 3.3, layer B · the zero-dependency half).** `memory_recall` used to rank hits by relevance with recall count and freshness as *tie-breakers only*; it now scores `relevance × (1 + heat·heatFactor) × (1 + freshness·freshnessFactor)`. **Heat decays**: the factor is `recalls (saturating) × 2^(−days since last recall / heatHalfLifeDays)`, so a memory has to keep being recalled to keep its heat — without the decay, promoting recall count into the score would wire up a reinforcing loop (more recalls → higher score → more recalls) that eventually lets a few entries monopolise the recall slot. Freshness likewise halves every `freshnessHalfLifeDays`. Two more matching-face changes: a token that hits only `entry.tags` now scores `tagDiscount` instead of nothing (a body hit still scores `1`), and a missing `lastRecalled` / `updatedAt` scores **zero bonus** rather than full — treating "no timestamp" as "newest" would have inverted the old ordering. All six values ride `recall.weighting` in `Config`, editable live from the DSH settings card (`0.3 / 10 / 14 / 0.2 / 30 / 0.5` by default); changing them rebuilds the keyword retriever in place. Zero new dependency, no schema change, no model call.
- **The web panel now borrows the host's own controls and design tokens.** The drawer and the composer switch stop shipping private look-alikes: every control comes from `@deepseek-ai/dsh-client-ui-primitives` (`Button`, `Input`, `Tag`, `StateDot`, `Switch`, `Tooltip`), required at runtime from the host's browser-side platform module table — still zero build, still a hand-written `client/client.js`, no bundler and no new dependency. Every colour in the plugin's own CSS is now a `--dsw-alias-*` / `--dsw-static-*` / `--dsw-elevation-*` token, so light and dark themes follow automatically; the hardcoded hex values and the `--dsw-alias-label-error` name (which never existed) are gone. The drawer also moved to the official frame-wide floating layer (`shell.overlay`, same seat `dsh-tidewatch` uses), which retires the one hard coupling between two plugins: the code that measured the tidewatch badge and pushed the button above it.
- **The three observability numbers in the panel drawer** (收边 §1). The drawer reads the already-shipped `GET /api/memento/stats` and renders the response's ready-made `lines` verbatim, so the panel and `/memory stats` can never drift apart in wording; the language follows the response's `language` field. Pure read, zero model, no audit rows.
- **"Tidy the whole library" button — a queue, not an action** (收边 §2, spec 3.5.9). One click registers a pending marker (`POST /api/memento/tidy-request`, new `tidy_requests` table, **schema v7**); the next session's warm-up block closes with a line asking the model to run one whole-library tidy, and the marker turns `done` when a tidy write (`supersede`) lands, with a `tidy-request`/`cleared` audit row. Registering writes nothing but that marker: no model call, no entry touched, no background channel — the merge judgement still happens inside a session. Both routes ride the `connection.fetch` trust fence.
- **README door plate.** "How it's different" now names the plugins this repo actually competes with today (`dsh-mneme`, `dsh-meow-memory`, `dsh-persona-memory`) and states the two differences that hold: a seven-facet profile carrying a per-domain knowledge level, and facet arbitration. The "published on npm" wording is gone across all five languages — the documented channel is GitHub (this repo is not on the npm registry), and the MCP example now resolves the package through `-p github:…`.
- **Profile coordinates on the `memory` tool.** `add` / `replace` / `consolidate` now accept `facet` (one of the seven profile facets) and `level` (1..10) and pass them through to the store; `query` results carry both back. On `replace` an omitted coordinate keeps its current value, so rewriting an entry's text no longer drops its profile coordinates. Both parameters are documented in the English and Chinese tool descriptions.
- **`memory_profile` tool** (S3) — the write channel the per-domain knowledge level table was missing. `set` / `list` / `get` over the 31 fixed knowledge subdomains; `set` is idempotent (`domain` is the primary key), audited as `profile-set`, and rides the same `MemoryProtocolCore` approval gate as entry writes (the tool layer cannot bypass it). `tier` is optional and derives from `level` via `tierForLevel`.
- **`yammory-survey` skill** (S3) — a DSH-native, user-initiated profile questionnaire, source in `skills/yammory-survey/`. It reads the existing profile first, then asks one question at a time across 1–3 facets per round, covering the 24 questionnaire-legal sub-blocks (the five observation-only blocks are deliberately excluded); answers persist through `memory` (facet + tags) and `memory_profile` (per-domain level). Installation and discovery steps: `skills/README.md`.
- `npm run verify:skill` — a frontmatter gate for skill sources: kebab-case `name` matching the directory, `name` / `description` / `whenToUse` present, `description` within the DSH catalog cap, and every `./`-relative resource reference present on disk.
- **`memory_observe` tool** (S4b) — the observation channel: the second leg of profile collection, the one that reads behaviour instead of asking questions. `scan` is a free read that samples the user's own past messages through the public `session-query` service and returns one bounded slice plus an honest coverage bill (`covered` / `uncovered` / `scanned.injected` / `clamped`); `commit` writes 1..8 evidence-backed entries in one approval-gated atomic batch through `service.seed`, with `source` pinned to `observation` (never a model argument). Two whitelists do the narrowing: only sessions whose `cwd` equals the calling session's (or, without a `cwd`, only the calling session itself — there is deliberately no session-id parameter), and only `user/message` events whose `source.kind` is `user` or `user-rpc` (measured on this machine: 9 kinds exist and 910 of 1892 `user/message` events were system-injected pseudo messages). Reads fail loud when the service is missing (`SESSION_QUERY_UNAVAILABLE`) instead of pretending the history is empty.
- **`yammory-observe` skill** (S4b) — user-initiated behavioural observation, source in `skills/yammory-observe/`. It drives `scan` → inference → `commit`, infers only the five faces observation can reach (thinking style, character under difficulty, emotional patterns, self-image, decision style), demands a quotable fragment per conclusion, caps a round at 3 entries, and forbids personality-type labels, diagnoses and negative character judgements. Face manual with evidence thresholds: `skills/yammory-observe/references/observation-facets.md`.
- **`/memory observe`** (S4b) — the command face of the same channel: read-only, prints the slice and its coverage bill, then points at the model-driven inference path. It never writes and never calls a model.
- **A one-line directory at the end of the warm-up block** (S4b-6) — the cheapest answer to the S2 leftover that workspace-layer and agent-track entries are invisible until the model thinks to call `memory_recall`. The block now closes with a count of the entries deliberately kept out of it (never their text), so the model knows something is waiting.
- **The tidy machine (F6) — the negative feedback loop v2 was missing.** Dropping the hard cap left memory with no way back down; this adds the merge-and-demote path, driven by the current session's model (never a background `ctx.llm` call, which would be a black box outside the session log). Two new `memory` tool actions: `tidy` returns a **read-only** plan (backlog, heat-window candidates grouped per bucket, in-bucket Jaccard pair hints), and `supersede` merges 1..20 entries into one `merged`-tagged entry while the old ones are **kept** and demoted to `superseded` — never physically deleted. `/memory tidy [--days=N]` prints the same plan for the user; a new read-only `agent/turn-stopping` check computes the backlog (>= 2000 chars or >= 10 entries since the last consolidation, plus a 12-hour fallback) and, when the line is crossed, lands one throttled `tidy-due` audit row and appends a one-line hint to the next session's warm-up block. It never starts a tidy on its own. Buckets are never crossed (`track × scope × agentKey`, plus `workspaceKey` on the workspace layer) and tidy only ever touches the session-visible set. New pure-function core: `lib/consolidate.mjs` (heat selection, `merged` skip, bucket grouping, pair hints, backlog accounting). New skill source: `skills/yammory-tidy/` (`SKILL.md` + `references/merge-rules.md`).
- **The `entries.status` column finally has write behaviour.** `store.supersedeEntries({ids, text?, tags?, ...})` demotes a batch inside one transaction (unknown id, duplicate id, an already-demoted target, or an id outside the session-visible set all fail loud and roll the whole batch back), plus `entryById(id)` and `allEntries()` (every row, superseded included — the read paths deliberately do not use it). A merge can land in the same transaction (`text` present) or be pure demotion (`text` omitted).
- **Observability — the three numbers (F7).** `/memory stats` is a pure read (no model, no new table, no audit row) printing ① repetition rate (pairwise Jaccard over tokenized entries, O(n²); the corpus is small), ② recall hit rate (hits / recalls, from `recalled` audit rows) and ③ injection volume (characters and bullet lines of the warm-up block, from `snapshot` audit rows). New pure-function module `lib/stats.mjs`; new panel data route `GET /api/memento/stats` (same `connection.fetch` trust fence as the other panel routes). **The success rate is deliberately absent**: "did the injected block actually land" has no signal source in this repo, and the command says so instead of substituting another number.
- **`restore` — soft delete finally walks both ways (S5).** F6 could only ever demote. `store.restoreEntries({ids})` flips a batch back inside one transaction (`superseded → active`, unknown ids and already-active targets fail loud and roll the whole batch back — this is not a general "set status" hatch), and the protocol action `restore(input, write)` rides the same approval gate, the same per-session switch and the same bucket/visible-set checks as every other write, landing one `restore` audit row per entry. A restored entry keeps its `version` and its `updated_at` (nothing was rewritten) and re-enters every session's view: warm-up block, recall, query, write targeting and the warning-line usage. Faces: `memory` tool action `restore` and the `/memory restore <id...>` command.
- **`arbitrate` — facet arbitration as a code invariant, not a discipline (S5).** When one fact carries two sources (an observation and a self-report), the new `arbitrate` action settles it on **one facet**: `ARBITRATION_BY_FACET` maps 能力与技能 → observation, 价值与意愿 → self-report, and the other five faces → coexist. **The table is the direction** — there is deliberately no reverse argument, which is what makes "ability follows observation" a code invariant rather than a rule someone has to remember. A group keeps its most recently updated entry (the rest of that group is demoted too, so the choice is mechanically reviewable rather than a model's pick); on the coexist faces nothing is demoted and both sides get a `gap` tag, because the gap itself is the evidence. Facet mismatch, a missing facet, a single-source call and cross-bucket ids all fail loud before the approver is ever disturbed. One approval, then demotions + tags + audit (`arbitrate` per demotion with `text: null`, `arbitrate-tag` for a tag, one closing `arbitrate` summary naming who was kept, who was demoted and why). New `store.tagEntries({ids, tag})` (idempotent per entry, fails loud when the tag count would exceed the cap). Faces: `memory` tool action `arbitrate` and `/memory arbitrate <id...>`.
- The `yammory-tidy` skill's `references/merge-rules.md` now routes conflicts into `arbitrate` (section 6 carries the arbitration table) instead of telling the model to do nothing and hand the conflict to the user.

### Fixed

- **`retrieval.vector` no longer counts a fake embedding as a semantic backend.** `buildVectorRetriever` used to hardcode `embeddings.get('fake-hash')`, so turning the switch on installed a vector retriever backed by a token-hash bag — which would have *silently zeroed recall on CJK text*, because that embedding splits on `[\p{L}\p{N}]+` and a whole Chinese sentence is one such segment. Embedding providers now declare `semantic?: boolean` (the shipped `FakeEmbeddingProvider` declares `false`, third-party providers default to semantic), `detectVectorBackend` reports a non-semantic provider as unavailable (`reason: 'embedding provider is not semantic'`), and the vector path picks the first *semantic* provider by ascending id. With only the fake provider present, `retrieval.vector: true` simply falls back to the keyword retriever — graceful, never a loud failure, per the existing optional-backend rule.
- **The panel no longer depends on surviving another plugin's hot reload.** The drawer's layout sheet was injected as an *untagged* `<style>`; the host's module loader hands untagged style tags to whichever plugin is materializing next, and HMR removes every `<style data-plugin>` owned by the plugin it swaps in — so a neighbour plugin's hot reload could delete this panel's positioning and layering wholesale, collapsing the drawer into a wall of body text over the interface. The sheet is now signed (`data-plugin` / `data-plugin-css`, the same signing `CARD_CSS` already used), it is injected before the host primitives are required (a failed `require` can no longer skip it), and the drawer, the floating entry button and the panel root also carry their positioning inline, so the surface survives a lost sheet.
- **The per-session switch moved from under the composer to the conversation header.** `conversation.composer.dock` is officially "ambient entries below the composer card", which parked the switch beneath the input box; it now registers in `conversation.session.header.actions` (`order: 0`, right after the agent-preset label's leading `-10` band), next to where the session's agent preset is shown.

### Changed

- **The panel drawer is React now, not hand-built DOM.** `installPanel` used to `document.createElement` its way through a `innerHTML` string table with an `escapeHtml` helper; it now mounts one `react-dom/client` root and renders components (`react.createElement`, no JSX, so nothing about the zero-build constraint changes). Structure, wording and behaviour are the same — same ids (`#mem-open`, `#mem-drawer`), same `/api/memento/*` calls, same filter semantics, same "tidy the whole library" queue semantics. The one visible difference is deliberate: the switch state next to the composer is now the official two-state `Switch` instead of a private dot-and-label button. The DOM-shaped half-side test was rebuilt on a small test-only React/DOM harness (`test/client-harness.mjs`), since the repo deliberately carries no React of its own.
- **Per-session memory switch (F5).** Every session now carries its own switch, stored in the plugin's own SQLite database (new `session_switch` table, schema v5 → v6; a row means "off", no row means "on" — the default). Off means four things at once: **injection stops** (the frozen warm-up block is deleted for that session and the `systemPrompt` section returns an empty string from then on, with no new `snapshot` audit row), **recall is refused** (`memory_recall` and the `memory` tool's `query` action return `SESSION_MEMORY_OFF` without querying, without bumping recall counts and without a `recalled` audit row), **writes are refused** at the same layer as the approval gate (inside `MemoryProtocolCore.add/replace/remove/consolidate/seed/setProfile`, ahead of the gate, so no calling path — tool, command, import, proposal approval — can slip past it; the denied attempt lands a `session-off` audit row with `text: null`), and **observation leaves the session alone** (a closed session cannot `memory_observe scan`, and closed sessions are filtered out of the history side of the selection before truncation, counted in the new `scanned.skippedOff` bill). Management reads (`/memory list` / `query` / `budgets` / `audit` / `adapters` / `export` / `proposals`) are unaffected. Toggle it with `/memory session [on|off|status]` or the new composer switch (`conversation.composer.dock`, session scope), whose `GET`/`POST /api/memento/session` route registers through `ctx.connection.fetch` — the same trust fence as the panel routes, never a `webServer` exact route. The switch state itself deliberately never enters the session log (`memory/*` event types are still unregistered, and appending one would make that session refuse to load), and every `session-switch` / `session-off` audit row carries `text: null`. No new Config field.

- **Renamed the project from `dsh-memento` to `yammory_system`.** The identity face changed (npm package name, Cordis plugin name, settings namespace, client module id, approval markers, snapshot headers, tool descriptions, error prefixes, MCP server name, CI workflow). Upstream attribution and the Apache-2.0 licence are preserved verbatim, and the upstream lineage (`dsh-memento`) is retained in the changelog history and in the export envelope's `plugin` field.
- Distribution pointers now target the new repository: `package.json` (`repository` / `homepage` / `bugs`), the five READMEs, `SECURITY.md`, the protocol schema `$id`, and the README-gate URL check. Upstream-only channels were removed from the READMEs (1024 ranking, Gitee mirror, upstream doctor badge, npm badges).
- The data plane was deliberately left unchanged for compatibility with existing stores: the default store directory `$DSH_HOME/dsh-memento/`, the `DSH_MEMENTO_DB_PATH` environment variable, and the `/api/memento/*` routes keep their original names.
- **Redesigned the `yammory-survey` skill** (still unreleased). The questionnaire is now framed as a supplement to background observation, with a budget note (questionnaire entries should stay under roughly a third of the profile). A round is now **at most 7 questions** ending in a stop-and-choose checkpoint (continue / pause / stop; no overall cap). Facets are picked "both ends first" (user-named > fast-changing > long-neglected > the rest); triggering was broadened (any mention of memory, profile or questionnaire); the question form is chosen per question and kept to one line; ambiguity is judged against a per-question 3–4 point list (≥70% covered passes, otherwise a single follow-up); the per-domain knowledge level is probed a notch above the recorded level; entries may run two to three sentences; re-asking follows half-life plus event triggers rather than a calendar; and survey-vs-observation conflicts resolve per facet (ability → observation, preference → self-report, intent-vs-behaviour → keep both). The question bank now annotates every question with its points.
- **`seed` now carries a single-source batch's `source` into the approval payload** (S4b). Without it the per-source granularity key had no footing for batched writes: `source:observation` could not be resolved, so a user who set `source:observation: off` (or `auto`) would silently get the global `writePolicy` instead. Mixed-source batches still omit it and fall back to `track/scope` and the global policy.
- **The warm-up block no longer emits an empty paragraph** when it has no constraint and no resident profile but does have proposals or a directory line to show.
- **v2 memory mechanism — F3 (drop the hard cap, keep a soft warning).** Writes are never refused by capacity any more: `checkBudget` now reports only whether a layer crosses its warning line; `MemoryProtocolCore` drops the budget assertion from every write path (`add` / `replace` / `consolidate` / `seed` no longer raise `BUDGET_EXCEEDED`). `Config.budgets` changes meaning from hard cap to soft warning line (values unchanged: user 2000 / agent 4000); the snapshot header, the panel and `/memory budgets` say "usage / warning line". `BUDGET_EXCEEDED` is kept in the protocol enum but is never emitted (backward compatible). Existing stores are untouched.
- **v2 memory mechanism — F4 (graded injection).** `renderWarmup`'s resident block (user × user-global) now has a soft line: entries are kept in creation order up to that layer's warning line, and the rest sink into the on-demand pool (counted in the one-line directory only). With no budgets passed, nothing is narrowed.
- The protocol conformance suite's `budget-model` group (C1/C2) follows suit: "over-budget refuses" becomes "crossing the warning line still writes". Protocol version stays v1 — the warning line is a deployment value, not a protocol semantic.
- **Read paths now speak only about entries that are in play (F6).** `store.listEntries()`, `queryEntries()`, `matchCandidates()` and `usage()` exclude `status='superseded'` rows: a demoted entry leaves every session's visible set at once (warm-up block, recall, query, write targeting, warning-line usage) while staying in the database, readable by id, for the audit trail and the S5 rollback. `allEntries()` is the management read that still sees everything (`/memory stats` counts the demoted rows there; `/memory export` deliberately keeps exporting the visible set only, since the export envelope has no `status` field and re-importing a demoted entry would bring it back as an active one).
- **Demotion leaves no text in the audit (F6).** Every `supersede` row records the entry id, the outcome and the session, with `text: null` — the same shape the session switch uses. The new entry that a merge produces keeps its normal `supersede-add` row (with text), and each batch closes with one `consolidation` summary row that doubles as the "last tidy" time anchor the backlog line reads.
- **A zero-hit recall is now visible in the audit (F7).** `recalled` rows carry `outcome: 'ok'` on a hit and `'empty'` on a miss, on both the `memory_recall` (retriever) and `query` (protocol) paths. Without it the recall hit rate could only ever see samples that succeeded — the misses would vanish from the denominator. Rows written before this change still read as hits, so an old audit window reports a slightly optimistic rate; `/memory stats` says so on its reading line.
- **The governance actions got their own source label (S5).** `restore` and `arbitrate` anchor `source: 'governance'` (`GOVERNANCE_SOURCE`), matching the `source:consolidation` shape F6 established: the per-source granularity key has a footing, so a user who wants "arbitration never asks me" can set `source:governance: auto` without loosening the global policy. The tool and command faces both pass their own label (`governance` / `command`); the protocol layer's default is `governance`.
- **Held the arbitration table to the seven facets at load time (S5).** `assertArbitrationTable()` runs at module load and throws if `ARBITRATION_BY_FACET` stops covering exactly `PROFILE_FACETS` or carries a direction outside `observation` / `self-report` / `coexist`. The "unknown facet is refused, never guessed" rule now has a backstop for the table itself drifting. The entry-status literals (`active` / `superseded`) moved into `lib/constants.mjs` as `ACTIVE_STATUS` / `SUPERSEDED_STATUS`, and `MAX_TAGS_PER_ENTRY` / `MAX_TAG_LENGTH` moved there too (still re-exported from `lib/protocol.mjs`), because `lib/store.mjs` now needs both and `store` may not import `protocol` (the protocol imports the store's shape).

### Fixed

- **Hid the panel routes behind the Connection trust fence (red team ①, medium-high).** The three `/api/memento/*` routes were registered as `webServer` exact routes. The webserver matches its `exact` table before its `prefix` table, so those routes answered *before* `client-connection`'s `/api` prefix route ever ran its `Host` / `Origin` / `Sec-Fetch-Site` fence and browser authentication — a request with hostile trust headers got a 200 and the whole store (cross-workspace, cross-agent, audit and proposals included). They now register through `ctx.connection.fetch.register`, so the fence applies and only the authenticated dispatch reaches the handler (same posture as `/api/other`, which already answered 401/403).
- **`STALE_WRITE` — optimistic lock on `replace` (red team ⑦).** The version shown in the approval payload is now pinned into the write; if the target changed while the write waited, it fails loud instead of silently overwriting the concurrent change. This deliberately supersedes the old P0-4 behaviour ("re-locate and continue"), which broke approve-what-you-see: the approver saw one text and a different one was overwritten. New error code + `docs/schemas/dsh-memory-protocol-v1.schema.json` enum entry + protocol tables (en/zh).
- **Input guards that used to fail silently or kill the store (red team ②③⑧⑨⑩).** `text` containing `U+0000` is refused before SQLite sees it (the column truncated silently: 511 chars in, 10 back, no error); `tags` elements must be non-empty, control-character-free strings (one dirty element used to poison the whole store with a permanent `STORE_CORRUPT`); `queryEntries` validates `track` / `scope` and throws `INVALID_INPUT` instead of leaking a raw SQLite error; `add(undefined)` and friends throw `INVALID_INPUT` instead of a bare `TypeError`; `extractHumanMessages` clamps a non-positive `maxChars` so `slice(0, -1)` can no longer emit an over-long slice.
- **Idempotent migration (red team ④).** `CREATE TABLE IF NOT EXISTS` plus per-column `PRAGMA table_info` guards, and a missing `schema_version` row self-heals by re-filling it rather than re-running the ladder from 0 and dying on "table already exists" (a permanent dead end).
- **`/memory import` no longer honours payload `workspaceKey` / `agentKey` (red team ⑤).** Imported entries fall back to the calling session's workspace and agent, so an import can no longer plant memory into another workspace (where it would enter that session's system prompt).
- **`write.gate` needs an internal registration (red team ⑥).** A caller-supplied `gate` can no longer override the approval transport; only gates created by the command path (`trustWriteGate`) are accepted — defence in depth.
- **`supersede` no longer leaks a shared entry into an agent bucket (red team ②, high).** The merged entry's `agentKey` / `workspaceKey` used to be taken from the writing session, so a preset-carrying session tidying **shared** entries silently moved that memory into its own agent bucket — one-way and invisible. The bucket now comes from `targets[0]` (`assertSameBucket` already guarantees one bucket); the session keys only decide what is visible. An explicit `input.agentKey` / `input.workspaceKey` still wins.
- **`arbitrate` re-checks its champion after the approval (red team ②, high).** `kept` was computed before the approver was asked; if the champion had been demoted in that window, the old code still returned `ok` and wrote a "kept X" audit row contradicting the store. The champion is now re-read through `entryById` and must still be `active` before anything lands: otherwise `INVALID_INPUT`, zero rows written, no summary row — the posture `supersede` already took. The returned entry is the store's current snapshot, not the pre-approval cache.
- **`enabled` must be a boolean on `/api/memento/session` (red team ②, medium).** The route accepted only `=== true`, so `"true"` (and `0`, `null`, `{}`) silently read as "off" and landed a switch row. A non-boolean now answers `400` without touching the store and without echoing a value.
- **The session-switch route pins the id to a real session (red team ②, medium; honestly partial).** Checked against the DSH sources first: a `connection.fetch` exact-route handler receives nothing but the `Request` (`createSharedFetchHandler` dispatches on path and hands it over), headers are written by the page and are therefore forgeable, and browser-auth is a *process*-level credential that does not distinguish sessions — **there is no server-verifiable session ownership**. The fallback tier is implemented: `sessionId` must be findable in `session-query`'s logical-session corpus (`400` otherwise, which stops "invent an id and switch it off"), and the audit row's `source` now reads `panel` (the command face stays `dsh-memento`). With no `sessionQuery` mounted the route allows the request — that is "nothing to check against", not "checked and passed". **A same-origin page A can still flip session B's switch**: defence in depth inside one origin, not a closed authorization boundary (ARCHITECTURE decision 22, spec 3.8).
- **`export → import` keeps `tags` / `facet` / `level` (red team ②, medium).** The export projection had dropped `facet` and `level`, and the import mapping rebuilt entries from `track` / `scope` / `text` / `source` alone — one round trip silently flattened every profile coordinate and every tag. Both sides now carry the three fields, validated through `normalize*` on import (an illegal value fails loud before anything lands, whole batch unwritten). Documents written by older versions import unchanged: a missing field means empty tags / no coordinate.
- **`facet` stays a normal writable field (red team ②, medium; logged, not blocked).** The arbitration table governs the *action* — `arbitrate` takes ids only and the direction comes from the table — and never governed field writability. Rewriting an entry's `facet` therefore takes an explicit `replace` + one approval + one audit row, and "reclassify an ability entry as a preference entry, then arbitrate" is a *reachable* path: an audited explicit one, not a silent privilege escalation. Blocking it would mean removing `facet` from `replace`'s inputs and giving the questionnaire and observation channels another way in; the trade-off is logged in ARCHITECTURE decision 20 and spec 3.7.

- **Doc/comment cleanup after the v2 cap drop.** The protocol document (`docs/protocol-v1.md` / `.zh.md`), the `lib/protocol.mjs` JSDoc, the `BudgetExceededError` comment, the `package.json` description and all five README taglines still described the removed hard cap (and `seed`'s "any entry over budget rejects the batch"). They now state the soft warning-line model. Protocol version stays v1.
- **`consolidate` gained the same optimistic lock as `replace`.** `store.consolidateEntries` accepts `expectedVersions` (the versions shown to the approver); a target that changed during the approval wait now fails with `STALE_WRITE` instead of silently merging the concurrent change.

### Tests

- 359/359 (`node --test "test/*.test.mjs"`): the 347 that shipped with the panel round, plus 12 in `test/redteam2.test.mjs` for the second red-team round — the shared-bucket merge staying shared (with a preset-carrying writer and without, plus the workspace layer inheriting its key), an explicit `agentKey` still winning, a champion demoted inside the approval window failing loud with zero rows written and no "kept" row, the same call succeeding when nobody interferes, `facet` rewriting as an explicit audited path that then decides the arbitration direction, the non-boolean `enabled` shapes answering 400 without touching the store, the session route pinning a known id (200) and refusing a ghost id (400) with `source: panel` on the audit row, a failing existence lookup answering 500 with zero rows written, the no-`sessionQuery` tier allowing the request, the export → import round trip preserving all three fields (legacy documents included), and illegal `tags` / `facet` / `level` values in an import document failing loud with zero rows written.
- 335/335 (`node --test "test/*.test.mjs"`): the 318 that shipped with F6/F7, plus 17 for S5 — `test/governance.test.mjs` (restore: the store batch with its version/updated-at invariants, the atomic rollback on an unknown or already-active id, the approval payload carrying the restored text, the `restore` audit rows, the refusal to walk the same entry back twice, the out-of-visible-set refusal, and the F5 interception ahead of the gate; arbitrate: ability keeps the observation and demotes the self-report, preference does the exact reverse, all five coexist faces demote nothing and tag both sides `gap`, the most-recently-updated entry wins inside a group, facet mismatch / missing facet / single-source / cross-bucket / duplicate ids all fail loud with zero rows written, the `arbitrate-denied` row, and the F5 interception; plus both tool actions, both commands with their usage errors, the closed-session refusals, and the schema declarations).
- 318/318 (`node --test "test/*.test.mjs"`) was the F6/F7 round: the 285 that shipped with F5 and the `memory_observe` schema fix, plus 33 — `test/consolidate.test.mjs` (8: heat selection with the recall-based union, `merged` and superseded skips, bucket keys including the workspace dimension, in-bucket pair hints with the per-bucket cap, the three backlog lines and the never-tidied case), `test/stats.test.mjs` (6: tokenize + Jaccard edges, repetition on empty / single / duplicated / truncated corpora, recall outcomes, injection parsing, and the `successRate: null` invariant), and `test/tidy.test.mjs` (19: `store.supersedeEntries` batch / atomic rollback / unknown, duplicate and already-demoted ids, the protocol `supersede` gate payload and `text: null` audit rows, the `consolidation` receipt, session-off interception ahead of the gate, cross-bucket and out-of-visible-set refusals, the 20-id and NUL caps, both new tool actions, `/memory tidy` and `/memory stats` output shapes including the missing-sessionId case, the `agent/turn-stopping` backlog notice with its throttle and its never-throw guarantee, the warm-up tail hint with its `snapshot` row, zero-hit `recalled` rows on both paths, and `GET /api/memento/stats`). The panel-route tests and the Loader composition / hot-reload fixture now expect five routes instead of four.
- 284/284 (`node --test "test/*.test.mjs"`) was the F5 round: the 273 tests that shipped with the red-team round, plus `test/session-switch.test.mjs` for F5 (store default/off/on and input guards, the v5 → v6 migration, all six protocol write methods refusing ahead of the gate with zero rows written, the warm-up section going empty and dropping its frozen cache without a new `snapshot` row, `memory_recall` / `memory.query` / `memory_observe` refusals, the selection filter with its `skippedOff` bill, the `/memory session` three states and their audit rows, and the `GET`/`POST /api/memento/session` route including its 400s). The red-team note stands: `test/redteam.test.mjs` (②③④⑥⑦⑧⑨⑩ + the `consolidate` lock) and a `/memory import` scope-injection case in `v2.test.mjs` (⑤); the panel-route tests and the Loader composition / hot-reload fixture run against a `connection.fetch` mock (`test/fixtures/mock-connection.mjs`).

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

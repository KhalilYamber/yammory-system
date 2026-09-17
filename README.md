<div align="center">

# yammory_system

**Your assistant stops asking you what it should already know.**

It remembers you across sessions — how deep you are in each subject, how you like to be spoken to, what you have already settled — and no write lands without your approval, so nothing about you is stored behind your back.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#compatibility)
[![CI](https://img.shields.io/github/actions/workflow/status/KhalilYamber/yammory-system/ci.yml?branch=main&label=CI)](https://github.com/KhalilYamber/yammory-system/actions)
[![Version](https://img.shields.io/github/v/tag/KhalilYamber/yammory-system?label=version)](https://github.com/KhalilYamber/yammory-system/releases)

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

<sub>Distribution: the GitHub channel only — there is no npm package and no marketplace listing.</sub>

</div>

---

## Why this exists

A capable assistant is still an assistant with amnesia. Every session it starts over: it does not know that you already understand eigenvectors but have never touched a tensor network, that you would rather be corrected than encouraged, or that you decided three weeks ago not to take that route. So you re-introduce yourself, again and again, and the conversation that could have started at the interesting part starts at zero.

`yammory_system` gives DeepSeek Harness a place to keep that knowledge, and a way to use it without guessing. Three things separate it from a memory warehouse:

- **It decides how to speak before it searches.** A seven-facet profile carries a per-domain knowledge level, so the assistant knows what vocabulary you can take before it answers — the injection happens at prompt assembly, not after a retrieval step.
- **Nothing is written without you.** Every write path is forced through DSH's own approval gate inside the service. A denied write leaves evidence too; a silent write is not a state this plugin can reach.
- **You can check its work.** Everything the model saw is logged, the store is a plain SQLite file you can browse, export and audit, and a whole category of mistakes is prevented by design rather than by discipline.

## Install

```sh
# 1. install the bundle into your profile
dsh plugin --profile web add "github:KhalilYamber/yammory-system#main"

# 2. restart, then verify the row
dsh --profile web --dump-config | grep -A3 'id: yammory_system'
```

Other channels and removal:

- **git channel** (latest `main`): `dsh plugin --profile web add git+https://github.com/KhalilYamber/yammory-system.git`.
- **tarball channel**: `npm pack` in this repo, then `dsh plugin --profile web add ./yammory_system-<version>.tgz`.
- **uninstall**: `dsh plugin --profile web remove yammory_system` (the memory database and session logs are kept).

## The first minute

After a restart you should see, without configuring anything:

| Where | What |
|---|---|
| Sidebar foot | A **memory** entry beside Settings (it toggles the drawer; hide it with `panel.enabled`) |
| Conversation header | A per-session memory switch — off stops injection, recall, writes and observation for that session |
| Sidebar foot → the entry | The drawer: entries by track and layer, search, warning-line usage, recent audit, the three observability numbers, and a **Tidy the whole library** button that only queues a marker |
| DSH settings → `yammory-system` | Every config field, each one with a question mark that explains it in plain words |
| `/memory` | `list`, `query`, `stats`, `audit`, `session on|off`, `export` / `import <path>`, and more |

## Table of contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [The first minute](#the-first-minute)
- [How it works](#how-it-works)
- [Capabilities](#capabilities)
- [Compatibility](#compatibility)
- [Configuration](#configuration)
- [Tools & surfaces](#tools--surfaces)
- [MCP server](#mcp-server)
- [Permissions & data](#permissions--data)
- [Security boundaries](#security-boundaries)
- [Known limitations](#known-limitations)
- [How it's different](#how-its-different)
- [dsh-memory-protocol v1](#dsh-memory-protocol-v1)
- [What we learned from the terminal memories](#what-we-learned-from-the-terminal-memories)
- [Development](#development)
- [Topics](#topics)
- [Contributors](#contributors)
- [Upstream](#upstream)

## How it works

`yammory_system` is a capability seam, not another memory warehouse: a typed `ctx.memory` service, a local SQLite provider (`node:sqlite`, WAL, `0600`, at `$DSH_HOME/dsh-memento/memory.db`), and its consumers — the `memory` tool and a frozen snapshot injected into the system prompt.

Two tracks × two layers × per-agent key: a `user` track (facts about the user) and an `agent` track (environment facts and conventions), each split into `user-global` and `workspace` layers, isolated per `agentPreset`. The snapshot is frozen once per session at first prompt assembly and never changes mid-session. The warm-up block carries the speaking constraints and the standing profile, and closes with a one-line directory (`N more workspace / agent-track entries stay out of this block`) so the model knows there is something to fetch with `memory_recall` — the count is one line, the content stays on demand.

## Capabilities

- **The approval gate cannot be bypassed.** Every write path (`add` / `replace` / `remove` / `seed`) is forced through the approval waterfall inside the service, not in the tool layer. `writePolicy: ask | auto | off` is model-invisible configuration; `replace` / `remove` / `consolidate` carry the full text of the entries they change in the approval payload, and a denied write still lands a `*-denied` audit row.
- **Model-visible ⟺ logged.** The injected snapshot lands verbatim in `system/message`; every write is reconstructable from `approval/asked` + `approval/decided` + the plugin's own audit table.
- **Bounded and honest.** Soft per-track/per-layer warning lines (default user 2000 / agent 4000). Crossing one never blocks a write — it only flags that the layer is worth consolidating. Never truncated, never auto-compacted.
- **Per-session switch.** Every session has its own memory switch (plugin-owned SQLite table, schema v6; default on). Off means injection stops (the frozen warm-up block is dropped at once), recall is refused (`SESSION_MEMORY_OFF`), writes are refused at the same layer as the approval gate, and the observation channel neither scans the session nor selects it as history. Management reads (`/memory list` / `budgets` / `audit` / `export`) stay available. Toggle with `/memory session on|off` or the header switch; the switch state itself never enters the session log, and its audit rows carry `text: null`.
- **Watch, and let the watching run itself.** The observation channel reads a bounded slice of your own past messages and writes behavioural entries the questionnaire cannot reach; a read-only check now flags it when the last observation is over a week old (one `observe-due` audit row plus a line at the end of the next warm-up block), and a weekly scheduled round can run it unattended in ONE workspace: a headless `dsh` session scans, infers at most three evidence-backed entries and commits them through the same approval gate, allowed by its own write-policy source (`source:observation`, `auto` / `ask` / `off`). No timer lives inside the plugin; the schedule is a Windows Task Scheduler entry, exactly as for the tidy round.
- **Tidy and measure.** A model-driven tidy pass merges entries that say the same thing into one `merged`-tagged entry and demotes the old ones to `superseded` — kept on disk, out of every session's view, never deleted. It never crosses buckets (`track × scope × agentKey`, plus `workspaceKey` on the workspace layer) and it never starts by itself. Whether a merge may be written without a human pass is decided by five mechanical hard gates (same bucket / member count / literal identity once punctuation, whitespace and symbols are stripped / similarity / coverage), never by the model's own confidence: only the tier whose members are identical after stripping punctuation, whitespace and symbols grades `auto` and may land unattended, while a fully paraphrased pair finishes below even the review line and simply grades `skip`, and a one-character change grades `review` and keeps the interactive route. A background round (a headless `dsh` session woken by your own scheduler) can therefore merge the mechanically unambiguous duplicates on its own, and leaves the rest waiting for you. The write pins its own audit source (`tidy-auto`), so a granular write policy (`source:tidy-auto`) can allow exactly that one path and keep every other write behind the approval gate. Separately, a read-only `agent/turn-stopping` check only flags that the backlog crossed the line (one `tidy-due` audit row plus a line at the end of the next warm-up block). `/memory stats` reports the three observability numbers (repetition rate, recall hit rate, injection volume) in the drawer too; the success rate is deliberately left blank, because this repo has no signal source for "did the injected block actually land". The panel's **Tidy the whole library** button is a queue, not an action: it writes one marker row (`tidy_requests`, schema v7) behind the same approval policy, the next session's warm-up asks the model to run a whole-library tidy, and the marker turns `done` when a tidy write lands — nothing is merged from the panel.
- **Govern the memory: roll a demotion back, arbitrate a conflict by facet.** `restore` walks a demotion the other way (`superseded → active`, `version` untouched, back into every session's view) and is the only route out of the demoted state. `arbitrate` settles the case where one fact carries two sources: it decides on **one facet**, and the direction comes from a fixed table — ability follows the observation, preference follows the self-report, and the other five facets keep **both** entries and tag each `gap` (the gap itself is the evidence). The table is the direction, so there is no reverse argument to pass, and inside a group the most recently updated entry is the one kept. Both actions ride the same approval gate, the same per-session switch and the same bucket rules as every other write, and both leave an audit trail: `restore` per entry, `arbitrate` per demotion (`text: null`, ids only), `arbitrate-tag` per tag, and one closing `arbitrate` summary naming who was kept, who was demoted and why.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `dsh-v0.1.5-rc.2` (adapted 2026-09-09): the session envelope keeps its ignorable field for stored-log read compatibility only - Session.append still cannot stamp it, so audit-gate behavior is unchanged. Verified 2026-09-11 against the dsh-v0.1.5-rc.2 master checkout (full gate chain + profile install smoke). |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows / macOS / Linux (pure host; no native code, no network) |
| Model | Any |

## Configuration

All tunables are Schemastery `Config` fields (changeable from cordis.yml). Invalid values fail loudly at load. Override under the `yammory_system` row.

**Settings panel.** When the DSH settings service is mounted, every field below (except `enabled`) is editable from the plugin's own **`yammory-system` entry in the DSH settings sidebar** (a top-level section, like General or Plugins); edits land in the settings user layer (`settings.yaml`) and need no file editing. Nearly everything applies live (write policies, language, budgets, limits, proposals, panel, `dbPath` / `auditRetentionDays` via a store reopen, `retrieval.vector` via a retriever swap) — only `snapshotOrder` needs a DSH reload. Without the settings service everything falls back to the composed cordis config, exactly as before. The sidebar memory entry can be hidden from the same page (`panel.enabled`).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` removes the service, tools, snapshot, command, panel, and answerer (not editable from the settings page — a disabled plugin has no settings entry) |
| `panel.enabled` | `true` | Show the memory entry at the sidebar foot; saving `false` from the settings page hides it immediately, no reload needed (the settings page itself stays reachable) |
| `dbPath` | `''` → `$DSH_HOME/dsh-memento/memory.db` | Absolute, or relative to `$DSH_HOME` (falls back to `~/.dsh` on Windows) |
| `budgets.user.userGlobal` | `2000` | Soft warning line for the user track's user-global layer |
| `budgets.user.workspace` | `2000` | Soft warning line for the user track's workspace layer |
| `budgets.agent.userGlobal` | `4000` | Soft warning line for the agent track's user-global layer |
| `budgets.agent.workspace` | `4000` | Soft warning line for the agent track's workspace layer |
| `writePolicy` | `'ask'` | Default write policy: `ask` / `auto` / `off` (model-invisible) |
| `writePolicies` | `{}` | Per-track/scope or per-source overrides (e.g. `user/workspace`, `source:claude`) |
| `language` | `'en'` | Model-visible and command output language: `en` / `zh` |
| `snapshotOrder` | `-50` | Snapshot section order (after harness identity, before persona) |
| `maxEntriesPerQuery` | `20` | Default per-query result cap (hard-capped at 1000) |
| `commandListLimit` | `50` | Entries rendered per `/memory list` / `query` |
| `commandAuditLimit` | `10` | Audit rows rendered per `/memory audit` |
| `recall.historyLimitDefault` | `8` | `memory_recall` sessions scanned by default |
| `recall.snippetCap` | `5` | `memory_recall` snippets per session |
| `recall.snippetChars` | `300` | `memory_recall` snippet characters |
| `recall.windowDays` | `30` | `memory_recall` recency window in days |
| `observe.days` | `14` | `memory_observe scan` window in days (hard-capped at 90) |
| `observe.sessions` | `8` | Recent sessions sampled per scan (hard-capped at 20) |
| `observe.perSession` | `12` | Messages sampled per session, spread evenly so the opening and the later corrections both survive (hard-capped at 20) |
| `observe.messageChars` | `400` | Per-message character cap before truncation with an ellipsis (hard-capped at 800) |
| `observe.totalChars` | `12000` | Character budget for the whole slice; the scan stops there and reports what it could not cover (hard-capped at 30000) |
| `recall.weighting.heat` | `0.3` | Heat bonus ceiling (multiplicative; `0` turns it off). Heat = recalls (saturating) × half-life decay since the last recall, so a memory has to keep being recalled to keep its heat |
| `recall.weighting.heatSaturation` | `10` | Recalls that saturate the heat bonus |
| `recall.weighting.heatHalfLifeDays` | `14` | Heat half-life in days (an entry not recalled for a while goes cold) |
| `recall.weighting.freshness` | `0.2` | Freshness bonus ceiling (multiplicative; `0` turns it off) |
| `recall.weighting.freshnessHalfLifeDays` | `30` | Freshness half-life in days |
| `recall.weighting.tagDiscount` | `0.5` | Weight a token scores when it matches only `tags` (a body match scores `1`) |
| `retrieval.vector` | `false` | Semantic recall switch: `true` swaps in vector recall **only when a genuinely semantic embedding provider is registered** — a hash/fake provider is deliberately not enough, since it models no meaning and would silently zero CJK recall. Otherwise the zero-dependency keyword retriever stays in place (CJK bigram tokenizing, any-token match, heat/freshness weighting, relevance ranking) |
| `panelEntriesLimit` | `200` | Web panel entries page size |
| `panelAuditLimit` | `20` | Web panel audit rows by default |
| `auditRetentionDays` | `0` | Audit retention (0 = keep forever) |
| `proposals.enabled` | `true` | Auto-capture a memory proposal after each successful compaction |
| `proposals.maxChars` | `2000` | Proposal character cap |
| `proposals.maxPending` | `8` | Pending proposal cap |

## Tools & surfaces

| Surface | Kind | Notes |
|---|---|---|
| `memory` | tool | add/replace/remove/consolidate/supersede/auto-tidy/restore/arbitrate/query/tidy with Save/Skip guidance; entries may carry profile coordinates (`facet` = one of the seven facets, `level` = per-domain knowledge level); `supersede` merges 1..20 entries into one `merged`-tagged entry and demotes the old ones to `superseded` (kept, never deleted), `restore` brings a demoted entry back, `arbitrate` settles a two-source conflict on one facet with a direction fixed by the arbitration table, `tidy` returns a read-only tidy plan; writes ride the approval gate |
| `memory_profile` | tool | Per-domain knowledge level over the 31-subdomain scale (`set` / `list` / `get`); `set` is approval-gated and audited, `tier` derives from `level` |
| `yammory-survey` | skill | User-initiated profile questionnaire covering the 24 questionnaire-legal sub-blocks; writes through `memory` + `memory_profile`. Source: `skills/yammory-survey/` |
| `memory_recall` | tool | Bounded memory matches (query tokenized: CJK bigrams, Latin words as-is; any token recalls, ranked by relevance) plus recent session-history matches |
| `memory_observe` | tool | Observation channel: `scan` reads a bounded slice of the user's OWN past messages (read-only, `cwd`-scoped, system-injected pseudo messages filtered out and counted, budget shortfall reported); `commit` writes 1..8 evidence-backed entries in one approval-gated atomic batch with `source: observation` |
| `yammory-observe` | skill | User-initiated behavioural observation writing the five observation-only faces (thinking style, character under difficulty, emotional patterns, self-image, decision style) through `memory_observe`. Source: `skills/yammory-observe/` |
| `yammory-tidy` | skill | User-initiated memory tidy: reads the read-only plan, merges what says the same thing, demotes the old entries (kept, never deleted), never crosses buckets. Source: `skills/yammory-tidy/`; judgement rules in `references/merge-rules.md` |
| `/memory` | command | `list` · `query` · `add` · `remove` · `consolidate` · `restore <id...>` · `arbitrate <id...>` · `tidy [--days=N]` · `stats` · `proposals` · `budgets` · `audit` · `export` · `import <path>` · `adapters` · `observe [--days=N]` · `session [on|off]` |
| session switch | session header | Per-session memory switch in the conversation header, right after the agent-preset label (`conversation.session.header.actions`, session scope): shows the current state and toggles it through `GET`/`POST /api/memento/session` (the route rides the same `connection.fetch` trust fence as the panel routes) |
| web panel | client drawer | Read-only for memory content: browse entries, search, budget bars, the three observability numbers, audit tail; one user-action button queues a whole-library tidy (marker only); the sidebar entry can be hidden (`panel.enabled`) |
| settings section | DSH settings sidebar → `yammory-system` | Edit every config field (except `enabled`) without touching files; live vs reload-required timing is marked on the page |

## MCP server

`yammory_system` ships a read-only stdio **MCP server** (`yammory_system-mcp`) so external MCP clients (Claude, Codex, …) can search the memory store without a harness. It speaks JSON-RPC 2.0 over newline-delimited JSON (NDJSON) — one JSON object per line, no `Content-Length` framing.

**Read-only.** The database is opened with `node:sqlite` `readOnly: true` (no migrations, no WAL writes, no recall-count bump); a missing database returns empty results instead of crashing.

| Tool | Purpose |
|---|---|
| `memory_search` | `{query, limit?}` → ranked entries (case-insensitive substring via the retrieval Provider seam) |
| `memory_stats` | `{}` → `{total, namespaces}` entry count + per-track/scope overview |

Run it directly:

```sh
node bin/mcp-server.mjs
# or, through the GitHub channel: npx -y -p github:KhalilYamber/yammory-system yammory_system-mcp
```

The database path is `$DSH_MEMENTO_DB_PATH` (absolute, or relative to `$DSH_HOME`); it defaults to `$DSH_HOME/dsh-memento/memory.db`.

Claude Desktop (`claude_desktop_config.json`) example:

```json
{
  "mcpServers": {
    "yammory_system": {
      "command": "npx",
      "args": ["-y", "-p", "github:KhalilYamber/yammory-system", "yammory_system-mcp"],
      "env": {
        "DSH_MEMENTO_DB_PATH": "/home/you/.dsh/dsh-memento/memory.db"
      }
    }
  }
}
```

`npx` resolves the package through the GitHub channel here (this repo is not on the npm registry), so the `-p github:…` spec is what fetches it.

The server is read-only: no network, no writes, no approval gate — search and stats only.

## Permissions & data

- **Permissions**: declares `harness:tool`, `filesystem:read`, `filesystem:write`, and `network:none` / `subprocess:none` / `shell:none` / `python:none` / `credentials:none` in its workshop manifest. Write approval rides the official approval seam.
- **Data**: local SQLite database (`0600`), zero network, zero credentials.
- **Session log**: audit completeness comes from the approval pair (`approval/asked` + `approval/decided`) plus the plugin's own audit table.

## Security boundaries

- **Public services only.** Consumes `tools`, `systemPrompt`, and the approval seam; no engine / agent-loop / apiproxy / official-UI changes.
- **Zero network, zero credentials.** Local database with POSIX file mode `0600`.
- **Fail loud.** Corrupt DB, newer schema, or invalid config fails at load; ambiguous substring matches fail with structured errors. Crossing a warning line never fails a write.
- **One process, one store.** Multiple sessions share the SQLite store; two processes sharing one `$DSH_HOME` write the same file (last-writer-wins under SQLite locking).

## Known limitations

- **Session events are declared, not yet emitted (rc.2).** `memory/added|updated|removed|recalled|snapshot` are merge-declared, but rc.2 has no registration surface for out-of-repo event types; emission turns on once a harness build registers them.
- **`ask` policy needs an answerer.** With no UI/ACP answerer composed, writes fail closed.
- **No FTS5 indexing.** Substring search runs on case-insensitive `instr` (correct for CJK).
- **Observation is a whitelist, and the whitelist has an edge.** `memory_observe scan` keeps only `user/message` events whose `source.kind` is `user` or `user-rpc`; measured on this machine, that drops 48% of all `user/message` events (runtime context, AGENTS.md, skill catalogs, goal rounds, subagent notices). It cannot, however, separate a human-typed message from an externally bridged one that also declares `kind: 'user'` — the kind is the only signal the log carries. Treat a single quoted line as weak evidence; require repetition across sessions.
- **The retrieval half called "semantic" is not semantic yet.** `retrieval.vector` engages only with a provider that declares itself semantic, and the only provider shipped here declares `false`, so today the switch falls back to keyword recall by design. Enabling real semantic recall needs an embedding source this repo has not chosen.

## How it's different

| Plugin | What it is | yammory_system's difference |
|---|---|---|
| dsh-mneme | self-evolving memory with a broad feature surface | small-corpus profile only: it competes by speaking at the user's measured level, not by widening features |
| dsh-meow-memory | seven-layer store with BM25 retrieval | no retrieval engineering: a per-domain level table plus facet arbitration |
| dsh-persona-memory | persona injection into the prompt | one layer deeper: a **per-domain knowledge level** and **facet arbitration** on top of the standing profile |
| dsh-memory-evolve | memory warehouse / evolution loops | a typed service seam, approval gate, and session-log audit; no warehouse ambition |
| dsh-mnemon | memory store helper | protocol + gate + audit, not another store |
| dsh-kb-sieve | knowledge-base sieving | no retrieval engineering: small-corpus substring search, cross-session recall via `session_search`/`sessionQuery` |
| dsh-tdai-memory | task-driven memory tooling | budgets are per track×layer and enforced in the service, not best-effort |
| claude-bridge | Claude Code bridging | DSH-native; a future `seed(source:'claude')` path lets a bridge feed the same store |
| dsh-external/Recall | external agent memory | local-first, zero-network, rides DSH's own approval seam |
| Official MCP memory examples | DSH's stated "memory = external MCP" position | the **native first-party** complement: same goal, no external server; both coexist |

The two differences that hold against today's field are the last pair in the table above: a **seven-facet profile carrying a per-domain knowledge level** (it decides how the assistant speaks, before any retrieval happens), and **facet arbitration** (it decides how a two-source conflict settles — ability follows observation, preference follows the self-report, the other five facets keep both and tag each `gap`).

The name is **`yammory_system`** (installed from the GitHub channel; not on the npm registry). Not `dsh-recall` (confusable with dsh-external/Recall), not the deleted legacy name `dsh-memory`.

## dsh-memory-protocol v1

`yammory_system` is the community rehearsal of the DSH memory protocol — a candidate shape for an official `ctx.memory` seam. The protocol normalizes this plugin's seam into a cross-plugin contract:

- **Entry spec** — two tracks × two layers × per-agent key, plus short `tags` (≤16 × ≤32 chars) and a per-entry `version` that increments on every `replace`.
- **Write semantics** — idempotent unique-substring conditional writes; approve-what-you-see payloads (`replace` / `remove` / `consolidate` carry the full text they change).
- **Audit contract** — every write reconstructable from `approval/asked` + `approval/decided` + the provider ledger.
- **Warning-line model** — soft per-layer warning lines / `AMBIGUOUS_MATCH` semantics.
- **Schema versioning** — migration rules with loud version checks.

- **Spec** — [docs/protocol-v1.md](docs/protocol-v1.md) (中文: [protocol-v1.zh.md](docs/protocol-v1.zh.md)); normative JSON Schema at [docs/schemas/dsh-memory-protocol-v1.schema.json](docs/schemas/dsh-memory-protocol-v1.schema.json).

**Adapter registry** — `ctx.memoryAdapters` (`register` / `list` / `adapt` / `export`) lets third-party memory plugins speak the protocol by registering a pure data converter (reversible `register()`; import rides the approval-gated `seed`, export is read-only). Onboarding: [docs/adapters-guide.md](docs/adapters-guide.md) (中文: [adapters-guide.zh.md](docs/adapters-guide.zh.md)).

| Built-in adapter | External format | Notes |
|---|---|---|
| `mem0` | mem0 fact collections (`{facts: [{memory, metadata?}]}`) | `metadata.category` / `metadata.tags` become tags; raw `messages` arrays are rejected — adapters convert, never extract |
| `hermes-memory-md` | Hermes `memory.md` (`## section` + bullets) | section names become tags; non-bullet prose fails loudly |
| `claude-code-memory-md` | `CLAUDE.md`-style markdown (headings, bullets, paragraphs) | bullets and paragraphs become entries; section names become tags |

**Conformance suite** — [test/protocol-conformance/](test/protocol-conformance/README.md): a distributable case set any provider claiming compatibility runs (`node test/protocol-conformance/run.mjs --provider ./your-factory.mjs`); this repo's CI runs it against its own provider as the golden reference (`npm run test:conformance`).

- **Upstream proposal** — [docs/upstream-proposal.md](docs/upstream-proposal.md) (中文: [upstream-proposal.zh.md](docs/upstream-proposal.zh.md)): why the official `ctx.memory` seam should adopt the protocol, the differences, and the migration path.

## What we learned from the terminal memories

`yammory_system` is not a port of Claude Code, Codex, or Hermes — but its design deliberately absorbed the parts each got right, and refused the parts that hurt:

| Terminal memory | What it got right | What yammory_system adopted |
|---|---|---|
| **Claude Code** — `CLAUDE.md` | hierarchical plain-text memory files (user-level → project-level), human-readable and human-editable, merged automatically into every session | plain-text entries; `user-global` / `workspace` layers merged per session; a store you can browse, `export`, and audit — transparency as a feature |
| **Codex** — `AGENTS.md` | per-directory scoped instructions auto-discovered and injected with zero model friction | the `workspace` layer keyed by the session cwd (Windows case-insensitive); the frozen snapshot injected automatically at session start |
| **Hermes** — `memory.md` | proactive memory saves and the security lesson that a gate enforced only in the tool layer is bypassable by late tool injection | the `memory` tool with Save/Skip guidance + approval-gated auto-capture proposals; the gate lives inside `ctx.memory`'s write methods, not in the tool layer |

Sources: [Claude Code memory](https://code.claude.com/docs/en/memory) · [Codex AGENTS.md](https://developers.openai.com/codex/cli/agents-md) · [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md) · [Hermes #48181](https://github.com/NousResearch/hermes-agent/issues/48181).

And the parts deliberately refused: hidden auto-summarization into model-private state (compaction summaries here become **pending proposals** that wait for a human approve/dismiss), warehouse/vector-store ambitions, and any write that lacks a human-visible approval or audit trail. Also adopted: Hermes's documented caveat that two processes sharing one home directory write the same memory file — see Security boundaries.

## Development

```sh
npm install              # node ^22.19 || >=24
npm test                 # node --test: 365 tests
npm run lint             # oxlint
npm run test:conformance # dsh-memory-protocol v1 conformance suite
npm run typecheck        # tsc --checkJs gate
npm run check:coverage   # line-coverage gate
npm run check:readmes    # five-language README consistency gate
npm run verify:self-contained # reject out-of-repo dependency specs
npm run verify:artifacts # artifact presence + syntax + import
```

`lib/` is zero-DSH-dependency (node: builtins only); DSH imports exist only in `index.mjs`.

## Topics

`dsh`, `dsh-plugin`, `deepseek-harness`, `memory`, `agent-memory`, `approval`, `audit`, `sqlite`, `cordis`, `llm`

## Contributors

- [@Niuniu-Sir](https://github.com/Niuniu-Sir) — the boot-crash report in [issue #1](https://github.com/PerryLink/dsh-memento/issues/1) that led to the `~/.dsh` fallback shipped in 0.3.1.

## Upstream

This project is a fork of [`dsh-memento`](https://github.com/PerryLink/dsh-memento), originally part of the [PerryLink DSH plugin family](https://github.com/PerryLink). Upstream attribution and the Apache-2.0 licence are preserved.

[Apache License 2.0](LICENSE) © 2026 dsh-memento contributors

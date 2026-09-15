// index.mjs — yammory_system 插件入口（唯一 host 面文件）。
//
// 三角色 seam：
// - Service Definition：ctx.memory（add/replace/remove/query/seed + budgets），
//   写方法内部强制走审批门（waterfall 审批接缝），模型无论经哪个工具/插件
//   间接调用服务都无法绕过（S3）。
// - Service Provider：lib/store.mjs 本地 SQLite（node:sqlite，零依赖，WAL）。
// - Consumer：memory 工具 + 冻结快照注入（systemPrompt 段，同步提供者）。
//
// 只消费公开服务：tools / systemPrompt / approval（inject 声明）。
// DSH 依赖只出现在本文件；lib/ 零 DSH 依赖。

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import { readFileSync } from 'node:fs'
import {
  TOOL_NAME,
  DEFAULT_SOURCE,
  SESSION_EVENTS,
  PANEL_AUDIT_CEILING,
  EXPORT_SCHEMA,
  MAX_IMPORT_ENTRIES,
  PROFILE_FACETS,
  KNOWLEDGE_DOMAINS,
  KNOWLEDGE_TIERS,
  OBSERVATION_FACE_VALUES,
  OBSERVATION_SOURCE,
  OBSERVE_LIMITS,
  MAX_SWITCH_SESSION_ID,
  GAP_TAG,
} from './lib/constants.mjs'
import { COMMAND_TEXT } from './lib/strings.mjs'
// CommandTextBundle 与 COMMAND_TEXT 同住 lib/strings.mjs（JSDoc typedef 随模块可见）。
/** @typedef {import('./lib/strings.mjs').CommandTextBundle} CommandTextBundle */
import {
  MemoryError,
  InvalidInputError,
  BudgetExceededError,
  EntryNotFoundError,
  AmbiguousMatchError,
  WriteDeniedError,
  NoAgentError,
  ProposalNotFoundError,
  StaleWriteError,
  AdapterNotFoundError,
  AdapterPayloadError,
  SessionQueryUnavailableError,
  SessionMemoryOffError,
} from './lib/errors.mjs'
import { validateBudgets, budgetReport, budgetLimits, checkBudget } from './lib/budget.mjs'
import { buildWriteReason, isMemoryWriteRequest, applyWritePolicy, normalizeWritePolicy, resolveWritePolicy, validateWritePolicies, parseWriteReason } from './lib/gate.mjs'
import { MemoryProtocolCore, PROTOCOL_ID, PROTOCOL_VERSION, PROTOCOL_URI, trustWriteGate, normalizeTags, normalizeFacet, normalizeLevel, validateMemoryEntry, validateExportEnvelope, validateAuditRow, MAX_TAGS_PER_ENTRY, MAX_TAG_LENGTH, PANEL_SOURCE } from './lib/protocol.mjs'
import { MemoryAdapterRegistry } from './lib/registry.mjs'
import { REFERENCE_ADAPTERS } from './lib/adapters.mjs'
import { renderSnapshot, renderWarmup, visibleEntries, visibleProposals } from './lib/snapshot.mjs'
import { openMemoryStore, resolveDbPath } from './lib/store.mjs'
import { workspaceKeyOf, agentKeyOf } from './lib/workspace.mjs'
import { extractEventText } from './lib/extract.mjs'
import { backlogOf, buildTidyPlan, TIDY_DEFAULTS } from './lib/consolidate.mjs'
import { AUDIT_WINDOW, buildStats } from './lib/stats.mjs'
import {
  buildObservationSlice,
  formatStamp,
  normalizeObservationEntries,
  resolveObserveOptions,
  sessionScope,
} from './lib/observe.mjs'
import { EmbeddingProviderRegistry, FakeEmbeddingProvider } from './lib/embedding.mjs'
import { RetrievalProviderRegistry, KeywordRetriever, SubstringRetriever, VectorRetriever, detectVectorBackend, RETRIEVAL_WEIGHTS } from './lib/retrieval.mjs'

/**
 * @typedef {import('./types.js').MemoryEntry} MemoryEntry
 * @typedef {import('./types.js').MemoryQueryResult} MemoryQueryResult
 * @typedef {import('./types.js').MemoryWriteContext} MemoryWriteContext
 * @typedef {import('./types.js').MemorySessionLike} MemorySessionLike
 * @typedef {{track: string, scope: string, used: number, limit: number}} MemoryUsage
 * @typedef {{id: string, kind: string, track: string, scope: string, workspaceKey: string, agentKey: string, text: string, source: string, sessionId: string | null, status: string, createdAt: number, decidedAt: number | null}} MemoryProposal
 * @typedef {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} BudgetsConfig
 * @typedef {object} StoreHandle - ctx.memory 依赖的 Provider 面。
 * @property {(filter?: {track?: string, scope?: string, text?: string, limit?: number}) => MemoryQueryResult} queryEntries
 * @property {() => MemoryEntry[]} listEntries
 * @property {(ids: string[]) => void} bumpRecall
 * @property {(track: string, scope: string, match: string, opts?: {agentKey?: string, workspaceKey?: string}) => MemoryEntry[]} matchCandidates
 * @property {(track: string, scope: string) => number} usage
 * @property {(input: object) => MemoryEntry} insertEntry
 * @property {(inputs: object[]) => MemoryEntry[]} seedEntries
 * @property {(input: object) => {previous: MemoryEntry, entry: MemoryEntry}} replaceEntry
 * @property {(input: object) => MemoryEntry} removeEntry
 * @property {(input: object) => {removed: MemoryEntry[], entry: MemoryEntry}} consolidateEntries
 * @property {(input: object) => {superseded: MemoryEntry[], entry: MemoryEntry | null}} supersedeEntries
 * @property {(input: {ids: string[]}) => MemoryEntry[]} restoreEntries
 * @property {(input: {ids: string[], tag: string}) => MemoryEntry[]} tagEntries
 * @property {(id: string) => MemoryEntry | null} entryById
 * @property {() => MemoryEntry[]} allEntries
 * @property {(row: object) => object} auditAppend
 * @property {(limit?: number) => object[]} auditList
 * @property {(input: object) => object | null} proposalUpsert
 * @property {(status?: string, limit?: number) => object[]} proposalList
 * @property {(id: string, status: string) => object} proposalDecide
 * @property {(input: {domain: string, level: number, tier?: string}) => ProfileRowValue} profileUpsert
 * @property {(domain: string) => ProfileRowValue | null} profileGet
 * @property {() => ProfileRowValue[]} profileList
 * @property {(sessionId: unknown) => boolean} sessionEnabled
 * @property {(sessionId: unknown, enabled: unknown) => boolean} sessionSetEnabled
 * @property {() => string[]} disabledSessionIds
 * @property {() => {id: string, createdAt: number, status: string} | null} tidyRequestPending
 * @property {() => {request: {id: string, createdAt: number, status: string}, created: boolean}} tidyRequestAdd
 * @property {() => {id: string, createdAt: number, status: string} | null} tidyRequestClear
 * @property {(limit?: number) => Array<{id: string, createdAt: number, status: string}>} tidyRequestList
 * @property {() => void} close
 * @typedef {{request: (req: object) => Promise<string>, overrideOf?: (session: unknown) => string | undefined, config?: {policy?: string}}} ApprovalLike
 * @typedef {object} ServiceDeps
 * @property {StoreHandle} store
 * @property {BudgetsConfig} budgets
 * @property {string} writePolicy
 * @property {number} maxEntriesPerQuery
 * @property {number} commandListLimit
 * @property {number} commandAuditLimit
 * @property {'en'|'zh'} language
 * @property {ApprovalLike} approval
 * @property {string} [sourceLabel]
 * @typedef {object} PluginConfig - apply 的宽松配置形状（cordis loader 已套 schema 默认值）。
 * @property {boolean} [enabled]
 * @property {string} [dbPath]
 * @property {{user?: {userGlobal?: number, workspace?: number}, agent?: {userGlobal?: number, workspace?: number}}} [budgets]
 * @property {string} [writePolicy]
 * @property {Record<string, string>} [writePolicies]
 * @property {'en'|'zh'} [language]
 * @property {number} [snapshotOrder]
 * @property {number} [maxEntriesPerQuery]
 * @property {number} [commandListLimit]
 * @property {number} [commandAuditLimit]
 * @property {{historyLimitDefault?: number, snippetCap?: number, snippetChars?: number, windowDays?: number, weighting?: {heat?: number, heatSaturation?: number, heatHalfLifeDays?: number, freshness?: number, freshnessHalfLifeDays?: number, tagDiscount?: number}}} [recall]
 * @property {{days?: number, sessions?: number, perSession?: number, messageChars?: number, totalChars?: number}} [observe]
 * @property {{vector?: boolean}} [retrieval]
 * @property {number} [panelEntriesLimit]
 * @property {number} [panelAuditLimit]
 * @property {number} [auditRetentionDays]
 * @property {{enabled?: boolean, maxChars?: number, maxPending?: number}} [proposals]
 * @property {{enabled?: boolean}} [panel]
 * @typedef {{action: string, track: string, scope: string, text: string, count?: number, source?: string}} WritePayload
 * @typedef {{agent?: {session?: MemorySessionLike | null} | null, callId?: unknown, signal?: AbortSignal}} AskWrite
 * @typedef {{track: string, scope: string, text: string, facet?: string, level?: number}} PublicEntry
 * @typedef {object} MemoryToolValue - memory 工具规范结果形状。
 * @property {boolean} ok
 * @property {string} action
 * @property {{message: string}} [error]
 * @property {PublicEntry[]} [entries]
 * @property {boolean} [truncated]
 * @property {number} [total]
 * @property {PublicEntry} [entry]
 * @property {Array<{id: string, text: string}>} [removed]
 * @property {Array<{id: string, text: string}>} [superseded]
 * @property {Array<{id: string, text: string}>} [restored]
 * @property {{id: string, text: string, source: string}[]} [kept]
 * @property {Array<{id: string, text: string}>} [demoted]
 * @property {Array<{id: string, text: string, tags: string[]}>} [tagged]
 * @property {string} [facet]
 * @property {string} [direction]
 * @property {string} [plan]
 * @property {number} [candidates]
 * @property {{count: number, chars: number, due: boolean, reason?: string}} [backlog]
 * @property {{used: number, limit: number}} [usage]
 * @typedef {{domain: string, level: number, tier: string, updatedAt: number}} ProfileRowValue
 * @typedef {object} MemoryProfileToolValue - memory_profile 工具规范结果形状。
 * @property {boolean} ok
 * @property {string} action
 * @property {{message: string}} [error]
 * @property {boolean} [found]
 * @property {ProfileRowValue} [profile]
 * @property {ProfileRowValue | null} [previous]
 * @property {ProfileRowValue[]} [profiles]
 * @property {number} [total]
 * @typedef {object} RecallToolValue - memory_recall 工具规范结果形状。
 * @property {{total: number, entries: PublicEntry[], truncated: boolean}} memory
 * @property {{available: boolean, error?: string, sessions: Array<{sessionId: string, matches: number, snippets: string[]}>}} history
 * @typedef {object} PanelResponse - node:http 响应最小面。
 * @property {(status: number, headers?: object) => unknown} writeHead
 * @property {(body: string) => unknown} end
 */

export const name = 'yammory_system'

export const inject = ['tools', 'systemPrompt', 'approval']

/** 默认预警线：user 轨 2000 字符/层，agent 轨 4000 字符/层（沿用旧「硬上限」值；写入不再因越线被拒）。 */
export const DEFAULT_BUDGETS = Object.freeze({
  user: Object.freeze({ userGlobal: 2000, workspace: 2000 }),
  agent: Object.freeze({ userGlobal: 4000, workspace: 4000 }),
})

/** 快照段注入顺序：harness identity(-100) 之后、persona(0) 之前（负数=靠前）。 */
export const DEFAULT_SNAPSHOT_ORDER = -50

/**
 * 观察通道默认值（方案 2.2 的保守起点；S4b-0 实测：本项目工作区 14 天内真人发言
 * 共 18 条，12k 字符是天花板而非瓶颈，真正的约束是会话数 × 每会话条数）。
 * 硬上限在 lib/constants.mjs 的 OBSERVE_LIMITS——模型入参在 Provider 层被夹住。
 */
export const DEFAULT_OBSERVE = Object.freeze({
  days: 14,
  sessions: 8,
  perSession: 12,
  messageChars: 400,
  totalChars: 12000,
})

/**
 * 查「上次整理」时回看的审计行数：整理收尾固定落一行 `action='consolidation'`，
 * 在窗口内找不到就按「从没整理过」处理（开工线的字符/条数两条仍然生效，只是没有
 * 12 小时兜底那一路——绝不为了凑一个数去猜）。
 */
export const TIDY_AUDIT_WINDOW = 200

/** 同进程内两次「该整理了」审计提示的最小间隔（turn-stopping 每轮都会检查一次）。 */
export const TIDY_NOTICE_INTERVAL = 3600000

/** F6 整理机的开工线（规格 3.5.1 的三个可调默认，出处单一：lib/consolidate.mjs）。 */
export const TIDY_LINES = TIDY_DEFAULTS

/**
 * F6/F7 的命令面、提示行与工具渲染文案（en/zh）。
 * 方案 §3 的施工分解未点名 `lib/strings.mjs`，故按禁区纪律内联在本文件；命令动词
 * 两种语言同形，`usage` 只在既有 COMMAND_TEXT 文本后追加动词表，不动那份词表。
 */
const TIDY_TEXT = {
  en: {
    verbs: ' | tidy [--days=N] | stats',
    tidyHeader: 'Tidy plan (read-only: this command writes nothing; the semantic call belongs to the model):',
    tidyUsage: 'tidy usage: /memory tidy [--days=N] — read-only plan (backlog + per-bucket candidates + similar pairs). Writes go through the model: memory action=supersede.',
    tidied: (/** @type {number} */ n, /** @type {string} */ text) => `Tidied (${n} superseded, 1 merged entry tagged \`merged\`): ${text}`,
    backlogLine: (/** @type {{count: number, chars: number, hours: number | null, due: boolean, reason: string | null}} */ b) =>
      `Backlog since the last consolidation: ${b.count} entr${b.count === 1 ? 'y' : 'ies'} / ${b.chars} chars`
      + ` (work line ${TIDY_LINES.charsLine} chars or ${TIDY_LINES.entriesLine} entries; last consolidation ${b.hours === null ? 'never recorded' : `${b.hours}h ago`})`
      + ` — ${b.due ? `over the line (${b.reason})` : 'below the line'}`,
    candidatesLine: (/** @type {number} */ n, /** @type {number} */ days, /** @type {number} */ merged, /** @type {number} */ superseded) =>
      `Candidates: ${n} (heat window ${days}d; skipped ${merged} already-merged, ${superseded} superseded)`,
    bucketLine: (/** @type {string} */ key, /** @type {number} */ n, /** @type {number} */ batches) => `Bucket ${key} — ${n} candidate(s), ${batches} write batch(es) of <=20`,
    candidateLine: (/** @type {{id: string, text: string, recallCount: number}} */ row) => `  - [${row.id}] ${row.text} (recalled x${row.recallCount})`,
    pairLine: (/** @type {{aId: string, bId: string, similarity: number}} */ pair) => `  ~ possibly the same thing: ${pair.aId} <-> ${pair.bId} (similarity ${pair.similarity})`,
    tidyEmpty: 'No candidates: everything is either outside the heat window or already merged.',
    tidyHint: 'Next: say "tidy my memory" so the model decides which entries say the same thing (memory tool action=supersede: the merge carries the `merged` tag, the old entries are superseded with a trace, never deleted). Buckets are never crossed.',
    supersedeSummary: (/** @type {number} */ n, /** @type {string} */ text) => `Tidied: ${n} entr${n === 1 ? 'y' : 'ies'} superseded (kept, marked superseded), 1 merged entry added with the \`merged\` tag: ${text}`,
    supersedeDemoted: (/** @type {number} */ n) => `Tidied: ${n} entr${n === 1 ? 'y' : 'ies'} superseded (kept on disk, out of every session's view; rollback is S5's job).`,
    statsHeader: 'Observability — the three numbers (read-only, no model, no audit rows):',
    statsRepetition: (/** @type {{ratio: number | null, pairs: number, comparablePairs: number, entries: number, threshold: number, truncated: boolean, superseded: number}} */ r) =>
      `(1) Repetition rate: ${r.ratio === null ? 'n/a (no comparable pairs)' : `${(r.ratio * 100).toFixed(2)}%`}`
      + ` — ${r.pairs} of ${r.comparablePairs} comparable pairs score >= ${r.threshold}`
      + ` (${r.entries} active entr${r.entries === 1 ? 'y' : 'ies'}${r.truncated ? ', capped' : ''}; ${r.superseded} superseded)`,
    statsRecall: (/** @type {{rate: number | null, hits: number, total: number, empty: number, unknown: number}} */ r, /** @type {number} */ window) =>
      `(2) Recall hit rate: ${r.rate === null ? 'n/a (no recalls recorded)' : `${(r.rate * 100).toFixed(2)}%`}`
      + ` — ${r.hits} hit(s) / ${r.total} recall(s) (${r.empty} zero-hit, ${r.unknown} unlabelled; audit window ${window} rows)`,
    statsInjection: (/** @type {{lastChars: number | null, lastEntries: number | null, samples: number, avgChars: number | null, avgEntries: number | null}} */ i) =>
      i.samples === 0
        ? '(3) Injection: no snapshot audit rows yet (the warm-up block has not been rendered).'
        : `(3) Injection: last warm-up block ${i.lastChars} chars / ~${i.lastEntries} entry lines (${i.samples} snapshot(s): avg ${i.avgChars} chars / ~${i.avgEntries} lines)`,
    statsSuccess: 'Success rate: needs a feedback channel, not defined yet — this line deliberately reports nothing else.',
    statsReading: 'Reading: lower repetition is better; a high recall hit rate means on-demand fetch is earning its keep; injection is the fixed per-session cost. Recall rows written before F7 recorded zero-hit queries as "ok", so an old window reads slightly high.',
  },
  zh: {
    verbs: ' | tidy [--days=N] | stats',
    tidyHeader: '整理计划（只读：本命令不写库，语义判断归模型）：',
    tidyUsage: 'tidy 用法：/memory tidy [--days=N]——只读计划（积压 ＋ 分桶候选 ＋ 桶内相似线索）。落写由模型经 memory 工具 action=supersede 完成。',
    tidied: (/** @type {number} */ n, /** @type {string} */ text) => `已整理（降级 ${n} 条，新增 1 条带 \`merged\` 标）：${text}`,
    backlogLine: (/** @type {{count: number, chars: number, hours: number | null, due: boolean, reason: string | null}} */ b) =>
      `积压：自上次整理以来 ${b.count} 条 / ${b.chars} 字符`
      + `（开工线 ${TIDY_LINES.charsLine} 字符或 ${TIDY_LINES.entriesLine} 条；上次整理 ${b.hours === null ? '无记录' : `${b.hours} 小时前`}）`
      + `——${b.due ? `已过线（${b.reason}）` : '未过线'}`,
    candidatesLine: (/** @type {number} */ n, /** @type {number} */ days, /** @type {number} */ merged, /** @type {number} */ superseded) =>
      `候选 ${n} 条（热度窗口 ${days} 天；跳过：已整理 ${merged} 条、已降级 ${superseded} 条）`,
    bucketLine: (/** @type {string} */ key, /** @type {number} */ n, /** @type {number} */ batches) => `桶 ${key}——${n} 条候选，落写建议 ${batches} 批（每批 ≤20）`,
    candidateLine: (/** @type {{id: string, text: string, recallCount: number}} */ row) => `  - [${row.id}] ${row.text}（召回 ×${row.recallCount}）`,
    pairLine: (/** @type {{aId: string, bId: string, similarity: number}} */ pair) => `  ~ 可能同一件事：${pair.aId} ↔ ${pair.bId}（相似度 ${pair.similarity}）`,
    tidyEmpty: '没有候选：要么都在热度窗口外，要么都已整理过。',
    tidyHint: '下一步：说「整理一下记忆」，让模型判哪几条在讲同一件事（memory 工具 action=supersede：合并产出自带 `merged` 标，旧条目降级留痕、绝不物理删）。桶内不跨。',
    supersedeSummary: (/** @type {number} */ n, /** @type {string} */ text) => `已整理：降级 ${n} 条（留痕），新增 1 条带 \`merged\` 标的合并条目：${text}`,
    supersedeDemoted: (/** @type {number} */ n) => `已整理：降级 ${n} 条（仍在库里，但不进任何会话的可见集；回滚归 S5）。`,
    statsHeader: '可观测三数（只读、零模型、不落审计）：',
    statsRepetition: (/** @type {{ratio: number | null, pairs: number, comparablePairs: number, entries: number, threshold: number, truncated: boolean, superseded: number}} */ r) =>
      `① 重复率：${r.ratio === null ? '无样本（没有可比对的两条）' : `${(r.ratio * 100).toFixed(2)}%`}`
      + `——${r.comparablePairs} 个可比对中 ${r.pairs} 对 ≥ ${r.threshold}`
      + `（在场 ${r.entries} 条${r.truncated ? '，已截断' : ''}；已降级 ${r.superseded} 条）`,
    statsRecall: (/** @type {{rate: number | null, hits: number, total: number, empty: number, unknown: number}} */ r, /** @type {number} */ window) =>
      `② 召回命中率：${r.rate === null ? '无样本（窗口内没有召回记录）' : `${(r.rate * 100).toFixed(2)}%`}`
      + `——${r.total} 次召回里 ${r.hits} 次有命中（零命中 ${r.empty} 次、旧格式 ${r.unknown} 行；审计窗口 ${window} 行）`,
    statsInjection: (/** @type {{lastChars: number | null, lastEntries: number | null, samples: number, avgChars: number | null, avgEntries: number | null}} */ i) =>
      i.samples === 0
        ? '③ 注入量：还没有 snapshot 审计行（预热段尚未渲染过）。'
        : `③ 注入量：最近一次预热段 ${i.lastChars} 字符 / 约 ${i.lastEntries} 条（${i.samples} 次快照：均 ${i.avgChars} 字符 / 约 ${i.avgEntries} 条）`,
    statsSuccess: '成功率：需反馈通道，待定义——本行刻意不报别的数。',
    statsReading: '解读：重复率越低越好；命中率高说明按需取真派上了用场；注入量是每次会话的固定开销。F7 之前的召回行把零命中也记成 ok，所以旧窗口的命中率会偏高一点。',
  },
}

/** 预热段末行的整理提示（过开工线时才追加；只报数与动作，不搬正文）。 */
export const WARMUP_TIDY_HINT = {
  en: (/** @type {{count: number, chars: number}} */ b) => `Memory is due for a tidy: ${b.count} entr${b.count === 1 ? 'y' : 'ies'} / ${b.chars} chars changed since the last consolidation. Say "tidy my memory" and the model will merge what says the same thing (old entries are superseded, never deleted); /memory tidy prints the plan.`,
  zh: (/** @type {{count: number, chars: number}} */ b) => `记忆该整理了：自上次整理以来 ${b.count} 条 / ${b.chars} 字符。说「整理一下记忆」，模型会把讲同一件事的合并（旧条目降级留痕，不物理删）；/memory tidy 可先看计划。`,
}

/**
 * 预热段末行的「用户点过全库整理」提示（收边 §2）：面板按钮登记的待整理标记存在时
 * 追加一句，请模型在本会话跑一次全库 tidy。它只提示，绝不自动跑——整理必须由模型在
 * 会话内显式落写（审计红线），跑完 supersede 会清掉标记、下一会话这里就不再出现。
 */
export const WARMUP_TIDY_REQUEST = {
  en: 'The user asked for a whole-library tidy from the panel. Run one memory tidy over the whole library now: read the plan (`memory action=tidy`, or `/memory tidy`) and then merge what says the same thing with `memory action=supersede`. This is a queued request, not an automatic pass — the entry-merge judgement is yours.',
  zh: '用户点过全库整理，请跑一次 memory tidy（全库）：先看计划（`memory action=tidy` 或 `/memory tidy`），再用 `memory action=supersede` 把讲同一件事的合并。这是排队式请求，不会自动执行——哪几条讲同一件事由您判断。',
}

/**
 * 取上次整理时间（audit 行按 seq 倒序）：整理收尾固定落 `action='consolidation'`，
 * 窗口内没有就返回 0（= 从没整理过）。
 * @param {Array<{action?: string, ts?: number}>} auditRows - 审计行。
 * @returns {number} 上次整理时间戳；无记录为 0。
 */
function lastTidyTs(auditRows) {
  for (const row of auditRows) {
    if (row.action === 'consolidation' && typeof row.ts === 'number') return row.ts
  }
  return 0
}

/**
 * 只读算一次积压（turn-stopping 与预热段提示共用）：O(n) 读，不写库、不落审计。
 * @param {StoreHandle} store - Provider。
 * @param {number} [now] - 当前时间（测试注入）。
 * @returns {ReturnType<typeof backlogOf>} 积压账目。
 */
function readTidyBacklog(store, now = Date.now()) {
  const since = lastTidyTs(store.auditList(TIDY_AUDIT_WINDOW))
  return backlogOf(/** @type {Array<{text: string, status?: string, createdAt: number, updatedAt: number}>} */ (store.listEntries()), { since, now })
}

/**
 * 渲染整理计划的文本行（`/memory tidy` 与 memory 工具 action=tidy 共用同一份）。
 * @param {ReturnType<typeof buildTidyPlan>} plan - 计划。
 * @param {'en'|'zh'} language - 语言。
 * @returns {string[]} 文本行。
 */
function tidyPlanLines(plan, language) {
  const text = TIDY_TEXT[language] ?? TIDY_TEXT.en
  const lines = [text.tidyHeader, text.backlogLine(plan.backlog)]
  if (plan.candidates === 0) {
    lines.push(text.tidyEmpty)
    return lines
  }
  lines.push(text.candidatesLine(plan.candidates, plan.windowDays, plan.skippedMerged, plan.skippedSuperseded))
  for (const bucket of plan.buckets) {
    lines.push(text.bucketLine(bucket.key, bucket.candidates.length, bucket.batchHint))
    for (const row of bucket.candidates) lines.push(text.candidateLine(row))
    for (const pair of bucket.pairs) lines.push(text.pairLine(pair))
  }
  lines.push(text.tidyHint)
  return lines
}

/**
 * 渲染三数报告（`/memory stats` 与面板 stats 路由共用）。
 * @param {ReturnType<typeof buildStats>} stats - 三数报告。
 * @param {'en'|'zh'} language - 语言。
 * @returns {string[]} 文本行。
 */
function statsLines(stats, language) {
  const text = TIDY_TEXT[language] ?? TIDY_TEXT.en
  return [
    text.statsHeader,
    text.statsRepetition({ ...stats.repetition, superseded: stats.superseded }),
    ...stats.repetition.top.map((pair) => `    ${pair.a} ~ ${pair.b} (${pair.similarity})`),
    text.statsRecall(stats.recall, stats.auditWindow),
    text.statsInjection(stats.injection),
    text.statsSuccess,
    text.statsReading,
  ]
}

/**
 * 插件配置（Schemastery）。Config 是 cordis 组合面（含 enabled 整体开关）；
 * SettingsSchema 是宿主设置面板的用户面（yammory-system namespace，无 enabled——
 * false 时插件整体卸载、namespace 随之消失，从设置页开不回来）。两者共享同一组
 * 字段 schema（SHARED_CONFIG_FIELDS），面板改的是 settings.yaml 用户层。
 * @typedef {object} Config
 * @property {boolean} [enabled] 整体开关；false 时工具/注入/服务/审批 answerer 全部消失。
 * @property {string} [dbPath] 记忆库路径；空 = $DSH_HOME/dsh-memento/memory.db（变更时重开 store，即时生效）。
 * @property {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} [budgets]
 *   每轨每层软预警线（热生效；越线只提示、不拦写）。
 * @property {'ask'|'auto'|'off'} [writePolicy] 写审批策略；模型不可见、不可改（热生效）。
 * @property {Record<string, 'ask'|'auto'|'off'>} [writePolicies] 粒度写策略（键 `track/scope` 或 `source:<name>`；未命中回退 writePolicy；热生效）。
 * @property {'en'|'zh'} [language] 模型可见文案与命令输出语言（默认 en；命令/快照/面板热生效，工具描述注册期固定）。
 * @property {number} [snapshotOrder] 快照段注入顺序（默认 -50，靠前负值；重载 DSH 后生效）。
 * @property {number} [maxEntriesPerQuery] query 默认返回条目上限（显式 limit 可超出，Provider 硬钳 1000；热生效）。
 * @property {number} [commandListLimit] /memory list|query 单次渲染条目上限（默认 50；热生效）。
 * @property {number} [commandAuditLimit] /memory audit 单次渲染审计行上限（默认 10；热生效）。
 * @property {{historyLimitDefault?: number, snippetCap?: number, snippetChars?: number, windowDays?: number, weighting?: {heat?: number, heatSaturation?: number, heatHalfLifeDays?: number, freshness?: number, freshnessHalfLifeDays?: number, tagDiscount?: number}}} [recall]
 *   memory_recall 历史段默认值（默认 8/5/300/30；热生效）。`weighting` 为检索加权表（规格 3.3·层 B，默认见 `RETRIEVAL_WEIGHTS`；热生效）。
 * @property {{days?: number, sessions?: number, perSession?: number, messageChars?: number, totalChars?: number}} [observe]
 *   memory_observe scan 的默认窗口与预算（模型入参在 Provider 层夹到 OBSERVE_LIMITS；热生效）。
 * @property {{vector?: boolean}} [retrieval] 语义召回开关（默认 false：keyword 主路径；变更时拆旧装新检索器，即时生效）。
 * @property {number} [panelEntriesLimit] 面板条目页上限与钳制（默认 200；热生效）。
 * @property {number} [panelAuditLimit] 面板审计默认条数（默认 20；上限 200 为协议常量；热生效）。
 * @property {number} [auditRetentionDays] 审计保留天数（默认 0 = 不限；变更时随 dbPath 重开 store，即时生效）。
 * @property {{enabled?: boolean, maxChars?: number, maxPending?: number}} [proposals]
 *   auto-capture 压缩记忆提案（默认 true / 2000 / 8；热生效）。
 * @property {{enabled?: boolean}} [panel] Web 面板入口（侧栏底部那枚「记忆」；热生效；false 时入口消失，仅记忆面板，设置卡片不受影响）。
 */
const SHARED_CONFIG_FIELDS = {
  dbPath: Schema.string().default(''),
  budgets: Schema.object({
    user: Schema.object({
      userGlobal: Schema.number().default(DEFAULT_BUDGETS.user.userGlobal),
      workspace: Schema.number().default(DEFAULT_BUDGETS.user.workspace),
    }),
    agent: Schema.object({
      userGlobal: Schema.number().default(DEFAULT_BUDGETS.agent.userGlobal),
      workspace: Schema.number().default(DEFAULT_BUDGETS.agent.workspace),
    }),
  }),
  writePolicy: Schema.union(['ask', 'auto', 'off']).default('ask'),
  writePolicies: Schema.dict(Schema.union(['ask', 'auto', 'off'])).default({}),
  language: Schema.union(['en', 'zh']).default('en'),
  snapshotOrder: Schema.number().default(DEFAULT_SNAPSHOT_ORDER),
  maxEntriesPerQuery: Schema.number().default(20),
  commandListLimit: Schema.number().default(50),
  commandAuditLimit: Schema.number().default(10),
  recall: Schema.object({
    historyLimitDefault: Schema.number().default(8),
    snippetCap: Schema.number().default(5),
    snippetChars: Schema.number().default(300),
    windowDays: Schema.number().default(30),
    // 检索加权（规格 3.3·层 B）：默认即 RETRIEVAL_WEIGHTS，设置页可改、热生效。
    weighting: Schema.object({
      heat: Schema.number().default(RETRIEVAL_WEIGHTS.heat),
      heatSaturation: Schema.number().default(RETRIEVAL_WEIGHTS.heatSaturation),
      heatHalfLifeDays: Schema.number().default(RETRIEVAL_WEIGHTS.heatHalfLifeDays),
      freshness: Schema.number().default(RETRIEVAL_WEIGHTS.freshness),
      freshnessHalfLifeDays: Schema.number().default(RETRIEVAL_WEIGHTS.freshnessHalfLifeDays),
      tagDiscount: Schema.number().default(RETRIEVAL_WEIGHTS.tagDiscount),
    }),
  }),
  observe: Schema.object({
    days: Schema.number().default(DEFAULT_OBSERVE.days),
    sessions: Schema.number().default(DEFAULT_OBSERVE.sessions),
    perSession: Schema.number().default(DEFAULT_OBSERVE.perSession),
    messageChars: Schema.number().default(DEFAULT_OBSERVE.messageChars),
    totalChars: Schema.number().default(DEFAULT_OBSERVE.totalChars),
  }),
  retrieval: Schema.object({
    vector: Schema.boolean().default(false),
  }),
  panelEntriesLimit: Schema.number().default(200),
  panelAuditLimit: Schema.number().default(20),
  auditRetentionDays: Schema.number().default(0),
  proposals: Schema.object({
    enabled: Schema.boolean().default(true),
    maxChars: Schema.number().default(2000),
    maxPending: Schema.number().default(8),
  }),
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  ...SHARED_CONFIG_FIELDS,
})

/** 宿主设置弹窗一级项（client 端 settings.section 注册以本 namespace 为 id/页面来源）。 */
export const SETTINGS_NAMESPACE = 'yammory-system'

/** 设置面板用户面 schema：共享字段 + 面板入口开关；无 enabled（见 Config typedef）。 */
export const SettingsSchema = Schema.object({
  ...SHARED_CONFIG_FIELDS,
  panel: Schema.object({
    enabled: Schema.boolean().default(true),
  }),
})

/**
 * 记忆写审批请求：service 层强制走 ctx.approval.request（waterfall 接缝）。
 * approval/asked + approval/decided（会话日志已知事件类型）由审批服务自动落盘；
 * reason 携带完整写载荷，S2"变更可自会话日志重建"由此成立。
 * @param {ApprovalLike} approval - ApprovalService。
 * @param {WritePayload} payload - {action, track, scope, text, count?}。
 * @param {AskWrite} write - {agent, callId?, signal?}。
 * @returns {Promise<string>} ApprovalOutcome。
 */
async function askApproval(approval, payload, write) {
  const request = {
    agent: write.agent,
    toolName: TOOL_NAME,
    reason: buildWriteReason(payload),
    ...(write.callId === undefined ? {} : { callId: write.callId }),
    ...(write.signal === undefined ? {} : { signal: write.signal }),
  }
  try {
    return await approval.request(request)
  } catch (error) {
    if (error instanceof MemoryError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new WriteDeniedError('unavailable', `approval ask failed: ${message}`)
  }
}

/**
 * 自适应会话事件派发：只有 harness 已知该事件类型才 append。
 * rc.6 无插件事件注册面（KNOWN_SESSION_EVENT_TYPES 不含 memory/*，且
 * Session.append 无法标记 ignorable）：append 未注册类型会让该会话下次加载
 * 被持久化层拒绝。因此默认跳过，审计由审批审计对 + 审计表承担；未来 harness
 * 收录 memory/* 进已知集合后自动开启。
 * alpha.5 复核（2026-09-02）：KNOWN_SESSION_EVENT_TYPES 仍不含 memory/*，
 * Session.append 写入面仍只接受 surface intent 可选参（非 surface 类型
 * 保持两参调用形态）、仍无 writer 侧 ignorable 标记；读取端已有 ignorable
 * 信封容忍未知类型。故本门在 alpha.5 下保持关闭，行为不变。
 * rc.1 / 0.1.3-alpha.1 复核（2026-09-04）：append 第三参仍为 surface-only
 * SurfaceIntent、仍无 ignorable 写入通道，KNOWN 清单仍不含 memory/*——
 * 结论不变，本门在这两条线上同样保持关闭。
 * @param {{append?: (type: string, data: object) => unknown} | null | undefined} session - Session。
 * @param {string} type - 事件类型。
 * @param {object} data - 载荷。
 */
function maybeAppendSessionEvent(session, type, data) {
  if (session === undefined || session === null) return
  if (KNOWN_SESSION_EVENT_TYPES.has(type)) session.append(type, data)
}

/**
 * ctx.memory 服务（Service Definition 实现）。
 * 协议写语义（预算预检 → 审批 → 预算复审 → 落盘 → 审计）在 lib/protocol.mjs 的
 * MemoryProtocolCore 里——协议与实现分离，协议部分零 DSH 依赖；本类只注入两件
 * DSH 专属物：审批传输（ctx.approval）与会话事件派发（memory/* 词汇的已知类型
 * 自适应门）。读方法无审批；禁用时本服务整体不存在。
 */
export class MemoryService extends MemoryProtocolCore {
  /**
   * @param {ServiceDeps} deps - {store, budgets, writePolicy, maxEntriesPerQuery, commandListLimit, commandAuditLimit, language, approval, sourceLabel}。
   */
  constructor(deps) {
    super({
      store: deps.store,
      budgets: deps.budgets,
      writePolicy: deps.writePolicy,
      defaultQueryLimit: deps.maxEntriesPerQuery,
      sourceLabel: deps.sourceLabel,
      gate: (payload, write) => askApproval(deps.approval, /** @type {WritePayload} */ (payload), write),
      emit: (session, type, data) => maybeAppendSessionEvent(session, type, data),
    })
    this.commandListLimit = deps.commandListLimit
    this.commandAuditLimit = deps.commandAuditLimit
    this.language = deps.language
  }
}

/** 工具结果里的固定错误形状（schema additionalProperties:false 需要显式字段）。 */
function toToolError(/** @type {unknown} */ error) {
  if (error instanceof MemoryError) {
    const { code, message, ...details } = error.toPublic()
    return {
      code,
      message,
      ...(details.outcome === undefined ? {} : { outcome: details.outcome }),
      ...(details.used === undefined ? {} : { usage: { track: details.track, scope: details.scope, used: details.used, limit: details.limit } }),
      ...(details.candidates === undefined ? {} : { candidates: details.candidates }),
      ...(details.sample === undefined ? {} : { sample: details.sample }),
    }
  }
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}

/** 记忆工具描述：内嵌 Save/Skip 行为指引（学 Hermes 官方 memory.md 清单）。en 为源文，zh 为对应译文。 */
const MEMORY_TOOL_DESCRIPTION = {
  en: [
    'Read and write the layered, approval-gated cross-session memory store (yammory_system).',
    '',
    'Tracks: "user" holds facts about the user (preferences, communication style, landmines, corrections); "agent" holds environment facts, project conventions, lessons learned, and completed-work summaries. Layers: "user-global" applies to every workspace; "workspace" applies only to the current working directory.',
    '',
    'Each track/layer pair has a soft warning line (shown in the session memory snapshot header). Crossing it NEVER blocks a write — it only flags that this layer is worth consolidating. Never truncate or silently drop content.',
    '',
    'SAVE: user preferences and corrections; environment facts and project conventions; lessons learned from mistakes; summaries of completed work; anything the user explicitly asks you to remember.',
    'SKIP: trivial or re-derivable facts; encyclopedia knowledge a fresh search can answer; large data dumps or logs; one-off file paths; content already available in the current workspace.',
    '',
    'Writes (add/replace/remove/consolidate/supersede/restore/arbitrate) require approval under the configured policy and are audited; reads (query/tidy) are free. replace/remove target an entry by a UNIQUE case-insensitive substring — an ambiguous match fails with the candidate list, so use a longer substring. consolidate merges 1..20 existing entries (unique substrings) into ONE new entry with a single approval and one atomic write — use it when a layer crosses its warning line. supersede is the tidy path: it merges 1..20 entries (by id, from a tidy plan) into one entry that carries the `merged` tag while the old ones are KEPT and demoted to `superseded` (kept on disk, out of every session\u2019s view; never physically deleted). It stays inside one bucket (track x scope x agentKey, plus workspaceKey on the workspace layer) — never cross buckets, never merge entries that merely look similar: when in doubt, leave them alone. restore walks a demotion back (superseded -> active, version untouched, back into every session\u2019s view) and is the only way out of the demoted state. arbitrate settles a same-entry-two-sources conflict on ONE facet: the direction comes from a fixed table — ability follows observation, preference follows the self-report, the other five facets keep BOTH and tag each with `gap`. The table is the direction; there is deliberately no reverse argument. Within a group the most recently updated entry is kept and the rest of that group is demoted too. Each session starts with a FROZEN warm-up block: the user\u2019s per-domain knowledge level (as speaking constraints) plus the standing user-global profile. That block never changes mid-session. Workspace-scoped and agent-track memory is deliberately NOT in it — fetch those on demand with memory_recall (or query); a closing line in the block tells you how many such entries are waiting.',
    '',
    'PROFILE COORDINATES: every entry can carry two optional coordinates. facet tags which face of the user profile the entry belongs to (one of: 躯体 | 心智 | 价值与意愿 | 能力与技能 | 行为与习惯 | 社会与处境 | 经历与轨迹). level (1..10) is the per-domain knowledge level and belongs only on entries about the user\u2019s knowledge/subject level; the structured per-domain scale itself is written with memory_profile, not with this tool. On replace, an omitted facet/level keeps the existing coordinate.',
  ].join('\n'),
  zh: [
    '读写分层、带审批门、可审计的跨会话记忆库（yammory_system）。',
    '',
    '轨道："user" 存用户相关事实（偏好、沟通风格、雷区、纠正）；"agent" 存环境事实、项目约定、教训与已完成工作总结。层："user-global" 对所有工作区生效；"workspace" 只对当前工作目录生效。',
    '',
    '每对轨道/层有一条软预警线（显示在会话记忆快照头部）。越线绝不拦写——只提示这一格值得整合。绝不截断、绝不静默丢弃内容。',
    '',
    '应存（SAVE）：用户偏好与纠正；环境事实与项目约定；犯错得到的教训；已完成工作总结；用户明确要求记住的内容。',
    '应跳过（SKIP）：琐碎或可再推导的事实；重新搜索即可回答的百科知识；大数据转储或日志；一次性文件路径；当前工作区已有的内容。',
    '',
    '写（add/replace/remove/consolidate/supersede/restore/arbitrate）需按配置策略审批并落审计；读（query/tidy）免费。replace/remove 用唯一大小写不敏感子串定位——歧义时报候选清单，请用更长子串。consolidate 以一次审批 + 一次原子写把 1..20 条整合为一条——层越预警线时使用。supersede 是整理机那条路：按 id（取自 tidy 计划）把 1..20 条合并成一条带 `merged` 标的新条目，旧条目**保留**并降级为 `superseded`（仍在库里，但不进任何会话的可见集；绝不物理删）。它只在同一个桶内进行（track × scope × agentKey，workspace 层再加 workspaceKey）——绝不跨桶，也不要只因「看着像」就合并：拿不准就留着。restore 把一次降级走回来（superseded → active，version 不动，重新进入每个会话的可见集），它是脱离降级态的唯一出口。arbitrate 在**一个面**上裁决「同一条事实、两个来源」的冲突：方向由固定表决定——能力听观察、意愿听自陈，其余五面**两条都留**并各打 `gap` 标。表即方向，刻意没有反向参数。同组内保留 updatedAt 最新者，其余同组条目一并降级。每个会话启动时获得一个冻结的预热块：用户分领域知识水平（表达约束）＋ 常驻 user-global 画像。该块在会话内不变。工作区层与 agent 轨记忆刻意不入此块——需要时用 memory_recall（或 query）按需取；该块末行会告诉你这类条目还有几条在等着。',
    '',
    '画像坐标：每条条目可带两个可选坐标。facet 标明该条目属于用户画像的哪一面（取值：躯体 | 心智 | 价值与意愿 | 能力与技能 | 行为与习惯 | 社会与处境 | 经历与轨迹）。level（1..10）是分领域知识水平，只用在「知识与学科水平」类条目上；结构化的分领域刻度本身请用 memory_profile 写，不用本工具。replace 时省略 facet/level 即保持原坐标。',
  ].join('\n'),
}

/** 记忆工具参数描述（双语）。 */
const MEMORY_TOOL_PARAMETERS = {
  en: {
    action: 'add = insert a new entry; replace = rewrite one existing entry; remove = delete one existing entry; consolidate = merge 1..20 existing entries into one new entry (single approval, atomic); supersede = merge 1..20 existing entries into one new `merged`-tagged entry while the old ones are kept and demoted to `superseded` (the tidy path; single approval, atomic); restore = walk a demotion back (superseded -> active, version untouched); arbitrate = settle a same-entry-two-sources conflict on one facet, direction fixed by the arbitration table; tidy = read-only tidy plan (backlog + per-bucket candidates + similar pairs); query = substring search over existing entries.',
    track: 'Memory track. Defaults to "user". user = facts about the user; agent = environment/project facts and conventions.',
    scope: 'Layer. Defaults to "workspace". user-global applies to every workspace; workspace applies only to this working directory.',
    text: 'add/replace: the exact entry text. supersede: optional merged text (omit to only demote). query: case-insensitive substring filter.',
    match: 'replace/remove: a UNIQUE case-insensitive substring of the existing entry to target.',
    matches: 'consolidate: 1..20 UNIQUE case-insensitive substrings of the entries to merge into the new text.',
    ids: 'supersede / restore / arbitrate: 1..20 entry ids. Every id must sit in the SAME bucket (track x scope x agentKey, plus workspaceKey on the workspace layer); buckets are never crossed. restore only accepts `superseded` ids; arbitrate needs at least one observation-sourced and one self-report entry sharing a single facet.',
    limit: 'query: maximum entries to return (default 20; hard-capped at 1000).',
    tags: 'Optional short labels for the entry (e.g. ["project-x", "decision"]). At most 16 tags, each at most 32 characters; applies to add/replace/consolidate/supersede (supersede always adds the `merged` tag).',
    facet: 'Optional profile face this entry belongs to (one of the seven facets). Applies to add/replace/consolidate/supersede; on replace an omitted facet keeps the current one.',
    level: 'Optional per-domain knowledge level 1..10 (科普 1-3 / 本科 4-6 / 硕士 7-8 / 专家 9-10), for entries about the user\u2019s knowledge or subject level. Applies to add/replace/consolidate/supersede; on replace an omitted level keeps the current one.',
  },
  zh: {
    action: 'add = 新增一条；replace = 改写一条既有条目；remove = 删除一条既有条目；consolidate = 把 1..20 条既有条目整合为一条新条目（单次审批、原子执行）；supersede = 整理机：把 1..20 条既有条目合并成一条带 `merged` 标的新条目，旧条目保留并降级为 `superseded`（单次审批、原子执行）；restore = 把降级走回来（superseded → active，version 不动）；arbitrate = 在一个面上裁决「同一条事实、两个来源」的冲突，方向由裁决表固定；tidy = 只读整理计划（积压 ＋ 分桶候选 ＋ 相似线索）；query = 对既有条目的子串检索。',
    track: '记忆轨道。默认 "user"。user = 用户相关事实；agent = 环境/项目事实与约定。',
    scope: '层。默认 "workspace"。user-global 对所有工作区生效；workspace 只对当前工作目录生效。',
    text: 'add/replace：完整条目文本。supersede：可选的合并后文本（省略即只降级、不落新条目）。query：大小写不敏感子串过滤。',
    match: 'replace/remove：目标条目的唯一大小写不敏感子串。',
    matches: 'consolidate：要并入新文本的 1..20 个唯一大小写不敏感子串。',
    ids: 'supersede / restore / arbitrate：1..20 个条目 id（取自整理计划或 /memory list）。所有 id 必须同属一个桶（track × scope × agentKey，workspace 层再加 workspaceKey）；桶内不跨。restore 只接受 `superseded` 的 id；arbitrate 要求至少一条观察来源与一条自陈来源、且共用同一个面。',
    limit: 'query：最多返回条数（默认 20；硬钳 1000）。',
    tags: '可选短标签（如 ["project-x", "decision"]）。最多 16 个、每个最多 32 字符；用于 add/replace/consolidate/supersede（supersede 恒补 `merged` 标）。',
    facet: '可选：该条目属于七面中的哪一面。用于 add/replace/consolidate/supersede；replace 时省略即保持原面。',
    level: '可选：分领域知识水平 1..10（科普 1-3 / 本科 4-6 / 硕士 7-8 / 专家 9-10），用于「知识与学科水平」类条目。用于 add/replace/consolidate/supersede；replace 时省略即保持原值。',
  },
}

/**
 * memory 工具定义（Consumer）。execute 尊重 exec.signal；领域失败返回
 * ok:false + 结构化 error，基础设施失败才抛出（isError）。
 * @param {MemoryService} service - ctx.memory。
 * @param {'en'|'zh'} [language] - 'en' | 'zh'。
 * @returns {object} 工具定义。
 */
export function makeMemoryTool(service, language = 'en') {
  const parameters = MEMORY_TOOL_PARAMETERS[language] ?? MEMORY_TOOL_PARAMETERS.en
  return defineTool({
    name: 'memory',
    description: MEMORY_TOOL_DESCRIPTION[language] ?? MEMORY_TOOL_DESCRIPTION.en,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'replace', 'remove', 'consolidate', 'supersede', 'restore', 'arbitrate', 'tidy', 'query'],
        description: parameters.action,
      },
      track: {
        type: 'string',
        enum: ['user', 'agent'],
        description: parameters.track,
      },
      scope: {
        type: 'string',
        enum: ['user-global', 'workspace'],
        description: parameters.scope,
      },
      text: {
        type: 'string',
        description: parameters.text,
      },
      match: {
        type: 'string',
        description: parameters.match,
      },
      matches: {
        type: 'array',
        items: { type: 'string' },
        description: parameters.matches,
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: parameters.ids,
      },
      limit: {
        type: 'integer',
        description: parameters.limit,
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: parameters.tags,
      },
      facet: {
        type: 'string',
        enum: [...PROFILE_FACETS],
        description: parameters.facet,
      },
      level: {
        type: 'integer',
        description: parameters.level,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['add', 'replace', 'remove', 'consolidate', 'supersede', 'restore', 'arbitrate', 'tidy', 'query'] },
          ok: { type: 'boolean', required: true },
          entry: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              track: { type: 'string', required: true },
              scope: { type: 'string', required: true },
              text: { type: 'string', required: true },
              source: { type: 'string', required: true },
              tags: { type: 'array', items: { type: 'string' }, required: true },
              facet: { type: 'string' },
              level: { type: 'integer' },
            },
          },
          removed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          superseded: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          restored: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          kept: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                source: { type: 'string', required: true },
              },
            },
          },
          demoted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          tagged: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
          facet: { type: 'string' },
          direction: { type: 'string' },
          plan: { type: 'string' },
          candidates: { type: 'integer' },
          backlog: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer', required: true },
              chars: { type: 'integer', required: true },
              due: { type: 'boolean', required: true },
              reason: { type: 'string' },
            },
          },
          previous: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                track: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                text: { type: 'string', required: true },
                source: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                facet: { type: 'string' },
                level: { type: 'integer' },
              },
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              track: { type: 'string', required: true },
              scope: { type: 'string', required: true },
              used: { type: 'integer', required: true },
              limit: { type: 'integer', required: true },
            },
          },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              outcome: { type: 'string' },
              usage: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  track: { type: 'string', required: true },
                  scope: { type: 'string', required: true },
                  used: { type: 'integer', required: true },
                  limit: { type: 'integer', required: true },
                },
              },
              candidates: { type: 'integer' },
              sample: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: renderMemoryResult,
    },
    execute: /** @type {(args: any, exec: any) => Promise<any>} */ (async (args, exec) => {
      exec.signal.throwIfAborted()
      const write = {
        agent: exec.agent,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        signal: exec.signal,
      }
      // F5 会话级开关：关了记忆的会话，模型面查库（action=query）一律拒。写动作由
      // 协议层拦（同一开关的第二道，也是安全保证的那一道），此处只是不重复打听。
      // 抛出点放在 try 内：拒绝要变成结构化结果，绝不让裸错误逃出工具层。
      try {
        // F5 会话级开关：关了记忆的会话，模型面读库（query / tidy）一律拒。写动作由
        // 协议层拦（同一开关的第二道，也是安全保证的那一道），此处只是不重复打听。
        if ((args.action === 'query' || args.action === 'tidy') && !service.store.sessionEnabled(exec.agent?.session?.id)) {
          throw new SessionMemoryOffError(/** @type {string | undefined} */ (exec.agent?.session?.id))
        }
        switch (args.action) {
          case 'query': {
            const result = service.query(
              {
                ...(args.track === undefined ? {} : { track: args.track }),
                ...(args.scope === undefined ? {} : { scope: args.scope }),
                ...(args.text === undefined ? {} : { text: args.text }),
                ...(args.limit === undefined ? {} : { limit: args.limit }),
              },
              {
                sessionId: exec.agent?.session?.id,
                session: exec.agent?.session,
                // 会话内读按可见集过滤（共享 + 本 agent），与冻结快照同一语义。
                agentKey: agentKeyOf(/** @type {string | undefined} */ (exec.agent?.session?.header?.agentPreset)),
              },
            )
            return {
              action: 'query',
              ok: true,
              entries: result.entries.map(publicEntry),
              total: result.total,
              truncated: result.truncated,
            }
          }
          case 'add': {
            const result = await service.add(
              {
                track: args.track ?? 'user',
                scope: args.scope ?? 'workspace',
                text: args.text,
                source: 'memory-tool',
                ...(args.tags === undefined ? {} : { tags: args.tags }),
                ...(args.facet === undefined ? {} : { facet: args.facet }),
                ...(args.level === undefined ? {} : { level: args.level }),
              },
              write,
            )
            return { action: 'add', ok: true, entry: publicEntry(result.entry), usage: result.usage }
          }
          case 'replace': {
            const result = await service.replace(
              {
                track: args.track ?? 'user',
                scope: args.scope ?? 'workspace',
                match: args.match,
                text: args.text,
                source: 'memory-tool',
                ...(args.tags === undefined ? {} : { tags: args.tags }),
                ...(args.facet === undefined ? {} : { facet: args.facet }),
                ...(args.level === undefined ? {} : { level: args.level }),
              },
              write,
            )
            return {
              action: 'replace',
              ok: true,
              entry: publicEntry(result.entry),
              previous: { id: result.previous.id, text: result.previous.text },
              usage: result.usage,
            }
          }
          case 'remove': {
            const result = await service.remove(
              {
                track: args.track ?? 'user',
                scope: args.scope ?? 'workspace',
                match: args.match,
              },
              write,
            )
            return { action: 'remove', ok: true, entry: publicEntry(result.entry), usage: result.usage }
          }
          case 'consolidate': {
            const result = await service.consolidate(
              {
                track: args.track ?? 'user',
                scope: args.scope ?? 'workspace',
                matches: args.matches,
                text: args.text,
                source: 'memory-tool',
                ...(args.tags === undefined ? {} : { tags: args.tags }),
                ...(args.facet === undefined ? {} : { facet: args.facet }),
                ...(args.level === undefined ? {} : { level: args.level }),
              },
              write,
            )
            return {
              action: 'consolidate',
              ok: true,
              entry: publicEntry(result.entry),
              removed: result.removed.map((old) => ({ id: old.id, text: old.text })),
              usage: result.usage,
            }
          }
          case 'supersede': {
            // F6 整理机的落写面：合并 ＋ 降级（旧条目留痕不删），一次审批一次原子写。
            // source 锚死 'consolidation'：粒度键 `source:consolidation`（规格 3.5.7）
            // 才有着力点——用户想「整理免审批」就改这一条，不必放宽全局策略。
            const result = await service.supersede(
              {
                ids: args.ids,
                ...(args.text === undefined ? {} : { text: args.text }),
                source: 'consolidation',
                ...(args.tags === undefined ? {} : { tags: args.tags }),
                ...(args.facet === undefined ? {} : { facet: args.facet }),
                ...(args.level === undefined ? {} : { level: args.level }),
              },
              write,
            )
            return {
              action: 'supersede',
              ok: true,
              ...(result.entry === null ? {} : { entry: publicEntry(result.entry) }),
              superseded: result.superseded.map((old) => ({ id: old.id, text: old.text })),
              usage: result.usage,
            }
          }
          case 'restore': {
            // S5 §1 的回滚面：把降级条目救回在场集（superseded → active），一次审批一次原子写。
            // source 锚死 'governance'（与本工具其它动作的 source 同样只作审计标注与粒度键）。
            const result = await service.restore({ ids: args.ids, source: 'governance' }, write)
            return {
              action: 'restore',
              ok: true,
              // 只上带 output schema 声明过的字段：声明 additionalProperties:false 的校验器
              // 会把未声明的键剥掉，与其让它静默消失，不如在这里就只投影 id 与正文。
              restored: result.restored.map((entry) => ({ id: entry.id, text: entry.text })),
              usage: result.usage,
            }
          }
          case 'arbitrate': {
            // S5 §2 的裁决面：方向由 ARBITRATION_BY_FACET 决定，模型没有反向参数。
            // 一次审批一批落盘（降级 ＋ 打标 ＋ 审计 action='arbitrate'）。
            const result = await service.arbitrate({ ids: args.ids, source: 'governance' }, write)
            return {
              action: 'arbitrate',
              ok: true,
              facet: result.facet,
              direction: result.direction,
              kept: result.kept.map((entry) => ({ id: entry.id, text: entry.text, source: entry.source })),
              demoted: result.demoted.map((entry) => ({ id: entry.id, text: entry.text })),
              tagged: result.tagged.map((entry) => ({ id: entry.id, text: entry.text, tags: entry.tags })),
              usage: result.usage,
            }
          }
          case 'tidy': {
            // 只读整理计划：算积压 ＋ 分组候选 ＋ 桶内相似线索。不写库、不落审计、
            // 不调模型——语义判断（哪几条在讲同一件事）由本会话的模型自己做。
            const plan = buildTidyPlan(
              visibleFullEntries(
                service.store.listEntries(),
                workspaceKeyOf(/** @type {string | undefined} */ (exec.agent?.session?.header?.cwd)),
                agentKeyOf(/** @type {string | undefined} */ (exec.agent?.session?.header?.agentPreset)),
              ),
              {
                since: lastTidyTs(service.store.auditList(TIDY_AUDIT_WINDOW)),
                ...(Number.isInteger(args.limit) && args.limit > 0 ? { candidateLimit: args.limit } : {}),
              },
            )
            return {
              action: 'tidy',
              ok: true,
              plan: tidyPlanLines(plan, service.language).join('\n'),
              candidates: plan.candidates,
              backlog: {
                count: plan.backlog.count,
                chars: plan.backlog.chars,
                due: plan.backlog.due,
                ...(plan.backlog.reason === null ? {} : { reason: plan.backlog.reason }),
              },
            }
          }
          default: {
            throw new InvalidInputError(`unknown memory action ${JSON.stringify(args.action)}`)
          }
        }
      } catch (error) {
        if (error instanceof MemoryError) {
          return { action: args.action, ok: false, error: toToolError(error) }
        }
        throw error
      }
    }),
  })
}

/** 工具结果里的公开条目投影（只带声明过的字段；未设坐标的条目不出现 facet/level 键）。 */
function publicEntry(/** @type {MemoryEntry} */ entry) {
  return {
    id: entry.id,
    track: entry.track,
    scope: entry.scope,
    text: entry.text,
    source: entry.source,
    tags: entry.tags,
    ...(entry.facet === null || entry.facet === undefined ? {} : { facet: entry.facet }),
    ...(entry.level === null || entry.level === undefined ? {} : { level: entry.level }),
  }
}

/**
 * 工具结果渲染（纯函数）。
 * @param {object} _args - 调用参数（未用）。
 * @param {object} value - 规范 JSON 结果。
 * @returns {Array<{type: 'text', text: string}>} 模型可见文本。
 */
export function renderMemoryResult(/** @type {object} */ _args, /** @type {MemoryToolValue} */ value) {
  if (!value.ok) {
    return [{ type: 'text', text: `memory ${value.action} failed: ${value.error.message}` }]
  }
  switch (value.action) {
    case 'query':
      return [{
        type: 'text',
        text: value.entries.length === 0
          ? 'memory query: no entries matched'
          : `memory query: ${value.entries.length} match${value.entries.length === 1 ? '' : 'es'}${value.truncated ? ` (of ${value.total} total; refine the filter for more)` : ''}\n${value.entries.map((entry) => `- [${entry.track}/${entry.scope}]${coordinateTag(entry)} ${entry.text}`).join('\n')}`,
      }]
    case 'add':
      return [{ type: 'text', text: `memory entry added (${value.entry.track}/${value.entry.scope}): ${value.entry.text}${coordinateTag(value.entry)}\nbudget: ${value.usage.used}/${value.usage.limit} chars used` }]
    case 'replace':
      return [{ type: 'text', text: `memory entry replaced (${value.entry.track}/${value.entry.scope}): ${value.entry.text}${coordinateTag(value.entry)}\nbudget: ${value.usage.used}/${value.usage.limit} chars used` }]
    case 'remove':
      return [{ type: 'text', text: `memory entry removed (${value.entry.track}/${value.entry.scope}): ${value.entry.text}${coordinateTag(value.entry)}\nbudget: ${value.usage.used}/${value.usage.limit} chars used` }]
    case 'consolidate':
      return [{ type: 'text', text: `memory entries consolidated (${value.entry.track}/${value.entry.scope}): ${value.removed.length} removed → ${value.entry.text}${coordinateTag(value.entry)}\nbudget: ${value.usage.used}/${value.usage.limit} chars used` }]
    case 'supersede':
      return [{
        type: 'text',
        text: value.entry === undefined
          ? `memory entries superseded: ${value.superseded.length} demoted to superseded (kept on disk, out of every session\u2019s view)\nbudget: ${value.usage.used}/${value.usage.limit} chars used`
          : `memory entries tidied (${value.entry.track}/${value.entry.scope}): ${value.superseded.length} superseded (kept) → 1 merged entry tagged \`merged\`: ${value.entry.text}${coordinateTag(value.entry)}\nbudget: ${value.usage.used}/${value.usage.limit} chars used`,
      }]
    case 'restore':
      return [{
        type: 'text',
        text: `memory entries restored: ${value.restored.length} back to active (they re-enter every session\u2019s view; version untouched)\n${value.restored.map((entry) => `- ${entry.text}`).join('\n')}\nbudget: ${value.usage.used}/${value.usage.limit} chars used`,
      }]
    case 'arbitrate':
      return value.direction === 'coexist'
        ? [{
            type: 'text',
            text: `memory arbitration on facet ${value.facet}: coexist — nothing demoted, ${value.tagged.length} entr${value.tagged.length === 1 ? 'y' : 'ies'} tagged \`gap\` (the gap itself is the evidence)\n${value.tagged.map((entry) => `- ${entry.text}`).join('\n')}\nbudget: ${value.usage.used}/${value.usage.limit} chars used`,
          }]
        : [{
            type: 'text',
            text: `memory arbitration on facet ${value.facet}: kept ${value.kept.length} (source: ${value.kept.map((entry) => entry.source).join(', ')}), demoted ${value.demoted.length} to superseded (kept on disk, out of every session\u2019s view; use action=restore to bring them back)\n${value.kept.map((entry) => `- kept: ${entry.text}`).join('\n')}\n${value.demoted.map((entry) => `- demoted: ${entry.text}`).join('\n')}\nbudget: ${value.usage.used}/${value.usage.limit} chars used`,
          }]
    case 'tidy':
      return [{ type: 'text', text: value.plan }]
    default:
      return [{ type: 'text', text: `memory ${value.action}: ok` }]
  }
}

/** 条目坐标后缀（facet/level 在场才渲染；都没有返回空串）。 */
function coordinateTag(/** @type {PublicEntry} */ entry) {
  const parts = [
    ...(typeof entry.facet === 'string' ? [`facet: ${entry.facet}`] : []),
    ...(Number.isInteger(entry.level) ? [`level: ${entry.level}/10`] : []),
  ]
  return parts.length === 0 ? '' : ` [${parts.join(' · ')}]`
}

/**
 * 会话可见集过滤（与快照 `visibleEntries`、写定位同一语义）：agentKey 为 ''（共享层）
 * 或等于本会话 agentKey；scope=user-global 全见，workspace 只匹配本会话 cwd 键。
 * 与 lib/snapshot.mjs 的版本差异只在形状：这里原样保留条目全字段（整理计划要 tags/热度），
 * 故不能复用那个只面向渲染的窄形状函数（@template 让调用方的条目类型原样透传）。
 * @template {{agentKey: string, scope: string, workspaceKey: string}} T
 * @param {T[]} entries - 全部条目。
 * @param {string} workspaceKey - 会话 cwd 的规范化键。
 * @param {string} [agentKey] - 会话 agentPreset 键（'' = 共享层）。
 * @returns {T[]} 可见条目（保序）。
 */
function visibleFullEntries(entries, workspaceKey, agentKey = '') {
  return entries.filter((entry) =>
    (entry.agentKey === '' || entry.agentKey === agentKey)
    && (entry.scope === 'user-global' || (entry.scope === 'workspace' && entry.workspaceKey === workspaceKey)))
}

/** memory_profile 工具描述：分领域知识水平（表达约束的数据源）。en 为源文，zh 为对应译文。 */
const MEMORY_PROFILE_TOOL_DESCRIPTION = {
  en: [
    'Read and write the per-domain knowledge level (yammory_system) — the structured scale behind the speaking constraints injected into each session.',
    '',
    'This table holds ONE integer per knowledge subdomain (31 subdomains across 8 categories), on a 1..10 scale mapped to four tiers: 科普 (1-3), 本科 (4-6), 硕士 (7-8), 专家 (9-10). It is written by the user-facing profile questionnaire, not by prose entries — use the memory tool for everything else.',
    '',
    'ACTION set writes one (domain, level) pair and needs approval under the configured policy; list and get are free reads. set is idempotent (domain is the primary key) and audited. Prefer writing only what the user actually stated or confirmed; never invent a level. When a self-reported level conflicts with observed behaviour, keep the reported value here and note the observation as a memory entry instead.',
  ].join('\n'),
  zh: [
    '读写分领域知识水平（yammory_system）——注入到每个会话的表达约束背后的那把结构化标尺。',
    '',
    '本表为每个知识子领域（8 大类 31 个子领域）各存一个 1..10 的整数，映射四档：科普（1-3）、本科（4-6）、硕士（7-8）、专家（9-10）。它由面向用户的画像问卷写入，不用散文条目充当标尺——其它内容一律走 memory 工具。',
    '',
    'action set 写入一对（领域, 水平），按配置策略需审批；list 与 get 是免费读。set 幂等（domain 为主键）且落审计。只写用户真正说过或确认过的值，绝不替用户编造档位。自陈档位与实际表现冲突时，本表保留自陈值，把观察写进 memory 条目。',
  ].join('\n'),
}

/** memory_profile 工具参数描述（双语）。 */
const MEMORY_PROFILE_TOOL_PARAMETERS = {
  en: {
    action: 'set = write one (domain, level) pair (approval-gated, idempotent); list = all scored domains; get = one domain.',
    domain: 'Knowledge subdomain (one of the 31 fixed subdomains across 8 categories: 语言 / 数理与逻辑 / 自然科学 / 工程与技术 / 人文与社会 / 艺术与审美 / 生活与实务 / 元能力). Required for set and get.',
    level: 'Knowledge level 1..10: 科普 1-3 (popular), 本科 4-6 (undergraduate, the default anchor), 硕士 7-8 (graduate), 专家 9-10 (expert). Required for set.',
    tier: 'Optional tier override (科普 | 本科 | 硕士 | 专家). Omit it: the tier is derived from level.',
  },
  zh: {
    action: 'set = 写入一对（领域, 水平）（需审批、幂等）；list = 全部已打分领域；get = 单个领域。',
    domain: '知识子领域（8 大类 31 个固定子领域之一：语言 / 数理与逻辑 / 自然科学 / 工程与技术 / 人文与社会 / 艺术与审美 / 生活与实务 / 元能力）。set 与 get 必填。',
    level: '知识水平 1..10：科普 1-3、本科 4-6（默认锚点）、硕士 7-8、专家 9-10。set 必填。',
    tier: '可选档位覆盖（科普 | 本科 | 硕士 | 专家）。一般不传：档位由 level 推导。',
  },
}

/**
 * memory_observe 工具描述（S4b）：观察通道＝采集系统的第二条腿。
 * en 为源文，zh 为对应译文；「宁少勿多」写进描述本身（skill 可能没被加载，工具描述永远在）。
 */
const MEMORY_OBSERVE_TOOL_DESCRIPTION = {
  en: [
    'Observe the user from his own past words (yammory_system) — the second leg of profile collection, the one that reads behaviour instead of asking questions.',
    '',
    'ACTION scan (read-only, free): samples the user\u2019s OWN messages from recent conversation history and returns one bounded slice for you to reason over. Only real human messages are included — system-injected pseudo messages (runtime context, AGENTS.md, skill catalogs, goal rounds, subagent notices) are filtered out and counted in the result. There is deliberately no session id parameter: you may ask for "the last N days", never for a named session. When the character budget is reached the result states exactly what was NOT covered.',
    'ACTION commit (approval-gated): writes 1..8 observation entries in ONE atomic batch behind ONE approval. source is pinned to \u2018observation\u2019; each entry lands on user/user-global carrying a facet (one of the seven faces) plus the observation sub-face and the date in tags. Crossing the layer’s warning line never blocks the batch — it only flags that the layer is worth consolidating.',
    '',
    'WRITE LESS, NOT MORE. Every entry must quote the user\u2019s own words as evidence; without a quotable fragment the conclusion is not written. Zero entries is a legitimate outcome. At most 3 entries per observation — more than 3 means you are padding.',
    'NEVER write personality-type labels (MBTI, enneagram, Big Five, attachment style), clinical diagnoses, or negative character judgements. NEVER extract health conditions, sexuality, religion or politics, exact finances, addresses, or identity numbers unless the user explicitly asked you to remember them.',
    'The five faces only observation can reach: 思维方式与思辨 (how he breaks problems down), 人格特质 (stable reactions to difficulty, not a personality type), 情绪模式与心理强度 (what triggers him, how he recovers), 自我认知 (what he says about himself versus what he does), 决策与行动风格 (when he commits, when he stalls). Conclusions outside these five are written only with strong evidence, marked as a correction (face 校正) with the face it corrects.',
  ].join('\n'),
  zh: [
    '从用户本人的旧发言里观察他（yammory_system）——采集系统的第二条腿，读行为而非问问题的那条。',
    '',
    '动作 scan（只读、免费）：从近期会话历史里采样「他本人」的发言，返回一段有界切片供你推断。只取真人发言——系统注入的伪消息（运行时上下文、AGENTS.md、skill 目录、goal 轮次、子代理通知）一律过滤并在结果里计数。刻意不提供 sessionId 入参：你只能说「最近 N 天」，不能点名某个会话。字符预算到顶时，结果会明确报出「没看到哪些」。',
    '动作 commit（走审批门）：以一次审批、一次原子写落 1..8 条观察条目。source 锚死为 observation；每条落 user/user-global，带 facet（七面之一）＋ tags 里的观察子板块与日期。越预警线不拦写——只提示该层值得整合。',
    '',
    '宁少勿多。每条必须附用户原话作为证据；找不到可引用的原话就不写。0 条是合法输出。一次观察最多 3 条——超过 3 条说明你在凑数。',
    '绝不写人格类型标签（MBTI、九型、大五、依恋类型）、临床诊断或负面人格评价。绝不提取健康状况、性取向、宗教与政治立场、精确财务数字、住址与证件号——除非用户明确要求你记住。',
    '只有观察够得着的五个面：思维方式与思辨（怎么拆问题）、人格特质（面对困难与不确定的稳定反应，不是性格类型）、情绪模式与心理强度（什么触发他、他怎么恢复）、自我认知（他怎么说自己 vs 他怎么做）、决策与行动风格（什么时候果断、什么时候拖延）。这五面之外的结论只在证据非常明确时写，标为「校正」（face=校正）并给出被校正的面。',
  ].join('\n'),
}

/** memory_observe 工具参数描述（双语）。 */
const MEMORY_OBSERVE_TOOL_PARAMETERS = {
  en: {
    action: 'scan = read a bounded slice of the user\u2019s own past messages (read-only, free); commit = write 1..8 observation entries in one approval-gated atomic batch.',
    days: 'scan: how many days back to look (default 14, hard-capped at 90).',
    sessions: 'scan: how many recent sessions to sample (default 8, hard-capped at 20).',
    perSession: 'scan: max messages taken per session, sampled evenly so the opening AND the later corrections survive (default 12, hard-capped at 20).',
    messageChars: 'scan: max characters per single message before it is truncated with an ellipsis (default 400, hard-capped at 800).',
    totalChars: 'scan: total character budget for the whole slice; the scan stops there and reports what it could not cover (default 12000, hard-capped at 30000).',
    entries: 'commit: 1..8 entries, each { face, text, evidence, confidence?, facet?, tags? }. face is one of the five observation faces or 校正; text is one behavioural sentence without judgement; evidence quotes the user\u2019s own words; confidence 低 entries are rejected (low confidence is dropped, not written); facet is required only for a 校正 entry and must be one of the seven faces.',
    entryFace: 'Which observed face this conclusion belongs to: 思维方式与思辨 | 人格特质 | 情绪模式与心理强度 | 自我认知 | 决策与行动风格, or 校正 for a conclusion outside those five (strong evidence only).',
    entryText: 'The conclusion: ONE behavioural sentence, no judgement, no personality label (e.g. "restates the constraint before acting" rather than "is a careful person").',
    entryEvidence: 'A fragment of the user\u2019s own words that supports the conclusion, plus roughly when it was said. No quotable fragment means no entry.',
    entryConfidence: 'How sure you are: 高 | 中. Do not send 低 — low-confidence conclusions are dropped, not written.',
    entryFacet: 'Only for face=校正: which of the seven profile faces the observation corrects (躯体 | 心智 | 价值与意愿 | 能力与技能 | 行为与习惯 | 社会与处境 | 经历与轨迹).',
    entryTags: 'Optional extra short labels. The face, "observation" and the date are added automatically.',
  },
  zh: {
    action: 'scan = 只读取一段有界的「他本人旧发言」切片（只读、免费）；commit = 以一次审批、一次原子写落 1..8 条观察条目。',
    days: 'scan：回看多少天（默认 14，硬上限 90）。',
    sessions: 'scan：采样最近多少个会话（默认 8，硬上限 20）。',
    perSession: 'scan：每个会话最多取几条发言，均匀采样，好让开场与中后段的改口都留得下（默认 12，硬上限 20）。',
    messageChars: 'scan：单条发言超过多少字符即截断加省略号（默认 400，硬上限 800）。',
    totalChars: 'scan：整段切片的字符预算；到顶即停并报出未覆盖范围（默认 12000，硬上限 30000）。',
    entries: 'commit：1..8 条，每条 { face, text, evidence, confidence?, facet?, tags? }。face 取五个观察面之一或「校正」；text 是一句行为描述、不带评价；evidence 引用用户原话；confidence 标「低」的条目会被拒绝（低把握不写）；facet 只在「校正」条目上必填，且须是七面之一。',
    entryFace: '这条结论属于哪个观察面：思维方式与思辨 | 人格特质 | 情绪模式与心理强度 | 自我认知 | 决策与行动风格；五面之外的结论填「校正」（须证据非常明确）。',
    entryText: '结论本身：一句行为描述，不带评价、不贴人格标签（写「动手前会先复述约束」，不写「是个谨慎的人」）。',
    entryEvidence: '支撑这条结论的用户原话片段，附大致时间。找不到可引用的原话就不写这条。',
    entryConfidence: '把握程度：高 | 中。不要传「低」——低把握的结论直接丢弃，不写。',
    entryFacet: '仅当 face=校正 时必填：这条观察校正的是七面中的哪一面（躯体 | 心智 | 价值与意愿 | 能力与技能 | 行为与习惯 | 社会与处境 | 经历与轨迹）。',
    entryTags: '可选附加短标签。面、observation 与日期会自动加上。',
  },
}

/**
 * memory_profile 工具（S3）：分领域知识水平（profile 表）的对外读写通道。
 * 写（set）在协议核心 MemoryProtocolCore.setProfile 内强制走审批门与审计（与 memory
 * 工具同一套不变量，工具层绕不过）；读（list/get）无审批。领域用 31 项清单校验，
 * level 限 1..10 整数，tier 缺省由 tierForLevel 推导。
 * @param {MemoryService} service - ctx.memory。
 * @param {'en'|'zh'} [language] - 'en' | 'zh'。
 * @returns {object} 工具定义。
 */
export function makeMemoryProfileTool(service, language = 'en') {
  const parameters = MEMORY_PROFILE_TOOL_PARAMETERS[language] ?? MEMORY_PROFILE_TOOL_PARAMETERS.en
  const profileShape = /** @type {const} */ ({
    type: 'object',
    additionalProperties: false,
    properties: {
      domain: { type: 'string', required: true },
      level: { type: 'integer', required: true },
      tier: { type: 'string', required: true },
      updatedAt: { type: 'integer', required: true },
    },
  })
  return defineTool({
    name: 'memory_profile',
    description: MEMORY_PROFILE_TOOL_DESCRIPTION[language] ?? MEMORY_PROFILE_TOOL_DESCRIPTION.en,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['set', 'list', 'get'],
        description: parameters.action,
      },
      domain: {
        type: 'string',
        enum: [...KNOWLEDGE_DOMAINS],
        description: parameters.domain,
      },
      level: {
        type: 'integer',
        description: parameters.level,
      },
      tier: {
        type: 'string',
        enum: [...KNOWLEDGE_TIERS],
        description: parameters.tier,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['set', 'list', 'get'] },
          ok: { type: 'boolean', required: true },
          found: { type: 'boolean' },
          profile: profileShape,
          previous: profileShape,
          profiles: { type: 'array', items: profileShape },
          total: { type: 'integer' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        },
      },
      render: renderMemoryProfileResult,
    },
    execute: /** @type {(args: any, exec: any) => Promise<any>} */ (async (args, exec) => {
      exec.signal.throwIfAborted()
      const write = {
        agent: exec.agent,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        signal: exec.signal,
      }
      try {
        switch (args.action) {
          case 'set': {
            const result = await service.setProfile(
              {
                domain: args.domain,
                level: args.level,
                ...(args.tier === undefined ? {} : { tier: args.tier }),
                source: 'memory-profile-tool',
              },
              write,
            )
            return {
              action: 'set',
              ok: true,
              found: true,
              profile: publicProfile(result.profile),
              ...(result.previous === null ? {} : { previous: publicProfile(result.previous) }),
            }
          }
          case 'list': {
            const profiles = service.listProfiles().map(publicProfile)
            return { action: 'list', ok: true, profiles, total: profiles.length }
          }
          case 'get': {
            const row = service.getProfile(args.domain)
            return row === null
              ? { action: 'get', ok: true, found: false }
              : { action: 'get', ok: true, found: true, profile: publicProfile(row) }
          }
          default: {
            throw new InvalidInputError(`unknown memory_profile action ${JSON.stringify(args.action)}`)
          }
        }
      } catch (error) {
        if (error instanceof MemoryError) {
          return { action: args.action, ok: false, error: toToolError(error) }
        }
        throw error
      }
    }),
  })
}

/** 工具结果里的公开画像行投影（只带声明过的字段）。 */
function publicProfile(/** @type {ProfileRowValue} */ row) {
  return {
    domain: row.domain,
    level: row.level,
    tier: row.tier,
    updatedAt: row.updatedAt,
  }
}

/**
 * memory_profile 结果渲染（纯函数）。
 * @param {object} _args - 调用参数（未用）。
 * @param {MemoryProfileToolValue} value - 规范 JSON 结果。
 * @returns {Array<{type: 'text', text: string}>} 模型可见文本。
 */
export function renderMemoryProfileResult(/** @type {object} */ _args, /** @type {MemoryProfileToolValue} */ value) {
  if (!value.ok) {
    return [{ type: 'text', text: `memory_profile ${value.action} failed: ${value.error.message}` }]
  }
  switch (value.action) {
    case 'set': {
      const row = value.profile
      const from = value.previous === undefined ? 'new' : `${value.previous.level}/10 (${value.previous.tier}) → `
      return [{ type: 'text', text: `memory_profile set: ${row.domain} ${from}${row.level}/10 (${row.tier})` }]
    }
    case 'list':
      return [{
        type: 'text',
        text: value.profiles.length === 0
          ? 'memory_profile: no domain scored yet'
          : `memory_profile: ${value.profiles.length} domain(s) scored\n${value.profiles.map((row) => `- ${row.domain} ${row.level}/10 (${row.tier})`).join('\n')}`,
      }]
    case 'get':
      return [{
        type: 'text',
        text: value.found === true
          ? `memory_profile ${value.profile.domain}: ${value.profile.level}/10 (${value.profile.tier})`
          : 'memory_profile: no entry for that domain',
      }]
    default:
      return [{ type: 'text', text: `memory_profile ${value.action}: ok` }]
  }
}

// ── 观察通道（S4b） ───────────────────────────────────────────────────────────

/**
 * 观察切片的分行文案（en 源文 / zh 译文）：切片正文的语言面在 index.mjs，
 * 预算与结构在 lib/observe.mjs（纯函数）。
 */
const OBSERVE_SLICE_LABELS = {
  en: {
    header: (/** @type {{days: number, sessions: number}} */ info) => `The user's own messages, ${info.days}-day window (${info.sessions} candidate session(s)), sampled evenly within each session:`,
    session: (/** @type {{sessionId: string, title: string | null, messages: number}} */ info) => `### ${info.sessionId}${info.title === null ? '' : ` — ${info.title}`} (${info.messages} sampled)`,
    message: (/** @type {{at: number, text: string}} */ info) => `- [${formatStamp(info.at)}] ${info.text}`,
  },
  zh: {
    header: (/** @type {{days: number, sessions: number}} */ info) => `用户本人的发言，${info.days} 天窗口（候选 ${info.sessions} 个会话），每个会话内均匀采样：`,
    session: (/** @type {{sessionId: string, title: string | null, messages: number}} */ info) => `### ${info.sessionId}${info.title === null ? '' : ` — ${info.title}`}（采样 ${info.messages} 条）`,
    message: (/** @type {{at: number, text: string}} */ info) => `- [${formatStamp(info.at)}] ${info.text}`,
  },
}

/**
 * ctx.sessionQuery 的消费面（只读；服务方是内核 session-query，插件只调这四个方法）。
 * @typedef {object} SessionQueryLike
 * @property {(filters: object[], signal?: AbortSignal) => Promise<Array<{header?: {id?: unknown, createdAt?: unknown}}>>} filterSessions
 * @property {(sessionId: string) => Promise<{session?: {createdAt?: unknown}, events?: unknown[]}>} readSession
 * @property {(ids: string[], signal?: AbortSignal) => Promise<Array<{sessionId?: unknown, status?: unknown, value?: {title?: {title?: unknown}}}>>} [readTitleSnapshots]
 */

/**
 * 批量折出会话标题（给切片做「这是哪一场」的抬头）。
 * 标题是装饰：任何一步失败都退化为「没有标题」，绝不阻断观察。
 * @param {SessionQueryLike} sessionQuery - 内核 session-query 服务。
 * @param {string[]} ids - 会话 id。
 * @param {AbortSignal | undefined} signal - 取消信号（命令面无 signal 时为 undefined）。
 * @returns {Promise<Map<string, string>>} id → 标题（缺失即无此键）。
 */
async function readObservationTitles(sessionQuery, ids, signal) {
  /** @type {Map<string, string>} */
  const titles = new Map()
  if (ids.length === 0 || typeof sessionQuery.readTitleSnapshots !== 'function') return titles
  /** @type {Array<{sessionId?: unknown, status?: unknown, value?: {title?: {title?: unknown}}}>} */
  let results
  try {
    results = await sessionQuery.readTitleSnapshots(ids, signal)
  } catch {
    return titles // 空 catch 语义：只放弃抬头装饰，切片本身照常读
  }
  for (const result of results) {
    if (result?.status !== 'fulfilled') continue
    const title = result.value?.title?.title
    if (typeof result.sessionId === 'string' && typeof title === 'string' && title.length > 0) titles.set(result.sessionId, title)
  }
  return titles
}

/**
 * memory_observe scan 的读通道（闸一 ＋ 闸二 ＋ 预算记账）。
 * 闸一由 sessionScope 给出过滤条件（cwd 精确相等；无 cwd 只读自己）；闸二在
 * lib/observe.mjs 的事件过滤里；预算与截断在 buildObservationSlice 里。
 * sessionQuery 缺失时抛 SessionQueryUnavailableError——由工具层转成响亮降级
 * （ok:false ＋ 明确 code），绝不假装「没有历史」。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {{observe: {days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}, language: 'en'|'zh'}} live - 运行期可变值容器。
 * @param {{days?: unknown, sessions?: unknown, perSession?: unknown, messageChars?: unknown, totalChars?: unknown}} args - 模型入参（未钳制）。
 * @param {{agent?: {session?: MemorySessionLike | null} | null, signal: AbortSignal | undefined}} exec - 工具执行上下文（命令面传 {agent, signal}）。
 * @returns {Promise<{slice: import('./lib/observe.mjs').ObservationSlice, options: {days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}, clamped: Array<{key: string, requested: number, applied: number}>, selfOnly: boolean, unreadable: number}>} 切片与账单。
 */
async function scanObservationHistory(ctx, live, args, exec) {
  const sessionQuery = /** @type {SessionQueryLike | null | undefined} */ (ctx.get('sessionQuery'))
  if (sessionQuery === undefined || sessionQuery === null) throw new SessionQueryUnavailableError()
  const session = /** @type {MemorySessionLike | null | undefined} */ (exec.agent?.session ?? null)
  // F5：关了记忆的会话不观察。当下半边拒扫；历史半边由下面的选区过滤挡。
  const sessionId = /** @type {string | undefined} */ (session?.id)
  if (!/** @type {MemoryService} */ (ctx.get('memory')).store.sessionEnabled(sessionId)) throw new SessionMemoryOffError(sessionId)
  const now = Date.now()
  const { options, clamped } = resolveObserveOptions(/** @type {{[key: string]: unknown}} */ (args), live.observe)
  const scope = sessionScope({
    cwd: /** @type {string | undefined} */ (session?.header?.cwd),
    sessionId: typeof session?.id === 'string' ? session.id : undefined,
    days: options.days,
    now,
  })
  const records = await sessionQuery.filterSessions(scope.filters, exec.signal)
  // F5 选区过滤：已被关闭记忆的会话不进观察选区（规格 3.6 的历史半边）。
  // 先滤后截断——被滤掉的条数进账单的 scanned.skippedOff，绝不静默少看几个会话。
  const offIds = new Set(/** @type {MemoryService} */ (ctx.get('memory')).store.disabledSessionIds())
  const kept = records.filter((record) => !offIds.has(String(record?.header?.id ?? '')))
  const skippedOff = records.length - kept.length
  const selected = kept.slice(0, options.sessions)
  /** @type {string[]} */
  const ids = []
  for (const record of selected) {
    if (typeof record?.header?.id === 'string' && record.header.id.length > 0) ids.push(record.header.id)
  }
  const titles = await readObservationTitles(sessionQuery, ids, exec.signal)
  /** @type {Array<{sessionId: string, createdAt: number, title: string | null, events: unknown[]}>} */
  const snapshots = []
  let unreadable = 0
  for (const record of selected) {
    const sessionId = typeof record?.header?.id === 'string' ? record.header.id : ''
    if (sessionId.length === 0) continue
    /** @type {{session?: {createdAt?: unknown}, events?: unknown[]}} */
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(sessionId)
    } catch {
      unreadable += 1 // 空 catch 语义：单个会话读不动（损坏/迁移失败）不拖垮整次观察，但计数上报
      continue
    }
    const headerAt = record.header?.createdAt
    const createdAt = typeof headerAt === 'number' ? headerAt : (typeof snapshot?.session?.createdAt === 'number' ? snapshot.session.createdAt : 0)
    snapshots.push({ sessionId, createdAt, title: titles.get(sessionId) ?? null, events: Array.isArray(snapshot?.events) ? snapshot.events : [] })
  }
  // 服务端已按 newest-first 返回，这里再排一次是防御：顺序变了也不会把老会话当成最近。
  snapshots.sort((a, b) => b.createdAt - a.createdAt)
  const slice = buildObservationSlice(snapshots, options, now, OBSERVE_SLICE_LABELS[live.language] ?? OBSERVE_SLICE_LABELS.en, skippedOff)
  return { slice, options, clamped, selfOnly: scope.selfOnly, unreadable }
}

/** 工具结果里的观察条目投影（只带声明过的字段）。 */
function publicObservationEntry(/** @type {MemoryEntry} */ entry) {
  return {
    id: entry.id,
    text: entry.text,
    tags: entry.tags,
    ...(entry.facet === null || entry.facet === undefined ? {} : { facet: entry.facet }),
  }
}

/**
 * 把 scanObservationHistory 的产物投影成规范结果形状。
 * 工具面与命令面共用同一投影，于是「覆盖 / 未覆盖」的账单在两处逐字一致。
 * covered.from/to 为空时整键略去（output schema 是强校验的，不接受 null）。
 * @param {{slice: import('./lib/observe.mjs').ObservationSlice, clamped: Array<{key: string, requested: number, applied: number}>, selfOnly: boolean, unreadable: number}} result - scan 产物。
 * @returns {object} memory_observe 的 scan 规范值。
 */
function observationScanValue(result) {
  return {
    action: 'scan',
    ok: true,
    available: true,
    selfOnly: result.selfOnly,
    clamped: result.clamped,
    window: result.slice.window,
    budget: result.slice.budget,
    scanned: { ...result.slice.scanned, unreadable: result.unreadable },
    covered: {
      sessions: result.slice.covered.sessions,
      messages: result.slice.covered.messages,
      chars: result.slice.covered.chars,
      ...(result.slice.covered.from === null ? {} : { from: result.slice.covered.from }),
      ...(result.slice.covered.to === null ? {} : { to: result.slice.covered.to }),
    },
    uncovered: result.slice.uncovered,
    sessions: result.slice.picked.map((picked) => ({
      sessionId: picked.sessionId,
      ...(picked.title === null ? {} : { title: picked.title }),
      at: picked.at,
      messages: picked.messages,
    })),
    slice: result.slice.text,
  }
}

/**
 * memory_observe 工具（S4b）：观察通道的模型面入口。
 * scan 只读（sessionQuery 缺失时响亮降级）；commit 走 service.seed——写路径的
 * 审批门强制点在 MemoryProtocolCore 内部，工具层绕不过；source 锚死 'observation'
 * 不由模型传（审计链要能回答「这条是谁写的」）。参数在 Provider 层钳到 OBSERVE_LIMITS。
 * @param {MemoryService} service - ctx.memory。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文（查 sessionQuery）。
 * @param {{observe: {days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}, language: 'en'|'zh'}} live - 运行期可变值容器（热生效）。
 * @returns {object} 工具定义。
 */
export function makeMemoryObserveTool(service, ctx, live) {
  const language = live.language
  const description = MEMORY_OBSERVE_TOOL_DESCRIPTION[language] ?? MEMORY_OBSERVE_TOOL_DESCRIPTION.en
  const parameters = MEMORY_OBSERVE_TOOL_PARAMETERS[language] ?? MEMORY_OBSERVE_TOOL_PARAMETERS.en
  const entryShape = /** @type {const} */ ({
    type: 'object',
    additionalProperties: false,
    properties: {
      face: { type: 'string', required: true, enum: [...OBSERVATION_FACE_VALUES], description: parameters.entryFace },
      text: { type: 'string', required: true, description: parameters.entryText },
      evidence: { type: 'string', required: true, description: parameters.entryEvidence },
      confidence: { type: 'string', enum: ['高', '中', '低'], description: parameters.entryConfidence },
      facet: { type: 'string', enum: [...PROFILE_FACETS], description: parameters.entryFacet },
      tags: { type: 'array', items: { type: 'string' }, description: parameters.entryTags },
    },
  })
  return defineTool({
    name: 'memory_observe',
    description,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['scan', 'commit'],
        description: parameters.action,
      },
      days: { type: 'integer', description: parameters.days },
      sessions: { type: 'integer', description: parameters.sessions },
      perSession: { type: 'integer', description: parameters.perSession },
      messageChars: { type: 'integer', description: parameters.messageChars },
      totalChars: { type: 'integer', description: parameters.totalChars },
      entries: {
        type: 'array',
        items: entryShape,
        description: parameters.entries,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['scan', 'commit'] },
          ok: { type: 'boolean', required: true },
          available: { type: 'boolean' },
          selfOnly: { type: 'boolean' },
          clamped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                requested: { type: 'number', required: true },
                applied: { type: 'number', required: true },
              },
            },
          },
          window: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'integer', required: true },
              to: { type: 'integer', required: true },
            },
          },
          budget: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', required: true },
              used: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          scanned: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessions: { type: 'integer', required: true },
              read: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              injected: { type: 'integer', required: true },
              unreadable: { type: 'integer', required: true },
              skippedOff: { type: 'integer', required: true },
            },
          },
          covered: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessions: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              chars: { type: 'integer', required: true },
              from: { type: 'integer' },
              to: { type: 'integer' },
            },
          },
          uncovered: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessions: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              days: { type: 'integer', required: true },
            },
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                at: { type: 'integer', required: true },
                messages: { type: 'integer', required: true },
              },
            },
          },
          slice: { type: 'string' },
          added: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                facet: { type: 'string' },
              },
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              track: { type: 'string', required: true },
              scope: { type: 'string', required: true },
              used: { type: 'integer', required: true },
              limit: { type: 'integer', required: true },
            },
          },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              outcome: { type: 'string' },
              usage: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  track: { type: 'string', required: true },
                  scope: { type: 'string', required: true },
                  used: { type: 'integer', required: true },
                  limit: { type: 'integer', required: true },
                },
              },
              candidates: { type: 'integer' },
              sample: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: (/** @type {object} */ args, /** @type {object} */ value) => renderMemoryObserveResult(args, value, live.language),
    },
    execute: /** @type {(args: any, exec: any) => Promise<any>} */ (async (args, exec) => {
      exec.signal.throwIfAborted()
      const write = {
        agent: exec.agent,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        signal: exec.signal,
      }
      try {
        if (args.action === 'scan') {
          const result = await scanObservationHistory(ctx, live, args, exec)
          const session = exec.agent?.session
          if (typeof session?.id === 'string') {
            // 观察过的窗口留审计行：下次该从更早的窗口接着看（方案 3.2 的增量纪律）。
            service.store.auditAppend({
              action: 'observed',
              track: null,
              scope: null,
              entryId: null,
              text: `scan days=${result.options.days} window=${new Date(result.slice.window.from).toISOString()}..${new Date(result.slice.window.to).toISOString()} covered=${result.slice.covered.sessions}/${result.slice.scanned.sessions} session(s), ${result.slice.covered.messages} message(s), ${result.slice.budget.used}/${result.slice.budget.limit} chars${result.slice.budget.truncated ? ' (truncated)' : ''}`,
              outcome: 'ok',
              source: OBSERVATION_SOURCE,
              sessionId: session.id,
            })
          }
          return observationScanValue(result)
        }
        if (args.action === 'commit') {
          // 落库口径的唯一入口：facet/tags/source 在这里定死，模型只能给面、结论与证据。
          const entries = normalizeObservationEntries(args.entries, Date.now(), live.language)
          const result = await service.seed(entries, write)
          const used = service.budgets().find((row) => row.track === 'user' && row.scope === 'user-global')
          return {
            action: 'commit',
            ok: true,
            added: result.added,
            entries: result.entries.map(publicObservationEntry),
            ...(used === undefined ? {} : { usage: used }),
          }
        }
        throw new InvalidInputError(`unknown memory_observe action ${JSON.stringify(args.action)}`)
      } catch (error) {
        if (error instanceof MemoryError) {
          return {
            action: args.action,
            ok: false,
            ...(error instanceof SessionQueryUnavailableError ? { available: false } : {}),
            error: toToolError(error),
          }
        }
        throw error
      }
    }),
  })
}

/**
 * memory_observe 结果渲染（纯函数；language 选文案）。
 * 到顶必报「未覆盖」——本通道唯一的持续成本是切片进上下文，账必须让人看见。
 * @param {object} _args - 调用参数（未用）。
 * @param {object} value - 规范 JSON 结果。
 * @param {string} [language] - 'en' | 'zh'。
 * @returns {Array<{type: 'text', text: string}>} 模型可见文本。
 */
export function renderMemoryObserveResult(/** @type {object} */ _args, /** @type {any} */ value, language = 'en') {
  const zh = language === 'zh'
  if (!value.ok) {
    if (value.available === false) {
      return [{ type: 'text', text: zh
        ? `memory_observe ${value.action} 不可用：本 profile 未提供 session-query 服务，未读取任何历史。`
        : `memory_observe ${value.action} unavailable: this profile provides no session-query service; no history was read.` }]
    }
    return [{ type: 'text', text: `memory_observe ${value.action} failed: ${value.error.message}` }]
  }
  if (value.action === 'commit') {
    const rows = value.entries.map((/** @type {{text: string, tags: string[], facet?: string}} */ entry) => `- ${entry.text}`)
    const usage = value.usage === undefined ? '' : (zh
      ? `\n该层用量：${value.usage.track}/${value.usage.scope} ${value.usage.used}/${value.usage.limit}`
      : `\nlayer usage: ${value.usage.track}/${value.usage.scope} ${value.usage.used}/${value.usage.limit}`)
    return [{ type: 'text', text: `${zh
      ? `已写入 ${value.added} 条观察条目（source=observation；单次审批 ＋ 一次原子写）`
      : `wrote ${value.added} observation entr${value.added === 1 ? 'y' : 'ies'} (source=observation; one approval, one atomic write)`}\n${rows.join('\n')}${usage}` }]
  }
  const days = Math.round((value.window.to - value.window.from) / 86400000)
  const lines = [zh
    ? `观察切片（只读）：窗口 ${days} 天｜候选 ${value.scanned.sessions} 会话｜读到 ${value.scanned.messages} 条真人发言（挡下 ${value.scanned.injected} 条系统注入${value.scanned.unreadable > 0 ? `，${value.scanned.unreadable} 个会话读不动` : ''}${value.scanned.skippedOff > 0 ? `，${value.scanned.skippedOff} 个会话因记忆关闭被跳过` : ''}）`
    : `observation slice (read-only): ${days}-day window | ${value.scanned.sessions} candidate session(s) | ${value.scanned.messages} real user message(s) (${value.scanned.injected} injected pseudo message(s) filtered${value.scanned.unreadable > 0 ? `, ${value.scanned.unreadable} session(s) unreadable` : ''}${value.scanned.skippedOff > 0 ? `, ${value.scanned.skippedOff} session(s) skipped (memory off)` : ''})`]
  lines.push(zh
    ? `覆盖：${value.covered.sessions} 会话 / ${value.covered.messages} 条 / ${value.budget.used} 字符（预算 ${value.budget.limit}${value.budget.truncated ? '，已到顶' : '，未到顶'}）`
    : `covered: ${value.covered.sessions} session(s) / ${value.covered.messages} message(s) / ${value.budget.used} of ${value.budget.limit} chars${value.budget.truncated ? ' (budget reached)' : ''}`)
  if (value.uncovered.sessions > 0 || value.uncovered.days > 0) {
    lines.push(zh
      ? `未覆盖：${value.uncovered.sessions} 个会话 / ${value.uncovered.days} 天 / ${value.uncovered.messages} 条（这就是没看到的部分）`
      : `NOT covered: ${value.uncovered.sessions} session(s) / ${value.uncovered.days} day(s) / ${value.uncovered.messages} message(s) (that is what you did not see)`)
  }
  if (value.covered.messages === 0) {
    lines.push(zh
      ? '切片里没有可用证据：窗口内的发言要么是系统注入的伪发言，要么为空。'
      : 'the slice carries no usable evidence: everything in this window was an injected pseudo message, or empty.')
  }
  if (value.selfOnly === true) {
    lines.push(zh ? '本会话没有 cwd：只读当前会话自己，不跨会话。' : 'this session has no cwd: only the current session was read, never another.')
  }
  if (value.clamped.length > 0) {
    lines.push(zh
      ? `已钳制入参：${value.clamped.map((/** @type {{key: string, requested: number, applied: number}} */ c) => `${c.key} ${c.requested} → ${c.applied}`).join('、')}`
      : `arguments clamped: ${value.clamped.map((/** @type {{key: string, requested: number, applied: number}} */ c) => `${c.key} ${c.requested} → ${c.applied}`).join(', ')}`)
  }
  lines.push('', value.slice)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 补默认后的运行时配置（组合层与 settings 解析层同形）。
 * @typedef {object} MemoryRuntimeValues
 * @property {boolean} enabled
 * @property {string} dbPath
 * @property {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} budgets
 * @property {'ask'|'auto'|'off'} writePolicy
 * @property {Record<string, 'ask'|'auto'|'off'>} writePolicies
 * @property {'en'|'zh'} language
 * @property {number} snapshotOrder
 * @property {number} maxEntriesPerQuery
 * @property {number} commandListLimit
 * @property {number} commandAuditLimit
 * @property {{historyLimitDefault: number, snippetCap: number, snippetChars: number, windowDays: number, weighting: {heat: number, heatSaturation: number, heatHalfLifeDays: number, freshness: number, freshnessHalfLifeDays: number, tagDiscount: number}}} recall
 * @property {{days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}} observe
 * @property {{vector: boolean}} retrieval
 * @property {number} panelEntriesLimit
 * @property {number} panelAuditLimit
 * @property {number} auditRetentionDays
 * @property {{enabled: boolean, maxChars: number, maxPending: number}} proposals
 * @property {{enabled: boolean}} panel
 * @property {import('./lib/retrieval.mjs').RetrievalProvider | null} [retriever] - 当前检索器：keyword（默认）或 vector（vector 开启且探测到 embedding 时），非空；运行面非配置面。
 */
/**
 * 组合配置补默认（与 SettingsSchema 默认值同源，SHARED_CONFIG_FIELDS / DEFAULT_*）。
 * @param {PluginConfig} config - cordis loader 传入的插件配置。
 * @returns {MemoryRuntimeValues} 完整配置。
 */
function resolveComposed(config) {
  return {
    enabled: config.enabled ?? true,
    dbPath: config.dbPath ?? '',
    budgets: {
      user: {
        userGlobal: config.budgets?.user?.userGlobal ?? DEFAULT_BUDGETS.user.userGlobal,
        workspace: config.budgets?.user?.workspace ?? DEFAULT_BUDGETS.user.workspace,
      },
      agent: {
        userGlobal: config.budgets?.agent?.userGlobal ?? DEFAULT_BUDGETS.agent.userGlobal,
        workspace: config.budgets?.agent?.workspace ?? DEFAULT_BUDGETS.agent.workspace,
      },
    },
    writePolicy: /** @type {'ask'|'auto'|'off'} */ (config.writePolicy ?? 'ask'),
    writePolicies: /** @type {Record<string, 'ask'|'auto'|'off'>} */ (config.writePolicies ?? {}),
    language: config.language ?? 'en',
    snapshotOrder: config.snapshotOrder ?? DEFAULT_SNAPSHOT_ORDER,
    maxEntriesPerQuery: config.maxEntriesPerQuery ?? 20,
    commandListLimit: config.commandListLimit ?? 50,
    commandAuditLimit: config.commandAuditLimit ?? 10,
    recall: {
      historyLimitDefault: config.recall?.historyLimitDefault ?? 8,
      snippetCap: config.recall?.snippetCap ?? 5,
      snippetChars: config.recall?.snippetChars ?? 300,
      windowDays: config.recall?.windowDays ?? 30,
      weighting: {
        heat: config.recall?.weighting?.heat ?? RETRIEVAL_WEIGHTS.heat,
        heatSaturation: config.recall?.weighting?.heatSaturation ?? RETRIEVAL_WEIGHTS.heatSaturation,
        heatHalfLifeDays: config.recall?.weighting?.heatHalfLifeDays ?? RETRIEVAL_WEIGHTS.heatHalfLifeDays,
        freshness: config.recall?.weighting?.freshness ?? RETRIEVAL_WEIGHTS.freshness,
        freshnessHalfLifeDays: config.recall?.weighting?.freshnessHalfLifeDays ?? RETRIEVAL_WEIGHTS.freshnessHalfLifeDays,
        tagDiscount: config.recall?.weighting?.tagDiscount ?? RETRIEVAL_WEIGHTS.tagDiscount,
      },
    },
    observe: {
      days: config.observe?.days ?? DEFAULT_OBSERVE.days,
      sessions: config.observe?.sessions ?? DEFAULT_OBSERVE.sessions,
      perSession: config.observe?.perSession ?? DEFAULT_OBSERVE.perSession,
      messageChars: config.observe?.messageChars ?? DEFAULT_OBSERVE.messageChars,
      totalChars: config.observe?.totalChars ?? DEFAULT_OBSERVE.totalChars,
    },
    retrieval: {
      vector: config.retrieval?.vector ?? false,
    },
    panelEntriesLimit: config.panelEntriesLimit ?? 200,
    panelAuditLimit: config.panelAuditLimit ?? 20,
    auditRetentionDays: config.auditRetentionDays ?? 0,
    proposals: {
      enabled: config.proposals?.enabled ?? true,
      maxChars: config.proposals?.maxChars ?? 2000,
      maxPending: config.proposals?.maxPending ?? 8,
    },
    panel: { enabled: config.panel?.enabled ?? true },
  }
}

/**
 * 运行时值的业务校验（schema 之外的整数/枚举约束）。apply 加载期与 settings
 * namespace 的 validate hook 共用同一函数：面板保存非法值在写入路径即被拒绝，
 * 存量非法在注册路径响亮失败——绝不静默收下。
 * @param {MemoryRuntimeValues} values - 补默认后的完整配置。
 */
function validateMemoryConfig(values) {
  const budgetCheck = validateBudgets(values.budgets)
  if (!budgetCheck.ok) throw new InvalidInputError(`yammory_system config: ${/** @type {{message: string}} */ (budgetCheck).message}`)
  normalizeWritePolicy(values.writePolicy)
  validateWritePolicies(values.writePolicies)
  if (values.language !== 'en' && values.language !== 'zh') {
    throw new InvalidInputError(`yammory_system config: language must be 'en' or 'zh' (got ${JSON.stringify(values.language)})`)
  }
  if (!Number.isFinite(values.snapshotOrder)) {
    throw new InvalidInputError('yammory_system config: snapshotOrder must be a finite number')
  }
  if (!Number.isInteger(values.maxEntriesPerQuery) || values.maxEntriesPerQuery <= 0) {
    throw new InvalidInputError('yammory_system config: maxEntriesPerQuery must be a positive integer')
  }
  if (!Number.isInteger(values.commandListLimit) || values.commandListLimit <= 0) {
    throw new InvalidInputError('yammory_system config: commandListLimit must be a positive integer')
  }
  if (!Number.isInteger(values.commandAuditLimit) || values.commandAuditLimit <= 0) {
    throw new InvalidInputError('yammory_system config: commandAuditLimit must be a positive integer')
  }
  const { weighting, ...recallCounts } = values.recall
  for (const [key, value] of Object.entries(recallCounts)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new InvalidInputError(`yammory_system config: recall.${key} must be a positive integer`)
    }
  }
  for (const [key, value] of Object.entries(weighting)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new InvalidInputError(`yammory_system config: recall.weighting.${key} must be a non-negative finite number`)
    }
  }
  if (weighting.heatHalfLifeDays <= 0 || weighting.freshnessHalfLifeDays <= 0) {
    throw new InvalidInputError('yammory_system config: recall.weighting half-lives must be greater than 0')
  }
  for (const [key, value] of Object.entries(values.observe)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new InvalidInputError(`yammory_system config: observe.${key} must be a positive integer`)
    }
    const ceiling = /** @type {Record<string, number>} */ (OBSERVE_LIMITS)[key]
    if (value > ceiling) {
      throw new InvalidInputError(`yammory_system config: observe.${key} must not exceed the hard limit ${ceiling} (got ${value})`)
    }
  }
  if (!Number.isInteger(values.panelEntriesLimit) || values.panelEntriesLimit <= 0) {
    throw new InvalidInputError('yammory_system config: panelEntriesLimit must be a positive integer')
  }
  if (!Number.isInteger(values.panelAuditLimit) || values.panelAuditLimit <= 0) {
    throw new InvalidInputError('yammory_system config: panelAuditLimit must be a positive integer')
  }
  if (!Number.isInteger(values.auditRetentionDays) || values.auditRetentionDays < 0) {
    throw new InvalidInputError('yammory_system config: auditRetentionDays must be a non-negative integer')
  }
  if (!Number.isInteger(values.proposals.maxChars) || values.proposals.maxChars <= 0) {
    throw new InvalidInputError('yammory_system config: proposals.maxChars must be a positive integer')
  }
  if (!Number.isInteger(values.proposals.maxPending) || values.proposals.maxPending <= 0) {
    throw new InvalidInputError('yammory_system config: proposals.maxPending must be a positive integer')
  }
  if (values.panel !== undefined && typeof values.panel.enabled !== 'boolean') {
    throw new InvalidInputError('yammory_system config: panel.enabled must be a boolean')
  }
}

/**
 * 插件挂载。enabled:false 时不注册任何东西（工具/注入/服务/审批 answerer
 * 整体消失，不留半残状态）；库损坏/迁移失败/非法配置在加载期响亮抛错（S5）。
 * settings 服务可用时注册 yammory-system namespace：启动早于首会话的常态下，
 * 启动期字段（dbPath/snapshotOrder/auditRetentionDays/retrieval.vector）在
 * store 打开前就吃到用户层；热字段（writePolicy(s)/language/budgets/proposals/
 * 各 limit/panel）随 onChange 即时生效。服务缺失（headless）时行为与组合配置
 * 完全一致。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {object} config - 插件配置（cordis loader 已套 schema 默认值）。
 */
export function apply(ctx, /** @type {PluginConfig} */ config = {}) {
  const resolved = resolveComposed(config)
  if (resolved.enabled === false) return
  validateMemoryConfig(resolved)
  // 运行期可变值容器：settings onChange 维护；服务缺失时保持组合值。
  // F2 层 A：检索器默认非空（keyword）——memory_recall 的记忆段恒走检索器路径。
  let keywordRetriever = new KeywordRetriever({ weights: resolved.recall.weighting })
  /** @type {MemoryRuntimeValues} */
  const live = { ...resolved, retriever: keywordRetriever }
  /** @type {MemoryService | undefined} */
  let service
  let booted = false
  /** 当前 vector 检索器的注册 disposer（null = 未注册）。 */
  /** @type {(() => void) | null} */
  let vectorDisposer = null
  /** 当前解析值来源（settings 接线后指向 namespace scope）。 */
  /** @type {() => MemoryRuntimeValues} */
  let source = () => resolved
  const onChange = () => {
    const next = source()
    try {
      validateMemoryConfig(next)
    } catch (error) {
      // 注册路径已挡存量非法；这里是运行期防御：保持旧值并审计留痕。
      if (booted && service !== undefined) {
        service.store.auditAppend({
          action: 'settings-rejected',
          track: null,
          scope: null,
          entryId: null,
          text: error instanceof Error ? error.message : String(error),
          outcome: 'error',
          source: DEFAULT_SOURCE,
          sessionId: null,
        })
      }
      return
    }
    if (!booted) {
      // 真 cordis 下 inject 回调恒为异步 fiber（apply 同步段先完成），此分支
      // 仅在理论同步时序下触达：吸收解析值，启动期字段由下方 booted 路径统一处理。
      Object.assign(live, next)
      return
    }
    // 启动期字段差异逐项检测（比较须在 Object.assign 前，用旧 live 值）。
    /** @type {string[]} */
    const applied = []
    /** @type {string[]} */
    const reloadRequired = []
    if (service !== undefined) {
      if (next.dbPath !== live.dbPath || next.auditRetentionDays !== live.auditRetentionDays) {
        // dbPath / auditRetentionDays：重开 store（早期时序=首启应用用户层；运行期=热切换）。
        const reopened = openMemoryStore(resolveDbPath(next.dbPath), { retentionDays: next.auditRetentionDays })
        const previous = service.store
        service.store = reopened
        store = reopened
        try {
          previous.close()
        } catch {
          // 旧库关闭失败不阻断新库服务：句柄随进程退出释放（WAL 安全）。
        }
        applied.push('dbPath/auditRetentionDays')
      }
      if (next.retrieval.vector !== live.retrieval.vector) {
        // retrieval.vector：拆旧检索器，按新值重装（探测不到 embedding 时回落 keyword）。
        if (vectorDisposer !== null) {
          vectorDisposer()
          vectorDisposer = null
        }
        live.retriever = keywordRetriever
        if (next.retrieval.vector === true) {
          const retriever = buildVectorRetriever(embeddings)
          if (retriever !== null) {
            vectorDisposer = ctx.effect(() => retrievers.register(retriever), 'yammory_system.retrieval.vector')
            live.retriever = retriever
          }
        }
        applied.push('retrieval.vector')
      }
      if (weightingChanged(next.recall.weighting, live.recall.weighting)) {
        // recall.weighting：加权表是检索器的构造参数，故重建 keyword 检索器（vector 在用则不动它）。
        const wasKeyword = live.retriever === keywordRetriever
        keywordRetriever = new KeywordRetriever({ weights: next.recall.weighting })
        if (wasKeyword) live.retriever = keywordRetriever
        applied.push('recall.weighting')
      }
      if (next.snapshotOrder !== live.snapshotOrder) {
        // snapshotOrder：systemPrompt section 注册期固定，无法热重挂——响亮留痕。
        reloadRequired.push('snapshotOrder')
      }
    }
    Object.assign(live, next)
    if (service !== undefined) {
      service.budgetsConfig = next.budgets
      service.writePolicy = normalizeWritePolicy(next.writePolicy)
      service.defaultQueryLimit = next.maxEntriesPerQuery
      service.commandListLimit = next.commandListLimit
      service.commandAuditLimit = next.commandAuditLimit
      service.language = next.language
    }
    if ((applied.length > 0 || reloadRequired.length > 0) && service !== undefined) {
      // 启动期字段变更：响亮留痕，绝不静默。
      service.store.auditAppend({
        action: 'settings-startup-fields',
        track: null,
        scope: null,
        entryId: null,
        text: `applied: ${applied.length > 0 ? applied.join(', ') : 'none'}; reload required: ${reloadRequired.length > 0 ? reloadRequired.join(', ') : 'none'}`,
        outcome: 'ok',
        source: DEFAULT_SOURCE,
        sessionId: null,
      })
    }
  }
  ctx.inject(['settings'], (sctx) => {
    // 官方安装 API 的双发布线取用。dsh-settings 有两条发布线：宿主内置副本
    // （0.1.1-rc.1 形状，npm 未发布该形状）导出模块级 installSettingsSection；
    // npm 发布线（alpha.3/alpha.4）把同能力放在 SettingsProvider 类方法
    // installSection。两条线各自都是官方接口，这里只做形状分派，不自造机制。
    /** @typedef {{setSource: (fn: () => MemoryRuntimeValues) => void, onChange: () => void, validate: (value: object) => void}} SettingsInstallHooks */
    /** @type {SettingsInstallHooks} */
    const hooks = {
      setSource: (/** @type {() => MemoryRuntimeValues} */ fn) => { source = fn },
      onChange,
      validate: (/** @type {object} */ value) => validateMemoryConfig(/** @type {MemoryRuntimeValues} */ (value)),
    }
    // 两副本的导出面在 checkJs 下类型不全，统一经 unknown 中转读属性。
    const settingsModule = /** @type {Record<string, unknown>} */ (dshSettings)
    const moduleInstall = /** @type {null | ((ctx: object, ns: string, schema: object, entry: object, hooks: SettingsInstallHooks) => void)} */ (settingsModule.installSettingsSection ?? null)
    if (moduleInstall !== null) {
      moduleInstall(sctx, SETTINGS_NAMESPACE, SettingsSchema, resolved, hooks)
      return
    }
    const settingsService = /** @type {Record<string, unknown>} */ (/** @type {{settings: unknown}} */ (/** @type {unknown} */ (sctx)).settings)
    // 方法须以 settingsService 为 receiver 调用（属性链调用），脱钩会丢 this。
    const providerInstall = /** @type {(owner: object, ns: string, schema: object, entry: object, hooks: SettingsInstallHooks) => void} */ (settingsService.installSection)
    providerInstall.call(settingsService, ctx, SETTINGS_NAMESPACE, SettingsSchema, resolved, hooks)
  })
  booted = true
  let store = openMemoryStore(resolveDbPath(resolved.dbPath), { retentionDays: resolved.auditRetentionDays })
  service = new MemoryService({
    store,
    budgets: live.budgets,
    writePolicy: live.writePolicy,
    maxEntriesPerQuery: live.maxEntriesPerQuery,
    commandListLimit: live.commandListLimit,
    commandAuditLimit: live.commandAuditLimit,
    language: live.language,
    approval: ctx.approval,
    sourceLabel: DEFAULT_SOURCE,
  })

  ctx.provide('memory', service)
  ctx.effect(() => () => store.close(), 'yammory_system.store.close')

  // 协议 v1 适配器注册表（ctx.memoryAdapters）：第三方记忆插件可 register() 自己的
  // 适配器把外部 store 接进协议。注册可逆（register 返回 disposer，经 ctx.effect 随
  // 插件生命周期自动回收）；内置参考适配器（mem0 / Hermes / CLAUDE.md）同生命周期。
  const adapters = new MemoryAdapterRegistry()
  ctx.provide('memoryAdapters', adapters)
  for (const adapter of REFERENCE_ADAPTERS) {
    ctx.effect(() => adapters.register(adapter), `yammory_system.adapter.${adapter.id}`)
  }

  // embedding Provider seam（ctx.memoryEmbedding）：注册表 + 默认确定性伪嵌入
  // Provider（零依赖，接口级演示；真实嵌入由可选 provider 注册）。register 可逆，
  // 经 ctx.effect 随插件生命周期自动回收。
  const embeddings = new EmbeddingProviderRegistry()
  ctx.provide('memoryEmbedding', embeddings)
  ctx.effect(() => embeddings.register(new FakeEmbeddingProvider()), 'yammory_system.embedding.fake-hash')

  // retrieval Provider seam（ctx.memoryRetrieval）：keyword 检索器（零依赖主路径，
  // F2 层 A：分词 + 多词召回 + 相关度排序）承接 memory_recall 默认路径（live.retriever
  // 初值即 keyword）；substring 检索器仍注册供对照 / MCP / 第三方显式选用；vector 仅当
  // Config.retrieval.vector=true 且探测到 embedding provider 时换装，否则回落 keyword。
  // 装配走 buildVectorRetriever + 调用方注册：settings 回调可在运行期拆旧装新。
  const retrievers = new RetrievalProviderRegistry()
  ctx.provide('memoryRetrieval', retrievers)
  ctx.effect(() => retrievers.register(new SubstringRetriever()), 'yammory_system.retrieval.substring')
  if (live.retrieval.vector === true) {
    const initialRetriever = buildVectorRetriever(embeddings)
    if (initialRetriever !== null) {
      vectorDisposer = ctx.effect(() => retrievers.register(initialRetriever), 'yammory_system.retrieval.vector')
      live.retriever = initialRetriever
    }
  }

  // 审批 answerer：认领本插件的记忆写请求并按粒度策略裁决（writePolicies 精确键 >
  // track/scope > 全局 writePolicy；prepend 保证 auto/off 的确定性先于 UI answerer；
  // 会话级 never 策略在审批服务内部先裁决，任何 answerer 都无法绕过）。
  ctx.on('approval/request', async function answerer(req, next) {
    if (!isMemoryWriteRequest(req)) return next()
    const parsed = parseWriteReason(/** @type {string} */ (/** @type {{reason: string}} */ (req).reason))
    const effective = parsed === null
      ? live.writePolicy
      : resolveWritePolicy(live.writePolicies, live.writePolicy, parsed.track, parsed.scope, parsed.source)
    return applyWritePolicy(effective, req, next)
  }, { prepend: true })

  ctx.tools.register(/** @type {import('@deepseek-ai/dsh-tools').ToolDefinition} */ (makeMemoryTool(service, resolved.language)))
  ctx.tools.register(/** @type {import('@deepseek-ai/dsh-tools').ToolDefinition} */ (makeMemoryProfileTool(service, resolved.language)))
  ctx.tools.register(/** @type {import('@deepseek-ai/dsh-tools').ToolDefinition} */ (makeMemoryObserveTool(service, ctx, live)))

  // 预热段注入（分路注入的「普遍相关」半边）：会话首个 assemble 时同步读库渲染，
  // WeakMap 按 Session 冻结——冻结机制与 memento 原语义一致，变的只是内容构成：
  // 【表达约束】（profile 表分领域水平 → 四档说话要求）+【常驻画像】（user 轨
  // scope=user-global 条目）。工作区相关与 agent 轨记忆不进预热，走 memory_recall
  // 按需取。提供者必须同步（rc.6 不 await systemPrompt 提供者），SQLite 同步读满足。
  // 渲染文本同时进入 request/header（system 字段）→ 可自会话日志重建（S2）。
  const snapshots = new WeakMap()
  ctx.systemPrompt.section({
    name: 'yammory_system:memory',
    order: live.snapshotOrder,
    text: (assemble) => {
      // rc.6 实测路径：assemble 携带 agent（AssembleContext 声明面未含该字段），收窄处理。
      const context = /** @type {{agent?: {session?: MemorySessionLike | null} | null} | null | undefined} */ (assemble)
      const agent = context?.agent
      const session = agent?.session
      if (session === undefined || session === null) return ''
      // F5 会话级开关：关掉即停注入。开关优先于会话内冻结——已冻结的段立刻失效，
      // 本会话后续 assemble 一律返回空段，且不落 snapshot 审计（关了就不再留痕）。
      if (!store.sessionEnabled(session.id)) {
        snapshots.delete(session)
        return ''
      }
      let frozen = snapshots.get(session)
      if (frozen === undefined) {
        const workspaceKey = workspaceKeyOf(/** @type {string | undefined} */ (session.header?.cwd))
        const agentKey = agentKeyOf(/** @type {string | undefined} */ (session.header?.agentPreset))
        const entries = visibleEntries(
          /** @type {Array<{id: string, track: string, scope: string, workspaceKey: string, agentKey: string, text: string, createdAt: number}>} */ (store.listEntries()),
          workspaceKey,
          agentKey,
        )
        // store.profileList() 的声明返回面是 object[]（Provider 层不引渲染形状）；此处按
        // 渲染契约收窄——渲染函数自己会再滤一遍脏行。
        const profileRows = /** @type {Array<{domain: string, level: number}>} */ (store.profileList())
        const proposals = visibleProposals(
          /** @type {MemoryProposal[]} */ (store.proposalList('pending', live.proposals.maxPending)),
          workspaceKey,
          agentKey,
        )
        frozen = renderWarmup(
          /** @type {Array<{id: string, track: string, scope: string, workspaceKey: string, agentKey: string, text: string, createdAt: number}>} */ (entries),
          profileRows,
          live.budgets,
          live.language,
          proposals,
        )
        // F6-3：过开工线时在预热段末行提示「该整理了」（只读算一次积压；绝不自动跑整理，
        // 那会成会话日志外的黑箱）。空块不硬塞提示——那种情况下可见集本来就是空的。
        const backlog = readTidyBacklog(store)
        if (backlog.due && frozen.length > 0) {
          frozen = `${frozen}\n\n${(WARMUP_TIDY_HINT[live.language] ?? WARMUP_TIDY_HINT.en)(backlog)}`
        }
        // 收边 §2：用户点过的「整理全库」标记存在时，在同一处（末行）追加排队提示。
        // 这一行不受「空块不硬塞」限制——它是用户点过的动作，模型必须看见；块因此非空时
        // 也照常落 snapshot 审计行（模型可见 ⟺ 落盘）。
        const queuedTidy = store.tidyRequestPending()
        if (queuedTidy !== null) {
          frozen = `${frozen}${frozen.length > 0 ? '\n\n' : ''}${WARMUP_TIDY_REQUEST[live.language] ?? WARMUP_TIDY_REQUEST.en}`
        }
        snapshots.set(session, frozen)
        store.auditAppend({
          action: 'snapshot',
          track: null,
          scope: null,
          entryId: null,
          text: frozen,
          outcome: 'ok',
          source: DEFAULT_SOURCE,
          sessionId: /** @type {string | null} */ (session.id ?? null),
        })
        maybeAppendSessionEvent(session, SESSION_EVENTS.snapshot, {
          text: frozen,
          workspaceKey,
          at: Date.now(),
        })
      }
      return frozen
    },
  })

  // V2 观察面：/memory 命令（用户触发）、memory_recall 工具、面板 JSON 路由。
  // commands/webServer 为可选服务，缺失（headless）自动跳过。
  registerCommands(ctx, service, live)
  ctx.tools.register(/** @type {import('@deepseek-ai/dsh-tools').ToolDefinition} */ (makeMemoryRecallTool(service, ctx, live)))
  registerWebRoutes(ctx, service, live)

  // auto-capture：监听会话事件火线，压缩结束后生成记忆提案（只落提案，不写记忆、不调模型）。
  const summaries = new WeakMap()
  ctx.on('session/event', (session, event) => {
    handleSessionEvent(store, session, event, live.proposals, summaries)
  })

  // F6-3 整理机的触发检测：挂在 agent/turn-stopping，**只读**算一次积压（O(n)，无模型、
  // 无定时器、不自动跑整理——自动跑会成会话日志外的黑箱）。过线时留一行审计提示，
  // 同进程内节流到 TIDY_NOTICE_INTERVAL，免得每轮都刷；下一次会话的预热段末行同样会提示。
  // 该事件是串行派发：监听器抛错会以错误结束该轮，故整体吞住异常（吞的是只读检查的失败）。
  const tidyNotice = { at: 0 }
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const sessionId = /** @type {{agent?: {session?: MemorySessionLike | null} | null} | undefined} */ (payload)?.agent?.session?.id
      // 会话关了记忆就不碰：提示也是记忆机制的一部分。
      if (!store.sessionEnabled(sessionId)) return
      const backlog = readTidyBacklog(store)
      if (!backlog.due) return
      const now = Date.now()
      if (now - tidyNotice.at < TIDY_NOTICE_INTERVAL) return
      tidyNotice.at = now
      store.auditAppend({
        action: 'tidy-due',
        track: null,
        scope: null,
        entryId: null,
        text: `backlog ${backlog.count} entr${backlog.count === 1 ? 'y' : 'ies'} / ${backlog.chars} chars since the last consolidation (line: ${backlog.reason}); run /memory tidy for the plan, or say "tidy my memory" to let the model merge`,
        outcome: 'over-line',
        source: DEFAULT_SOURCE,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
      })
    } catch {
      // 只读检查绝不能让一轮对话失败（turn-stopping 串行派发，抛错会以错误收尾本轮）。
    }
  })
}

/**
 * 加权表是否变了（逐键比；缺任一侧即视为变了）。
 * @param {{heat: number, heatSaturation: number, heatHalfLifeDays: number, freshness: number, freshnessHalfLifeDays: number, tagDiscount: number} | undefined} next - 新表。
 * @param {{heat: number, heatSaturation: number, heatHalfLifeDays: number, freshness: number, freshnessHalfLifeDays: number, tagDiscount: number} | undefined} current - 当前表。
 * @returns {boolean} 变了为 true。
 */
function weightingChanged(next, current) {
  if (next === undefined || current === undefined) return true
  return next.heat !== current.heat
    || next.heatSaturation !== current.heatSaturation
    || next.heatHalfLifeDays !== current.heatHalfLifeDays
    || next.freshness !== current.freshness
    || next.freshnessHalfLifeDays !== current.freshnessHalfLifeDays
    || next.tagDiscount !== current.tagDiscount
}

/**
 * 构造 vector 检索器：探测到**语义**嵌入 provider 才构造并返回；否则返回 null
 * （vector 是可选后端，缺语义 provider 不构成配置错误——回落 keyword）。注册由调用方经
 * ctx.effect 管理——settings 回调需要在运行期拆旧装新。
 * @param {import('./lib/embedding.mjs').EmbeddingProviderRegistry} embeddings - 嵌入注册表。
 * @returns {import('./lib/retrieval.mjs').RetrievalProvider | null} vector 检索器或 null（降级）。
 */
function buildVectorRetriever(embeddings) {
  // 只认声明为语义的 provider（规格 3.3·层 B 收口）：伪嵌入对中文几乎必零命中，
  // 放它进来等于用一个名为「语义召回」的开关**静默关掉召回**——那正是本项目的红线。
  const embedding = embeddings.firstSemantic()
  const probe = detectVectorBackend({ embedding })
  if (!probe.available) return null
  return new VectorRetriever({ embedding })
}

/**
 * auto-capture 提案生成：缓存每会话最近的 compaction/summary 文本，compaction/end
 * 成功时截断落 proposals 表（(session_id, kind) 幂等；pending 满则弃新）。
 * 本函数不调用任何模型、不写任何记忆条目、不触碰审批 seam——提案是待审批数据。
 * @param {StoreHandle} store - Provider。
 * @param {MemorySessionLike | null | undefined} session - 会话。
 * @param {unknown} event - 会话事件（{type, data}）。
 * @param {{enabled: boolean, maxChars: number, maxPending: number}} proposals - Config.proposals。
 * @param {WeakMap<object, string>} summaries - 会话 → 最近 summary 文本缓存。
 */
function handleSessionEvent(store, session, event, proposals, summaries) {
  if (!proposals.enabled || session === null || session === undefined) return
  if (event === null || typeof event !== 'object') return
  const record = /** @type {{type?: unknown, data?: unknown}} */ (event)
  if (record.type === 'compaction/summary') {
    const text = extractEventText(event)
    if (text.length > 0) summaries.set(session, text)
    return
  }
  if (record.type !== 'compaction/end') return
  const data = record.data
  const error = data !== null && typeof data === 'object' ? /** @type {{error?: unknown}} */ (data).error : undefined
  if (typeof error === 'string' && error.length > 0) return
  const text = summaries.get(session)
  summaries.delete(session)
  if (typeof text !== 'string' || text.length === 0) return
  const pending = /** @type {MemoryProposal[]} */ (store.proposalList('pending', proposals.maxPending))
  if (pending.length >= proposals.maxPending) return // 满则弃新
  const truncated = text.length > proposals.maxChars ? text.slice(0, proposals.maxChars) : text
  const proposal = store.proposalUpsert({
    kind: 'compaction-summary',
    track: 'agent',
    scope: 'workspace',
    workspaceKey: workspaceKeyOf(/** @type {string | undefined} */ (session.header?.cwd)),
    agentKey: agentKeyOf(/** @type {string | undefined} */ (session.header?.agentPreset)),
    text: truncated,
    source: 'compaction',
    sessionId: typeof session.id === 'string' ? session.id : '',
  })
  if (proposal === null) return // 同 session 已提案（幂等）
  const created = /** @type {MemoryProposal} */ (proposal)
  store.auditAppend({
    action: 'proposal',
    track: 'agent',
    scope: 'workspace',
    entryId: created.id,
    text: truncated,
    outcome: 'pending',
    source: 'compaction',
    sessionId: typeof session.id === 'string' ? session.id : null,
  })
}

// ── V2 观察面 ────────────────────────────────────────────────────────────────

/**
 * 可选服务就绪即调用（服务缺失时跳过，不保持 PENDING）。apply 时已存在则
 * 立即调用；否则订阅 internal/service 事件，服务出现时再调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {string} serviceName - 服务名。
 * @param {(service: unknown) => void} fn - 就绪回调。
 */function withService(ctx, serviceName, fn) {
  const existing = ctx.get(serviceName)
  if (existing !== undefined && existing !== null) {
    fn(existing)
    return
  }
  const off = ctx.on('internal/service', (name) => {
    if (name !== serviceName) return
    const service = ctx.get(serviceName)
    if (service !== undefined && service !== null) {
      off()
      fn(service)
    }
  })
}

/**
 * turn 外的写审批门（/memory 命令用）。走同一 approval/request waterfall 与
 * 同一 answerer 链（writePolicy 在此应用）；与 turn 内路径的差异：审批服务
 * 的 approval/asked + approval/decided 审计对要求 open turn，turn 外无审计
 * 对可落——审计由插件审计表 + command/done 承担。会话级 never 策略在派发前
 * 由本函数按公开 API 预检（与审批服务同语义）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {{agent?: {session?: MemorySessionLike | null} | null}} write - {agent}。
 * @returns {(payload: WritePayload) => Promise<string>} gate 函数。
 */
function makeCommandGate(ctx, write) {
  return trustWriteGate(async (payload) => {
    const approval = ctx.approval
    const session = write.agent?.session
    const sessionPolicy = typeof approval?.overrideOf === 'function' && session !== undefined
      ? approval.overrideOf(session)
      : undefined
    const effective = sessionPolicy ?? approval?.config?.policy ?? 'ask'
    if (effective === 'never') {
      return 'rejected' // 会话级 never 不可绕过（与审批服务同语义的预检）
    }
    return ctx.waterfall('approval/request', {
      agent: write.agent,
      toolName: TOOL_NAME,
      reason: buildWriteReason(payload),
    }, async () => 'unavailable')
  })
}

const COMMAND_DESCRIPTION = /** @type {{en: {description: string, hint: string}, zh: {description: string, hint: string}}} */ ({
  en: {
    description: 'View/manage yammory_system memory: list | query <word> | add [--track=user|agent] [--scope=user-global|workspace] <text> | remove <substring> | consolidate <substring...> => <new text> | restore <id...> | arbitrate <id...> | tidy [--days=N] (read-only tidy plan) | stats (the three observability numbers) | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <path> | observe [--days=N] | session [on|off]',
    hint: 'list | query <word> | add <text> | remove <substring> | consolidate <substring...> => <new text> | restore <id...> | arbitrate <id...> | tidy [--days=N] | stats | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <path> | observe [--days=N] | session [on|off]',
  },
  zh: {
    description: '查看/管理 yammory_system 记忆：list | query <词> | add [--track=user|agent] [--scope=user-global|workspace] <文本> | remove <唯一子串> | consolidate <唯一子串...> => <新文本> | restore <id...> | arbitrate <id...> | tidy [--days=N]（只读整理计划） | stats（可观测三数） | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <路径> | observe [--days=N] | session [on|off]',
    hint: 'list | query <词> | add <文本> | remove <唯一子串> | consolidate <唯一子串...> => <新文本> | restore <id...> | arbitrate <id...> | tidy [--days=N] | stats | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <路径> | observe [--days=N] | session [on|off]',
  },
})

/**
 * 注册 /memory 命令（用户触发，非模型回合）。列出/查询/预算/审计/导出直接读；
 * add/remove/consolidate 走 turn 外审批门（同一 waterfall + writePolicy）。命令缺失的
 * profile（headless）自动跳过。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {MemoryService} service - ctx.memory。
 * @param {{observe: {days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}, language: 'en'|'zh'}} [live] - 运行期可变值容器（observe 子命令读热值）。
 */
export function registerCommands(ctx, service, live) {
  withService(ctx, 'commands', (/** @type {{register?: (def: object) => unknown} | null | undefined} */ commands) => {
    if (typeof commands?.register !== 'function') return
    const meta = COMMAND_DESCRIPTION[service.language] ?? COMMAND_DESCRIPTION.en
    commands.register({
      name: 'memory',
      description: meta.description,
      input: { hint: meta.hint },
      handler: async (/** @type {{rawInput?: unknown, agent?: unknown, signal?: AbortSignal}} */ invocation) => handleMemoryCommand(ctx, service, invocation, live),
    })
  })
}

/**
 * /memory 命令处理器（导出供测试；自身捕获领域错误，返回规范结果）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {MemoryService} service - ctx.memory。
 * @param {object} invocation - {rawInput, agent, signal}。
 * @param {{observe: {days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}, language: 'en'|'zh'}} [live] - 运行期可变值容器（observe 子命令读热值；缺省回退默认值）。
 * @returns {Promise<{kind: 'success'|'error', text: string}>}。
 */
export async function handleMemoryCommand(ctx, service, /** @type {{rawInput?: unknown, agent?: {session?: MemorySessionLike | null} | null, signal?: AbortSignal}} */ invocation, live) {
  try {
    return await runMemoryCommand(ctx, service, invocation, live)
  } catch (error) {
    const text = COMMAND_TEXT[service.language] ?? COMMAND_TEXT.en
    if (error instanceof MemoryError) return { kind: 'error', text: `memory ${String(error.code)}: ${error.message}` }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: text.commandFailed(message) }
  }
}

/**
 * handleMemoryCommand 的裸实现（错误由外层包装）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {MemoryService} service - ctx.memory。
 * @param {{rawInput?: unknown, agent?: {session?: MemorySessionLike | null} | null, signal?: AbortSignal}} invocation - {rawInput, agent, signal}。
 * @param {{observe: {days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}, language: 'en'|'zh'}} [live] - 运行期可变值容器。
 * @returns {Promise<{kind: 'success' | 'error', text: string}>}。
 */
async function runMemoryCommand(ctx, service, invocation, live) {
  const text = COMMAND_TEXT[service.language] ?? COMMAND_TEXT.en
  // F6/F7 新增两个动词；动词表与文案住在 TIDY_TEXT（§3 未点名 lib/strings.mjs，
  // 故这里只往既有 usage/unknownVerb 文本尾部追加动词，不动那份词表）。
  const extraVerbs = (TIDY_TEXT[service.language] ?? TIDY_TEXT.en).verbs
  const raw = String(invocation?.rawInput ?? '').trim()
  const [verb, ...rest] = raw.split(/\s+/)
  if (verb === undefined || verb.length === 0) {
    return { kind: 'success', text: `${text.usage}${extraVerbs}` }
  }
  switch (verb) {
    case 'list': {
      const { entries, total, truncated } = service.query(
        { limit: service.commandListLimit },
        { sessionId: /** @type {string | undefined} */ (invocation?.agent?.session?.id), session: invocation?.agent?.session },
      )
      if (total === 0) return { kind: 'success', text: text.memoryEmpty }
      const header = truncated ? text.entries(total, entries.length) : text.entriesFull(total)
      return { kind: 'success', text: `${header}\n${entries.map(renderEntryLine).join('\n')}` }
    }
    case 'query': {
      // F5：模型按需查库与 memory_recall 同档——关了记忆，本会话的查库一律拒；
      // /memory list|budgets|audit 等管理面只读不受影响。
      if (!service.store.sessionEnabled(invocation?.agent?.session?.id)) return { kind: 'error', text: text.sessionOffRead }
      const query = rest.join(' ')
      if (query.length === 0) return { kind: 'error', text: text.queryNeedsWord }
      const { entries, total, truncated } = service.query(
        { text: query, limit: service.commandListLimit },
        { sessionId: /** @type {string | undefined} */ (invocation?.agent?.session?.id), session: invocation?.agent?.session },
      )
      if (total === 0) return { kind: 'success', text: text.noMatch(query) }
      const header = truncated ? text.matches(total, entries.length) : text.matchesFull(total)
      return { kind: 'success', text: `${header}\n${entries.map(renderEntryLine).join('\n')}` }
    }
    case 'budgets': {
      const rows = service.budgets()
      return { kind: 'success', text: `${text.budgets}\n${rows.map((/** @type {{track: string, scope: string, used: number, limit: number}} */ row) => `- ${row.track}/${row.scope}: ${row.used}/${row.limit}`).join('\n')}` }
    }
    case 'proposals': {
      const [sub, id] = rest
      if (sub === undefined) {
        const rows = /** @type {MemoryProposal[]} */ (service.store.proposalList('pending', 50))
        if (rows.length === 0) return { kind: 'success', text: text.proposalsNone }
        const lines = rows.map((proposal) => `- [${proposal.id}] ${proposal.track}/${proposal.scope}: ${proposal.text.length > 120 ? `${proposal.text.slice(0, 120)}…` : proposal.text}`).join('\n')
        return { kind: 'success', text: text.proposalsList(rows.length, lines) }
      }
      if (id === undefined) return { kind: 'error', text: text.proposalsUsage }
      if (sub === 'approve') {
        const proposal = /** @type {MemoryProposal | null} */ (service.store.proposalList('pending', 1000).find((/** @type {MemoryProposal} */ candidate) => candidate.id === id) ?? null)
        if (proposal === null) {
          return { kind: 'error', text: text.proposalNotPending(id) }
        }
        const result = await service.add(
          { track: proposal.track, scope: proposal.scope, text: proposal.text, source: 'proposal', workspaceKey: proposal.workspaceKey, agentKey: proposal.agentKey },
          { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) },
        )
        try {
          service.store.proposalDecide(id, 'approved')
        } catch (error) {
          // 并发裁决（面板/另一命令已 approve/dismiss）：写已成功，别用提案状态错误掩盖它。
          if (!(error instanceof ProposalNotFoundError)) throw error
        }
        return { kind: 'success', text: text.proposalApproved(proposal.track, proposal.scope, result.entry.text, result.usage.used, result.usage.limit) }
      }
      if (sub === 'dismiss') {
        service.store.proposalDecide(id, 'dismissed')
        return { kind: 'success', text: text.proposalDismissed(id) }
      }
      return { kind: 'error', text: text.proposalsUsage }
    }
    case 'audit': {
      const rows = service.store.auditList(service.commandAuditLimit)
      if (rows.length === 0) return { kind: 'success', text: text.auditEmpty }
      return { kind: 'success', text: `${text.audit(rows.length)}\n${rows.map((/** @type {{ts: number, action: string, track?: string | null, scope?: string | null, outcome?: string | null, source?: string | null}} */ row) => `- ${new Date(row.ts).toISOString()} ${row.action}${row.track ? ` ${row.track}/${row.scope}` : ''} ${row.outcome ?? ''} (${row.source ?? ''})`.trim()).join('\n')}` }
    }
    case 'adapters': {
      const registry = adapterRegistryOf(ctx)
      if (registry === null) return { kind: 'error', text: text.adapterServiceMissing }
      const list = registry.list()
      if (list.length === 0) return { kind: 'success', text: text.adaptersEmpty }
      const rows = list.map((adapter) => `- ${adapter.id} (${adapter.name}, v${adapter.version}): ${adapter.description}\n  import: ${adapter.importFormats.join(', ')}; export: ${adapter.exportFormat}`)
      return { kind: 'success', text: text.adaptersList(list.length, rows.join('\n')) }
    }
    case 'export': {
      const parsed = parseAdapterFlag(rest)
      if (parsed.flagSeen) {
        if (parsed.adapterId === undefined) return { kind: 'error', text: text.adapterBadFlag }
        const registry = adapterRegistryOf(ctx)
        if (registry === null) return { kind: 'error', text: text.adapterServiceMissing }
        const payload = registry.export(parsed.adapterId, service.store.listEntries())
        return { kind: 'success', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }
      }
      if (rest.length > 0) return { kind: 'error', text: text.exportUsage }
      const entries = service.store.listEntries()
      const payload = {
        plugin: 'dsh-memento',
        schema: EXPORT_SCHEMA,
        exportedAt: new Date().toISOString(),
        budgets: service.budgets(),
        entries: entries.map((/** @type {MemoryEntry} */ entry) => ({
          id: entry.id,
          track: entry.track,
          scope: entry.scope,
          workspaceKey: entry.workspaceKey,
          agentKey: entry.agentKey,
          text: entry.text,
          source: entry.source,
          tags: entry.tags,
          // 画像坐标随条目一起导出（红队②中 4）：漏掉 facet/level 的往返会把坐标静默抹平。
          facet: entry.facet,
          level: entry.level,
          version: entry.version,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          lastRecalled: entry.lastRecalled,
          recallCount: entry.recallCount,
        })),
      }
      return { kind: 'success', text: JSON.stringify(payload, null, 2) }
    }
    case 'import': {
      const parsed = parseAdapterFlag(rest)
      if (parsed.flagSeen) {
        if (parsed.adapterId === undefined) return { kind: 'error', text: text.adapterBadFlag }
        return await importViaAdapter(ctx, service, parsed.adapterId, parsed.rest.join(' '), invocation, text)
      }
      const arg = rest.join(' ').trim()
      if (arg.length === 0) return { kind: 'error', text: text.importUsage }
      let payload
      if (arg.startsWith('{')) {
        try {
          payload = JSON.parse(arg)
        } catch {
          return { kind: 'error', text: text.importBadJson }
        }
      } else {
        try {
          payload = JSON.parse(readFileSync(arg, 'utf8'))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: text.importReadFailed(arg, message) }
        }
      }
      const shape = payload !== null && typeof payload === 'object' ? /** @type {{plugin?: unknown, schema?: unknown, entries?: unknown}} */ (payload) : undefined
      const valid = shape !== undefined && shape.plugin === 'dsh-memento' && shape.schema === EXPORT_SCHEMA && Array.isArray(shape.entries)
      if (!valid) return { kind: 'error', text: text.importBadSchema(EXPORT_SCHEMA) }
      const rawEntries = /** @type {unknown[]} */ (shape.entries)
      if (rawEntries.length === 0) return { kind: 'error', text: text.importNoEntries }
      if (rawEntries.length > MAX_IMPORT_ENTRIES) return { kind: 'error', text: text.importTooMany(MAX_IMPORT_ENTRIES) }
      const entries = []
      for (const raw of rawEntries) {
        if (raw === null || typeof raw !== 'object') return { kind: 'error', text: text.importBadEntry }
        const entry = /** @type {{track?: unknown, scope?: unknown, text?: unknown, source?: unknown, workspaceKey?: unknown, agentKey?: unknown, tags?: unknown, facet?: unknown, level?: unknown}} */ (raw)
        if (typeof entry.track !== 'string' || typeof entry.scope !== 'string' || typeof entry.text !== 'string' || entry.text.length === 0) {
          return { kind: 'error', text: text.importBadEntry }
        }
        entries.push({
          track: entry.track,
          scope: entry.scope,
          text: entry.text,
          ...(typeof entry.source === 'string' && entry.source.length > 0 ? { source: entry.source } : {}),
          // 标签与画像坐标照搬（红队②中 4）：三个字段都过 normalize*，非法值在落盘前响亮
          // 拒绝（抛出即整批不写，绝不静默丢字段或静默塞脏值）；旧文档缺字段时保持缺省。
          ...(entry.tags === undefined ? {} : { tags: normalizeTags(entry.tags) }),
          ...(entry.facet === undefined ? {} : { facet: normalizeFacet(entry.facet) }),
          ...(entry.level === undefined ? {} : { level: normalizeLevel(entry.level) }),
          // 刻意不透传导入载荷的 workspaceKey/agentKey：导入条目回落到调用者会话的工作区/agent，
          // 否则一条 /memory import 就能把记忆种进别的工作区（下次开会话即进 system prompt）。
        })
      }
      // seed 单次审批 + 全量预算预检 + 单事务原子落盘；条目重获新 id 与新时间戳，召回计数归零。
      const result = await service.seed(entries, { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) })
      return { kind: 'success', text: text.imported(result.added) }
    }
    case 'add': {
      const parsed = parseCommandWrite(rest, true)
      if (parsed.kind === 'error') {
        return { kind: 'error', text: text.addNeedsText }
      }
      const write = { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) }
      const result = await service.add(
        { track: parsed.track, scope: parsed.scope, text: parsed.text, source: 'command' },
        write,
      )
      return { kind: 'success', text: text.added(parsed.track, parsed.scope, result.entry.text, result.usage.used, result.usage.limit) }
    }
    case 'remove': {
      const parsed = parseCommandWrite(rest, true)
      if (parsed.kind === 'error') return { kind: 'error', text: text.removeNeedsSubstring }
      const result = await service.remove(
        { track: parsed.track, scope: parsed.scope, match: parsed.text },
        { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) },
      )
      return { kind: 'success', text: text.removed(parsed.track, parsed.scope, result.entry.text, result.usage.used, result.usage.limit) }
    }
    case 'consolidate': {
      const joined = rest.join(' ')
      const separator = joined.indexOf(' => ')
      if (separator === -1) {
        return { kind: 'error', text: text.consolidateUsage }
      }
      let track = 'user'
      let scope = 'workspace'
      const matches = []
      for (const part of joined.slice(0, separator).split(/\s+/)) {
        const trackMatch = /^--track=(user|agent)$/.exec(part)
        if (trackMatch !== null) { track = trackMatch[1]; continue }
        const scopeMatch = /^--scope=(user-global|workspace)$/.exec(part)
        if (scopeMatch !== null) { scope = scopeMatch[1]; continue }
        if (part.length > 0) matches.push(part)
      }
      const newText = joined.slice(separator + 4).trim()
      if (matches.length === 0 || matches.length > 20) return { kind: 'error', text: text.consolidateNeedsMatches }
      if (newText.length === 0) return { kind: 'error', text: text.consolidateNeedsText }
      const result = await service.consolidate(
        { track, scope, matches, text: newText, source: 'command' },
        { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) },
      )
      return { kind: 'success', text: text.consolidated(track, scope, result.removed.length, result.entry.text, result.usage.used, result.usage.limit) }
    }
    case 'session': {
      // F5 会话级开关：用户自己的控制件（非记忆写操作）——不打扰审批门，
      // 但状态本身绝不进会话日志（memory/* 事件未注册）；插件审计表记一行。
      const sessionId = invocation?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return { kind: 'error', text: text.sessionNoId }
      const mode = (rest[0] ?? 'status').toLowerCase()
      if (mode !== 'status' && mode !== 'on' && mode !== 'off') return { kind: 'error', text: text.sessionUsage }
      const enabled = mode === 'status' ? service.store.sessionEnabled(sessionId) : service.store.sessionSetEnabled(sessionId, mode === 'on')
      if (mode !== 'status') {
        service.store.auditAppend({
          action: 'session-switch',
          track: null,
          scope: null,
          entryId: null,
          text: null,
          outcome: enabled ? 'on' : 'off',
          source: DEFAULT_SOURCE,
          sessionId,
        })
      }
      return { kind: 'success', text: `${text.sessionState(shortSessionId(sessionId), enabled ? text.sessionOn : text.sessionOff, mode === 'status')}\n${enabled ? text.sessionToggleHintOn : text.sessionToggleHintOff}` }
    }
    case 'restore': {
      // S5 §1 的命令面：把降级条目救回（turn 外审批门，与 add/remove 同一条 makeCommandGate）。
      // 关了记忆的会话与 query/tidy 同档拒绝：回滚会改变本会话的可见集。
      if (!service.store.sessionEnabled(invocation?.agent?.session?.id)) return { kind: 'error', text: text.sessionOffRead }
      const ids = rest.filter((arg) => arg.length > 0)
      if (ids.length === 0) return { kind: 'error', text: text.restoreNeedsIds }
      const result = await service.restore({ ids, source: 'command' }, { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) })
      const body = result.restored.map((entry) => `- [${entry.id}] ${entry.text}`).join('\n')
      return { kind: 'success', text: text.restored(result.restored.length, body, result.usage.used, result.usage.limit) }
    }
    case 'arbitrate': {
      // S5 §2 的命令面：方向由裁决表决定，命令行没有反向参数（与工具面同一不变量）。
      if (!service.store.sessionEnabled(invocation?.agent?.session?.id)) return { kind: 'error', text: text.sessionOffRead }
      const ids = rest.filter((arg) => arg.length > 0)
      if (ids.length === 0) return { kind: 'error', text: text.arbitrateNeedsIds }
      const result = await service.arbitrate({ ids, source: 'command' }, { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) })
      if (result.direction === 'coexist') return { kind: 'success', text: text.arbitratedCoexist(result.facet, result.tagged.length, GAP_TAG) }
      return {
        kind: 'success',
        text: text.arbitratedKeep(
          result.facet,
          `${result.kept[0].id} [${result.kept[0].source}]`,
          result.demoted.length,
          result.usage.used,
          result.usage.limit,
        ),
      }
    }
    case 'tidy': {
      // F6 命令面：只读整理计划（积压 ＋ 分桶候选 ＋ 桶内相似线索）。不写库、不落审计、
      // 不调模型——语义判断归模型（yammory-tidy skill 引导它调 memory action=supersede）。
      // 会话关了记忆就拒：整理只动会话可见集，关掉的会话连看都不看。
      if (!service.store.sessionEnabled(invocation?.agent?.session?.id)) return { kind: 'error', text: text.sessionOffRead }
      const flags = parseTidyFlags(rest)
      if (!flags.ok) return { kind: 'error', text: (TIDY_TEXT[service.language] ?? TIDY_TEXT.en).tidyUsage }
      const session = invocation?.agent?.session
      const plan = buildTidyPlan(
        visibleFullEntries(
          service.store.listEntries(),
          workspaceKeyOf(/** @type {string | undefined} */ (session?.header?.cwd)),
          agentKeyOf(/** @type {string | undefined} */ (session?.header?.agentPreset)),
        ),
        {
          since: lastTidyTs(service.store.auditList(TIDY_AUDIT_WINDOW)),
          ...(flags.days === undefined ? {} : { windowDays: flags.days }),
        },
      )
      return { kind: 'success', text: tidyPlanLines(plan, service.language).join('\n') }
    }
    case 'stats': {
      // F7 命令面：只读三数（重复率 / 召回命中率 / 注入量 ＋ 成功率的诚实留白）。
      // 与 list/budgets 同档：不查会话开关、不写库、不落审计。
      return { kind: 'success', text: statsLines(readStats(service), service.language).join('\n') }
    }
    case 'observe': {
      // 观察通道的命令面：只读扫描 ＋ 打印切片与账单。推断由模型做（本命令不叫模型、
      // 不写库）；参数与工具面同一套钳制，故模型/用户都无法放大预算。
      const parsed = parseObserveFlags(rest)
      if (parsed === null) return { kind: 'error', text: text.observeUsage }
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined || sessionQuery === null) return { kind: 'error', text: text.observeUnavailable }
      const runtime = live ?? { observe: DEFAULT_OBSERVE, language: service.language }
      /** @type {Awaited<ReturnType<typeof scanObservationHistory>>} */
      let scanned
      try {
        scanned = await scanObservationHistory(ctx, runtime, parsed, {
          agent: invocation?.agent ?? null,
          signal: invocation?.signal,
        })
      } catch (error) {
        if (error instanceof MemoryError) return { kind: 'error', text: text.observeFailed(error.message) }
        throw error
      }
      const value = observationScanValue(scanned)
      const rendered = renderMemoryObserveResult({}, value, runtime.language)[0].text
      const session = invocation?.agent?.session
      if (typeof session?.id === 'string') {
        service.store.auditAppend({
          action: 'observed',
          track: null,
          scope: null,
          entryId: null,
          text: `command observe days=${scanned.options.days} covered=${scanned.slice.covered.sessions}/${scanned.slice.scanned.sessions} session(s), ${scanned.slice.covered.messages} message(s), ${scanned.slice.budget.used}/${scanned.slice.budget.limit} chars${scanned.slice.budget.truncated ? ' (truncated)' : ''}`,
          outcome: 'ok',
          source: OBSERVATION_SOURCE,
          sessionId: session.id,
        })
      }
      return { kind: 'success', text: `${rendered}\n\n${text.observeHint}` }
    }
    default:
      return { kind: 'error', text: `${text.unknownVerb(verb)}${extraVerbs}` }
  }
}

/**
 * 解析 /memory observe 的 `--key=value` 标志（未知键或非数值即报用法；空数组合法 = 全默认）。
 * 只认观察通道的五个参数键，与工具面的键一一对应。
 * @param {string[]} args - 命令参数。
 * @returns {{days?: number, sessions?: number, perSession?: number, messageChars?: number, totalChars?: number} | null} 参数对象；非法返回 null。
 */
function parseObserveFlags(args) {
  /** @type {{days?: number, sessions?: number, perSession?: number, messageChars?: number, totalChars?: number}} */
  const flags = {}
  for (const arg of args) {
    const match = /^--(days|sessions|per-session|chars|budget)=(\d+)$/.exec(arg)
    if (match === null) return null
    const key = match[1] === 'per-session' ? 'perSession' : match[1] === 'chars' ? 'messageChars' : match[1] === 'budget' ? 'totalChars' : match[1]
    flags[/** @type {keyof typeof flags} */ (key)] = Number(match[2])
  }
  return flags
}

/**
 * 解析 /memory tidy 的标志：只认 `--days=N`（1..365），其余一律报用法。
 * @param {string[]} args - 子命令参数。
 * @returns {{ok: true, days?: number} | {ok: false}} 解析结果。
 */
function parseTidyFlags(args) {
  let days
  for (const arg of args) {
    const match = /^--days=(\d+)$/.exec(arg)
    if (match === null) return { ok: false }
    const value = Number(match[1])
    if (!Number.isInteger(value) || value < 1 || value > 365) return { ok: false }
    days = value
  }
  return days === undefined ? { ok: true } : { ok: true, days }
}

/**
 * 读一次可观测三数（F7）：只读、零模型、不落审计。entries 取全量（含已降级）——
 * 重复率只看在场条目，降级条数单独报出。
 * @param {MemoryService} service - ctx.memory。
 * @returns {ReturnType<typeof buildStats>} 三数报告。
 */
function readStats(service) {
  const auditRows = service.store.auditList(AUDIT_WINDOW)
  return buildStats({
    entries: /** @type {Array<{id?: string, text: string, status?: string}>} */ (service.store.allEntries()),
    auditRows: /** @type {Array<{action?: string, outcome?: string | null, text?: string | null, ts?: number}>} */ (auditRows),
    auditWindow: auditRows.length,
  })
}

/** 读取 ctx.memoryAdapters（命令路径用）；缺失返回 null（headless 未挂载时响亮报缺）。 */function adapterRegistryOf(/** @type {import('@deepseek-ai/cordis').Context} */ ctx) {
  const registry = ctx.get('memoryAdapters')
  if (registry === null || typeof registry !== 'object' || typeof /** @type {{list?: unknown}} */ (registry).list !== 'function') return null
  return /** @type {MemoryAdapterRegistry} */ (registry)
}

/** 解析 --adapter=<id> 标志（export/import 共用；返回 {adapterId, rest, flagSeen}）。 */
function parseAdapterFlag(/** @type {string[]} */ args) {
  const rest = []
  let adapterId
  let flagSeen = false
  for (const arg of args) {
    const match = /^--adapter=([a-z0-9][a-z0-9-]*)$/.exec(arg)
    if (match !== null) {
      flagSeen = true
      adapterId = match[1]
      continue
    }
    if (arg.startsWith('--adapter')) flagSeen = true
    rest.push(arg)
  }
  return { adapterId, rest, flagSeen }
}

/**
 * 适配器导入：外部载荷（文件或内联 JSON）→ 适配器转换 → service.seed（单次审批 +
 * 全量预算预检 + 单事务原子落盘，逐条落审计）。转换失败/未知适配器响亮报错。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {MemoryService} service - ctx.memory。
 * @param {string} adapterId - 适配器 id。
 * @param {string} rawArg - 文件路径或内联 JSON。
 * @param {{rawInput?: unknown, agent?: {session?: MemorySessionLike | null} | null, signal?: AbortSignal}} invocation - 命令调用。
 * @param {CommandTextBundle} text - 文案包。
 * @returns {Promise<{kind: 'success' | 'error', text: string}>}。
 */
async function importViaAdapter(ctx, service, adapterId, rawArg, invocation, text) {
  const registry = adapterRegistryOf(ctx)
  if (registry === null) return { kind: 'error', text: text.adapterServiceMissing }
  const arg = rawArg.trim()
  if (arg.length === 0) return { kind: 'error', text: text.adapterImportUsage }
  /** @type {unknown} */
  let payload
  if (arg.startsWith('{')) {
    try {
      payload = JSON.parse(arg)
    } catch {
      return { kind: 'error', text: text.importBadJson }
    }
  } else {
    try {
      const rawText = readFileSync(arg, 'utf8')
      try {
        payload = JSON.parse(rawText)
      } catch {
        // markdown 适配器（hermes-memory-md / claude-code-memory-md）直接收原文。
        payload = rawText
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: text.importReadFailed(arg, message) }
    }
  }
  let entries
  try {
    entries = registry.adapt(adapterId, payload).entries
  } catch (error) {
    if (error instanceof AdapterNotFoundError) {
      return { kind: 'error', text: text.adapterUnknown(adapterId) }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: text.adapterPayload(adapterId, message) }
  }
  if (entries.length === 0) return { kind: 'error', text: text.importNoEntries }
  if (entries.length > MAX_IMPORT_ENTRIES) return { kind: 'error', text: text.importTooMany(MAX_IMPORT_ENTRIES) }
  const result = await service.seed(entries, { agent: invocation?.agent, gate: makeCommandGate(ctx, invocation) })
  return { kind: 'success', text: text.adapterImported(result.added, adapterId) }
}

/** 命令写参数解析：--track/--scope 可选（默认 user/workspace，与工具一致），余下为文本。 */
function parseCommandWrite(/** @type {string[]} */ args, /** @type {boolean} */ requireText) {  let track = 'user'
  let scope = 'workspace'
  const textParts = []
  for (const arg of args) {
    const trackMatch = /^--track=(user|agent)$/.exec(arg)
    if (trackMatch !== null) { track = trackMatch[1]; continue }
    const scopeMatch = /^--scope=(user-global|workspace)$/.exec(arg)
    if (scopeMatch !== null) { scope = scopeMatch[1]; continue }
    textParts.push(arg)
  }
  const text = textParts.join(' ')
  if (requireText === true && text.length === 0) {
    return { kind: 'error', text: '需要文本参数' }
  }
  return { kind: 'ok', track, scope, text }
}

/** 条目渲染行（命令/面板共用格式；workspace 条目带 @工作区键，非共享 agent 条目带 #agent 键）。 */
function renderEntryLine(/** @type {{track: string, scope: string, workspaceKey?: string, agentKey?: string, text: string}} */ entry) {
  const workspaceTag = entry.scope === 'workspace' ? ` @${entry.workspaceKey}` : ''
  const agentTag = typeof entry.agentKey === 'string' && entry.agentKey.length > 0 ? ` #${entry.agentKey}` : ''
  return `- [${entry.track}/${entry.scope}${workspaceTag}${agentTag}] ${entry.text}`
}

/**
 * memory_recall 工具（F11）：语义不明确时把记忆 query 与近期会话历史合并
 * 返回两段式召回（"记忆 + 历史会话"）。sessionQuery 服务缺失时降级为纯记忆
 * 结果（history 段为空，绝不报错）。recall 参数、渲染语言与当前检索器读 live
 * （热生效；默认 keyword，retrieval.vector 开启时换装 vector）；工具描述/参数文案
 * 注册期固定（换语言重载后更新）。
 * @param {MemoryService} service - ctx.memory。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文（查 sessionQuery）。
 * @param {{recall: {historyLimitDefault: number, snippetCap: number, snippetChars: number, windowDays: number}, language: 'en'|'zh', retriever?: import('./lib/retrieval.mjs').RetrievalProvider | null}} live - 运行期可变值容器（onChange 维护；retriever 恒非空）。
 * @returns {object} 工具定义。
 */
export function makeMemoryRecallTool(service, ctx, live) {
  const language = live.language
  const description = language === 'zh'
    ? [
      '对记忆与会话历史的两段式召回：返回 (1) yammory_system 库中与查询匹配的有界记忆条目，以及 (2) 经 session-query 服务的近期会话历史匹配。',
      '当仅凭记忆查询有歧义、或答案可能在更早的对话而非记忆中时使用。普通记忆查询请优先用 memory 工具的 action=query。',
      '查询对记忆条目按词元匹配（任一词元命中即召回，中文按相邻二字、英文按整词切分）并按相关度排序；对会话历史是大小写不敏感语义文本扫描。',
    ].join('\n')
    : [
      'Two-part recall over memory and session history: returns (1) bounded memory entries matching the query from the yammory_system store, and (2) recent session-history matches via the session-query service.',
      'Use when a memory query alone is ambiguous or when the answer may live in an earlier conversation rather than in memory. For plain memory lookup prefer the memory tool with action=query.',
      'The query is tokenized for memory entries (any token matches; CJK bigrams, Latin words as-is) and ranked by relevance, and is a case-insensitive semantic-text scan for session history.',
    ].join('\n')
  const parameters = language === 'zh'
    ? {
        query: '两个数据源的大小写不敏感检索词（记忆段按词元命中，任一词元命中即召回）。',
        memoryLimit: '最多返回的记忆条目数（默认 10）。',
        historyLimit: '最多扫描的历史会话数（默认 8）。',
      }
    : {
        query: 'Case-insensitive search terms for both sources (memory matches any query token).',
        memoryLimit: 'Max memory entries to return (default 10).',
        historyLimit: 'Max history sessions to scan (default 8).',
      }
  return defineTool({
    name: 'memory_recall',
    description,
    parameters: {
      query: { type: 'string', required: true, description: parameters.query },
      memoryLimit: { type: 'integer', description: parameters.memoryLimit },
      historyLimit: { type: 'integer', description: parameters.historyLimit },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          memory: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              entries: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    track: { type: 'string', required: true },
                    scope: { type: 'string', required: true },
                    text: { type: 'string', required: true },
                  },
                },
              },
              total: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          history: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              available: { type: 'boolean', required: true },
              error: { type: 'string' },
              sessions: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    sessionId: { type: 'string', required: true },
                    matches: { type: 'integer', required: true },
                    snippets: { type: 'array', required: true, items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      render: (/** @type {object} */ _args, /** @type {RecallToolValue} */ value) => renderMemoryRecallResult(_args, value, live.language),
    },
    execute: /** @type {(args: any, exec: any) => Promise<any>} */ (async (args, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = /** @type {string | undefined} */ (exec.agent?.session?.id)
      const session = /** @type {MemorySessionLike | null | undefined} */ (exec.agent?.session ?? null)
      const agentKey = agentKeyOf(/** @type {string | undefined} */ (exec.agent?.session?.header?.agentPreset))
      const limit = args.memoryLimit ?? 10
      const retriever = /** @type {import('./lib/retrieval.mjs').RetrievalProvider} */ (live.retriever)
      try {
        // F5 会话级开关：召回禁。不检索、不 bumpRecall、不落 recalled 审计——
        // 「关掉记忆」在模型面就是一次干净的拒绝。
        if (!service.store.sessionEnabled(sessionId)) {
          throw new SessionMemoryOffError(sessionId, 'memory_recall is disabled for this session')
        }
        const memory = recallViaRetriever(service, retriever, args.query, limit, { sessionId, session, agentKey })
        const history = await recallHistory(
          ctx,
          args.query,
          args.historyLimit ?? live.recall.historyLimitDefault,
          live.recall.snippetCap,
          live.recall.snippetChars,
          exec.signal,
          /** @type {string | undefined} */ (exec.agent?.session?.header?.cwd),
          live.recall.windowDays,
        )
        return {
          ok: true,
          memory: {
            entries: memory.entries.map(publicEntry),
            total: memory.total,
            truncated: memory.truncated,
          },
          history,
        }
      } catch (error) {
        if (error instanceof SessionMemoryOffError) return { ok: false, error: toToolError(error) }
        throw error
      }
    }),
  })
}

/**
 * 语义召回路径（retrieval seam 的 Consumer 面）：可见条目 → 检索器排序 → 召回计数
 * + 审计。与 service.query 的子串路径对齐：命中页召回计数 +1（bumpRecall）、带
 * sessionId 时记 recalled 审计行。可见集 = 会话 cwd 工作区层 + 共享/本 agent 层
 * （与快照 visibleEntries 同语义）。
 * @param {MemoryService} service - ctx.memory（提供 store）。
 * @param {import('./lib/retrieval.mjs').RetrievalProvider} retriever - 语义检索器。
 * @param {string} query - 检索词。
 * @param {number} limit - 返回上限。
 * @param {{sessionId?: string, session?: MemorySessionLike | null, agentKey: string}} opts - {sessionId, session, agentKey}。
 * @returns {MemoryQueryResult}。
 */
function recallViaRetriever(service, retriever, query, limit, opts) {
  const workspaceKey = workspaceKeyOf(/** @type {string | undefined} */ (opts.session?.header?.cwd))
  const entries = visibleEntries(
    /** @type {Array<{id: string, track: string, scope: string, workspaceKey: string, agentKey: string, text: string, createdAt: number}>} */ (service.store.listEntries()),
    workspaceKey,
    opts.agentKey,
  )
  const ranked = /** @type {MemoryEntry[]} */ (retriever.retrieve(query, entries, { now: Date.now() }))
  const shown = ranked.slice(0, limit)
  service.store.bumpRecall(shown.map((entry) => entry.id))
  if (opts.sessionId !== undefined) {
    service.store.auditAppend({
      action: 'recalled',
      text: query,
      // F7-2：零命中补一行（outcome='empty'），否则「查了没查到」不进统计，
      // 召回命中率的分母只剩成功样本（与协议 query 路径同口径）。
      outcome: ranked.length > 0 ? 'ok' : 'empty',
      source: /** @type {string} */ (service.sourceLabel),
      sessionId: opts.sessionId,
    })
  }
  return { entries: shown, total: ranked.length, truncated: ranked.length > shown.length }
}

/**
 * 近期会话历史召回（sessionQuery 可选；rc.6 记录形状 = {header:{id}}，事件为元数据记录）。
 * 服务端下推：filterSessions 以会话 cwd（原值直传，harness 按存储值比较）与
 * created-at 时间窗收窄候选，再对前 N 个候选做 filterEvents 定位——从"全量列举 +
 * 每候选一次扫描"变为"一次过滤 + ≤N 次定位"。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文（查 sessionQuery）。
 * @param {string} query - 检索词。
 * @param {number} limit - 最多扫描的会话数。
 * @param {number} snippetCap - 每个会话最多展示的片段数。
 * @param {number} snippetChars - 每个片段的最大字符数。
 * @param {AbortSignal} signal - 取消信号。
 * @param {string | undefined} cwd - 当前会话 cwd（服务端 cwd 过滤；缺省不加该过滤器）。
 * @param {number} windowDays - 时间窗（天）；>0 时加 created-at 下界。
 * @returns {Promise<{available: boolean, sessions: Array<{sessionId: string, matches: number, snippets: string[]}>, error?: string}>}。
 */
async function recallHistory(ctx, query, limit, snippetCap, snippetChars, signal, cwd, windowDays) {
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined || sessionQuery === null) {
    return { available: false, sessions: [] }
  }
  const queryService = /** @type {{filterSessions: (filters: object[], signal?: AbortSignal) => Promise<Array<{header?: {id?: unknown}}>>, filterEvents: (sessionId: string, filters: object[]) => Promise<Array<{seq: number}>>, readSession: (sessionId: string) => Promise<{session?: unknown, events: Array<{seq: number, type?: string, data?: unknown}>}>}} */ (sessionQuery)
  try {
    const sessionFilters = []
    if (typeof cwd === 'string' && cwd.length > 0) {
      sessionFilters.push({ kind: 'cwd', values: [cwd] })
    }
    if (Number.isInteger(windowDays) && windowDays > 0) {
      sessionFilters.push({ kind: 'created-at', from: Date.now() - windowDays * 86400000 })
    }
    const records = await queryService.filterSessions(sessionFilters, signal)
    /** @type {Array<{sessionId: string, matches: number, snippets: string[]}>} */
    const results = []
    for (const record of records.slice(0, limit)) {
      const sessionId = typeof record?.header?.id === 'string' ? record.header.id : ''
      if (sessionId.length === 0) continue
      const matched = await queryService.filterEvents(sessionId, [{ kind: 'text', text: query }])
      if (matched.length === 0) continue
      // 事件记录是元数据（seq/type/time），片段文本从整段日志按 seq 抽取。
      const snippets = []
      try {
        const snapshot = await queryService.readSession(sessionId)
        const bySeq = new Map(snapshot.events.map((event) => [event.seq, event]))
        for (const hit of matched.slice(0, snippetCap)) {
          const event = bySeq.get(hit.seq)
          if (event === undefined) continue
          const text = extractEventText(event)
          if (text.length > 0) snippets.push(text.length > snippetChars ? `${text.slice(0, snippetChars)}…` : text)
        }
      } catch {
        // 片段提取失败不影响已确认的命中记录；空 catch 语义：只放弃片段装饰。
      }
      results.push({ sessionId, matches: matched.length, snippets })
    }
    return { available: true, sessions: results }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { available: false, sessions: [], error: message }
  }
}

/**
 * memory_recall 结果渲染（纯函数；language 选文案，未知回退 en）。
 * @param {object} _args - 调用参数（未用）。
 * @param {object} value - 规范 JSON 结果。
 * @param {string} [language] - 'en' | 'zh'。
 * @returns {Array<{type: 'text', text: string}>} 模型可见文本。
 */
export function renderMemoryRecallResult(/** @type {object} */ _args, /** @type {RecallToolValue} */ value, language = 'en') {
  const zh = language === 'zh'
  const memoryLine = value.memory.total === 0
    ? (zh ? 'memory：没有条目命中' : 'memory: no entries matched')
    : (zh
        ? `memory：${value.memory.entries.length} 条命中${value.memory.truncated ? `（共 ${value.memory.total} 条）` : ''}\n${value.memory.entries.map((entry) => `- [${entry.track}/${entry.scope}] ${entry.text}`).join('\n')}`
        : `memory: ${value.memory.entries.length} match${value.memory.entries.length === 1 ? '' : 'es'}${value.memory.truncated ? ` (of ${value.memory.total})` : ''}\n${value.memory.entries.map((entry) => `- [${entry.track}/${entry.scope}] ${entry.text}`).join('\n')}`)
  const historyLines = []
  if (!value.history.available) {
    historyLines.push(value.history.error === undefined
      ? (zh ? 'history：本 profile 未提供 session-query 服务' : 'history: session-query unavailable in this profile')
      : (zh ? `history：session-query 失败（${value.history.error}）` : `history: session-query failed (${value.history.error})`))
  } else if (value.history.sessions.length === 0) {
    historyLines.push(zh ? 'history：没有匹配的会话' : 'history: no matching sessions')
  } else {
    for (const session of value.history.sessions) {
      historyLines.push(zh
        ? `- 会话 ${session.sessionId}：${session.matches} 条事件命中`
        : `- session ${session.sessionId}: ${session.matches} event match${session.matches === 1 ? '' : 'es'}`)
      for (const snippet of session.snippets) historyLines.push(`    ${snippet.replaceAll('\n', ' ')}`)
    }
  }
  return [{ type: 'text', text: `${memoryLine}\n\n${historyLines.join('\n')}` }]
}

/**
 * 注册面板 JSON 路由（F9；webServer 缺失的 profile 自动跳过）。
 * 除「整理全库」登记（收边 §2，用户动作、只写一条待整理标记）外全部只读：审批决策
 * 在 DSH 内置审批 UI 完成，面板不做任何审批决策、也不改记忆条目。路由随插件生命周期
 * 自动撤销。options 传 live（热字段：panelEntriesLimit/panelAuditLimit/panel/language
 * 随设置变更即时生效）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {MemoryService} service - ctx.memory。
 * @param {{panelEntriesLimit: number, panelAuditLimit: number, panel: {enabled: boolean}, language: 'en'|'zh'}} options - 运行期可变值容器。
 */
export function registerWebRoutes(ctx, service, options) {
  withService(ctx, 'connection', (/** @type {{fetch?: {register?: (route: object) => (() => Promise<void>) | undefined}} | null | undefined} */ connection) => {
    if (typeof connection?.fetch?.register !== 'function') return
    // 走 ctx.connection.fetch 而不是 webServer.register(exact)：exact 路由匹配优先于
    // 前缀路由，会抢在 connection 的 /api 信任栅栏之前命中，于是绕过 Host/Origin/
    // sec-fetch-site 与浏览器认证（红队①）。经 connection.fetch 注册的 exact 路由由
    // connection 的 /api handler 统一分发，栅栏先过、再到这里。
    // connection.fetch.register 的 disposer 是异步的，且 effect 挂在 connection 的
    // fiber 上：逐个收集，末尾挂进一个 ctx.effect，插件卸载时逆序摘除。
    /** @type {Array<(() => Promise<void>) | undefined>} */
    const routeDisposers = []
    routeDisposers.push(connection.fetch.register({
      path: '/api/memento/entries',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (/** @type {Request} */ request) => {
        try {
          const url = new URL(request.url)
          const filter = {
            ...(url.searchParams.get('text') ? { text: url.searchParams.get('text') } : {}),
            ...(url.searchParams.get('track') ? { track: url.searchParams.get('track') } : {}),
            ...(url.searchParams.get('scope') ? { scope: url.searchParams.get('scope') } : {}),
          }
          const rawParam = url.searchParams.get('limit')
          const raw = rawParam === null ? undefined : Number(rawParam)
          const limit = raw === undefined ? undefined : (Number.isInteger(raw) && raw > 0 ? Math.min(raw, options.panelEntriesLimit) : undefined)
          const { entries, total, truncated } = service.query({
            ...filter,
            ...(limit === undefined ? {} : { limit }),
          })
          return panelJson(200, { entries, total, truncated, budgets: service.budgets(), language: service.language, panel: { enabled: options.panel.enabled } })
        } catch (error) {
          return panelJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    routeDisposers.push(connection.fetch.register({
      path: '/api/memento/audit',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (/** @type {Request} */ request) => {
        try {
          const url = new URL(request.url)
          const raw = Number(url.searchParams.get('limit') ?? String(options.panelAuditLimit))
          const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, PANEL_AUDIT_CEILING) : options.panelAuditLimit
          return panelJson(200, { rows: service.store.auditList(limit), language: service.language })
        } catch (error) {
          return panelJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    routeDisposers.push(connection.fetch.register({
      path: '/api/memento/proposals',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          // 只读：仅列出 pending 提案；approve/dismiss 走 /memory 命令（用户动作 + 审批门）。
          return panelJson(200, { proposals: service.store.proposalList('pending', 50), language: service.language })
        } catch (error) {
          return panelJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    // F7 可观测三数的面板数据面：只读、零模型、不落审计。与其它路由同栅栏
    // （connection.fetch），响应里带上渲染好的文本行，面板/外部视图直接取用。
    routeDisposers.push(connection.fetch.register({
      path: '/api/memento/stats',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const stats = readStats(service)
          return panelJson(200, { stats, lines: statsLines(stats, service.language), language: service.language })
        } catch (error) {
          return panelJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    // F5 会话级开关：GET 读状态，POST 只切换开关（不接受任何其它字段）。
    // 与上面四条同栅栏（connection.fetch）——不得走 webServer exact（红队①）。
    // 注册表以 path 为键（同 path 只能一条），GET/POST 合并为一条路由按 method 分派。
    routeDisposers.push(connection.fetch.register({
      path: '/api/memento/session',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {Request} */ request) => {
        try {
          if (request.method === 'GET') {
            const sessionId = new URL(request.url).searchParams.get('sessionId')
            if (!validSwitchSessionId(sessionId)) return panelJson(400, { error: 'sessionId must be a non-empty string of at most 200 characters' })
            return panelJson(200, { sessionId, enabled: service.store.sessionEnabled(sessionId), language: service.language })
          }
          /** @type {unknown} */
          let body
          try {
            body = await request.json()
          } catch {
            return panelJson(400, { error: 'body must be a JSON object {sessionId, enabled}' })
          }
          const input = /** @type {{[key: string]: unknown}} */ (body)
          if (input === null || typeof input !== 'object') return panelJson(400, { error: 'body must be a JSON object {sessionId, enabled}' })
          const keys = Object.keys(input)
          if (keys.length !== 2 || !keys.includes('sessionId') || !keys.includes('enabled')) {
            return panelJson(400, { error: 'body must contain exactly {sessionId, enabled}' })
          }
          if (!validSwitchSessionId(input.sessionId)) return panelJson(400, { error: 'sessionId must be a non-empty string of at most 200 characters' })
          const sessionId = /** @type {string} */ (input.sessionId)
          // 红队②中 2：enabled 必须是严格布尔。旧实现只认 `=== true`，字符串 "true" / 0 / {}
          // 会被静默当成 false 落库（用户以为开了、库里记的是关）——非布尔一律 400，
          // 不落库、不回显假值。
          if (typeof input.enabled !== 'boolean') return panelJson(400, { error: 'enabled must be a boolean' })
          // 红队②中 3 的退化档：connection.fetch 的 handler 只拿到 Request，没有任何服务端
          // 可校验的会话归属（headers 由页面自己写，同源页面可伪造；DSH 的 browser-auth 是
          // 进程级凭据，不区分会话）。这里的纵深防御是把 id 钉在真实会话上：查不到的 id
          // 一律 400，挡掉「凭空造一个 id 去关灯」。sessionQuery 未装配时如实放行（见文档登记）。
          if (await unknownSwitchSession(ctx, sessionId)) {
            return panelJson(400, { error: `unknown session ${JSON.stringify(sessionId)}: no session with that id is known to this deployment` })
          }
          const enabled = service.store.sessionSetEnabled(sessionId, input.enabled)
          service.store.auditAppend({
            action: 'session-switch',
            track: null,
            scope: null,
            entryId: null,
            text: null,
            outcome: enabled ? 'on' : 'off',
            // 来源写实（红队②中 3）：这条路由只服务面板按钮，审计归属按面板记，
            // 与命令面（/memory session，source=dsh-memento）区分开。
            source: PANEL_SOURCE,
            sessionId,
          })
          return panelJson(200, { sessionId, enabled, language: service.language })
        } catch (error) {
          return panelJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    // 收边 §2（规格 3.5.9 的排队式按钮）：GET 读待整理标记，POST 登记一条。
    // 面板按钮是**用户动作**，不是模型回合：connection.fetch 路由没有会话上下文，故写
    // 上下文用不含 session 的占位 agent，走 turn 外 gate（与 /memory 命令同一条
    // approval/request waterfall 与同一套 writePolicy）。只写标记——不调模型、不碰条目；
    // 「整理全库」本身仍由模型在会话内显式跑（审计红线），跑完 supersede 清掉标记。
    routeDisposers.push(connection.fetch.register({
      path: '/api/memento/tidy-request',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {Request} */ request) => {
        try {
          if (request.method === 'GET') {
            return panelJson(200, { pending: service.store.tidyRequestPending(), language: service.language })
          }
          /** @type {unknown} */
          let body
          try {
            body = await request.json()
          } catch {
            return panelJson(400, { error: 'body must be an empty JSON object {}' })
          }
          const input = /** @type {{[key: string]: unknown}} */ (body)
          if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            return panelJson(400, { error: 'body must be an empty JSON object {}' })
          }
          // 按钮不带任何参数：多余字段一律 400（同 /api/memento/session 的严格度）。
          if (Object.keys(input).length !== 0) {
            return panelJson(400, { error: 'body must be an empty JSON object {} (the button carries no arguments)' })
          }
          const write = { agent: PANEL_AGENT, gate: makeCommandGate(ctx, { agent: PANEL_AGENT }) }
          const result = await service.requestTidy({ source: PANEL_SOURCE }, write)
          return panelJson(200, { pending: result.request, created: result.created, language: service.language })
        } catch (error) {
          return panelJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    // 路由随插件生命周期撤销：fiber 卸载时逆序执行全部 disposer。
    ctx.effect(() => () => {
      for (const dispose of routeDisposers.splice(0).reverse()) void dispose?.()
    }, 'memento: web panel routes')
  })
}

/** 会话 id 短码（命令面展示用：太长会撑破一行，前缀已足够定位）。 */
function shortSessionId(/** @type {string} */ sessionId) {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`
}

/** 会话开关路由的 sessionId 校验（非空字符串且 ≤ 200 字符，否则 400）。 */
function validSwitchSessionId(/** @type {unknown} */ value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SWITCH_SESSION_ID
}

/**
 * 会话开关路由的会话存在性校验（红队②中 3 的退化档）：这个 id 是否指向一个真实会话。
 *
 * 调研结论（以 DSH 源码为准）：`connection.fetch` 的 exact route handler 签名是
 * `(request: Request) => Promise<Response>`，分发链（`client-connection` 的
 * `createSharedFetchHandler`）只按 path 匹配后把 Request 原样递给 handler，**不注入任何
 * 会话上下文**；Request 上的 headers 又全部由页面自己写，同源页面可以伪造任意值。
 * DSH 的 browser-auth 是进程级凭据（区分「是不是本进程的浏览器」），不区分会话。
 * 故没有服务端可校验的会话归属。
 *
 * 这一档能做的是把 id 钉在真实会话上：查 session-query 的逻辑会话语料，查不到即拒，
 * 挡掉「凭空造一个 id 去关灯」。sessionQuery 未装配时返回 false（放行）——这是
 * 「无从校验」，不是「校验通过」，在 ARCHITECTURE.md 与 v2 规格里如实登记。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {string} sessionId - 请求声明的会话 id。
 * @returns {Promise<boolean>} 该 id 确实查不到时为 true（查询故障照常抛出，由路由转 500）。
 */
async function unknownSwitchSession(ctx, sessionId) {
  const sessionQuery = /** @type {SessionQueryLike | null | undefined} */ (ctx.get('sessionQuery'))
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.filterSessions !== 'function') return false
  const records = await sessionQuery.filterSessions([{ kind: 'id', values: [sessionId] }])
  return !Array.isArray(records) || records.length === 0
}

/** 面板 JSON 响应（WHATWG Response）。 */
function panelJson(/** @type {number} */ status, /** @type {unknown} */ value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/**
 * 面板动作的写上下文占位 agent（收边 §2）：浏览器按钮不来自任何会话，connection.fetch
 * 路由也没有会话上下文，所以这里是一个**不含 session** 的占位对象——审计行的 sessionId
 * 因此恒为 null（如实记「这个动作不属于任何会话」，不编造归属）。审批走与 /memory 命令
 * 同一条 turn 外 gate（approval/request waterfall ＋ 同一套 writePolicy），审批服务那条
 * 「必须有 open turn」的路不参与。
 * @type {{session?: MemorySessionLike | null}}
 */
const PANEL_AGENT = {}

export { MemoryError, InvalidInputError, BudgetExceededError, EntryNotFoundError, AmbiguousMatchError, StaleWriteError, WriteDeniedError, NoAgentError, ProposalNotFoundError, AdapterNotFoundError, AdapterPayloadError, SessionMemoryOffError }
export { buildWriteReason, isMemoryWriteRequest, applyWritePolicy, normalizeWritePolicy, resolveWritePolicy, validateWritePolicies, parseWriteReason }
export { openMemoryStore, resolveDbPath }
export { renderSnapshot, renderWarmup, visibleEntries }
export { workspaceKeyOf }
export { validateBudgets, budgetReport, budgetLimits, checkBudget }
export { MemoryProtocolCore, PROTOCOL_ID, PROTOCOL_VERSION, PROTOCOL_URI, normalizeTags, validateMemoryEntry, validateExportEnvelope, validateAuditRow, MAX_TAGS_PER_ENTRY, MAX_TAG_LENGTH }
export { MemoryAdapterRegistry }
export { REFERENCE_ADAPTERS }

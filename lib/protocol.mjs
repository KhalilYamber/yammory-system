// lib/protocol.mjs — dsh-memory-protocol v1（零 DSH 依赖）。
//
// 协议与实现分离：本文件是协议的规范实现面，只依赖 node: 内置与同目录零依赖模块
// （constants/errors/budget/workspace），不 import 任何 DSH 包。index.mjs 的
// MemoryService 继承 MemoryProtocolCore，只注入两件 DSH 专属物：审批传输
// （gate 回调）与会话事件派发（emit 回调）。一致性套件（test/protocol-conformance/）
// 用同一 core + 自动放行 gate 作为黄金参考——任何声称兼容的 Provider 跑同一套用例。
//
// 协议语义的权威文档是 docs/protocol-v1.md 与 docs/schemas/dsh-memory-protocol-v1.schema.json；
// 本文件的校验函数实现同一组约束（仓库零运行时依赖，不引 JSON Schema 引擎）。

import { TRACKS, SCOPES, PROFILE_FACETS, ENTRY_STATUSES, ACTIVE_STATUS, SUPERSEDED_STATUS, DEFAULT_SOURCE, SESSION_EVENTS, MAX_CONSOLIDATE_MATCHES, KNOWLEDGE_DOMAINS, KNOWLEDGE_TIERS, tierForLevel, ARBITRATION_BY_FACET, ARBITRATION_SELF_REPORT, ARBITRATION_COEXIST, GAP_TAG, MAX_TAGS_PER_ENTRY, MAX_TAG_LENGTH, OBSERVATION_SOURCE, MERGED_TAG } from './constants.mjs'
import { InvalidInputError, EntryNotFoundError, AmbiguousMatchError, WriteDeniedError, NoAgentError, SessionMemoryOffError } from './errors.mjs'
import { budgetReport, budgetLimits } from './budget.mjs'
import { normalizeWritePolicy } from './gate.mjs'
import { workspaceKeyOf, agentKeyOf } from './workspace.mjs'
import { bucketKeyOf, gradeMerge } from './consolidate.mjs'

/** 协议标识（文档、导出信封与一致性报告里的稳定名字）。 */
export const PROTOCOL_ID = 'dsh-memory-protocol'

/** 协议版本（与 docs/schemas/dsh-memory-protocol-v1.schema.json 同步）。 */
export const PROTOCOL_VERSION = 1

/** 协议 URI：`<PROTOCOL_ID>/v<PROTOCOL_VERSION>`。 */
export const PROTOCOL_URI = `${PROTOCOL_ID}/v${PROTOCOL_VERSION}`

/**
 * 受信任的审批传输：只有插件内部命令路径登记过的 gate 才能覆盖默认审批门。
 * write.gate 若未经 trustWriteGate 登记（外部/伪造），#ask 会直接拒绝——纵深防御，
 * 即便模型将来能构造 write 对象，也塞不进一条绕过审批的传输。
 */
const TRUSTED_GATES = new WeakSet()

/**
 * 登记一个受信任的 write gate（仅插件内部命令路径调用；登记后 #ask 才接受它）。
 * @template {(...args: any[]) => any} T
 * @param {T} gate - gate 函数。
 * @returns {T} 原函数（便于链式返回）。
 */
export function trustWriteGate(gate) {
  TRUSTED_GATES.add(gate)
  return gate
}

/** 会话级开关拒绝时审计行的 outcome 标签（F5：只记动作与结果，text 恒为 null）。 */
export const SESSION_OFF_OUTCOME = 'session-off'

/** 「已整理」标记：定义在 lib/constants.mjs（断开与 lib/consolidate.mjs 的环），此处对外原样 re-export。 */
export { MERGED_TAG }

/** 治理面动作的来源标注（S5）：与 `source:consolidation` 同型，给它一个自己的粒度键。 */
export const GOVERNANCE_SOURCE = 'governance'

/**
 * 面板「整理全库」按钮的来源标注（收边 §2）：登记行与审批载荷都带它，
 * `source:panel` 可作为一个粒度键给这个动作单独定策略。
 */
export const PANEL_SOURCE = 'panel'

/**
 * 自动整理的来源标注（F8 把握分级）：落写审计的 source 列。有了它，`source:auto-tidy`
 * 就是一个独立粒度键——自动这条路能单独设 writePolicy（ask/auto/off），与模型手动整理的
 * 默认来源互不牵连；关掉它时自动整理静默不动，手动路径照常。
 */
export const AUTO_TIDY_SOURCE = 'auto-tidy'

/**
 * 全库动作在审批载荷里的伪桶：审批 reason 的形状要求写成 `track/scope`，而「整理全库」
 * 不属于任何真实 track/scope。`library/all` 明说这是全库范围——它不是合法的写策略键
 * （lib/gate.mjs 的 validateWritePolicies 只认 `track/scope` 与 `source:<name>`），
 * 因此策略解析自然落到全局 writePolicy 或 `source:panel`，不会被某个桶的策略误裁。
 */
export const LIBRARY_BUCKET = { track: 'library', scope: 'all' }

/** 每条目的标签数上限（协议常量，非部署 tunable；出处是 lib/constants.mjs，此处再导出供工具与一致性套件取用）。 */
export { MAX_TAGS_PER_ENTRY, MAX_TAG_LENGTH }

/** 条目 id 形状：UUID v4（Provider 生成，跨会话稳定）。 */
export const ENTRY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * 标签规范化与校验（协议 v1 条目规范的一部分）：
 * - 必须是字符串数组；逐项 trim 后非空；
 * - 去重（保持首次出现顺序）；禁止控制字符；
 * - 单条 ≤ MAX_TAG_LENGTH 字符，条数 ≤ MAX_TAGS_PER_ENTRY。
 * 违反任何一条响亮失败（INVALID_INPUT），绝不静默丢弃。
 * @param {unknown} tags - 输入标签（undefined/null = 无标签）。
 * @returns {string[]} 规范化标签数组。
 */
export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) {
    throw new InvalidInputError('entry tags must be an array of strings')
  }
  const seen = new Set()
  const result = []
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      throw new InvalidInputError('entry tags must be an array of strings')
    }
    const tag = raw.trim()
    if (tag.length === 0) {
      throw new InvalidInputError('entry tags must be non-empty strings')
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(tag)) {
      throw new InvalidInputError(`entry tag ${JSON.stringify(tag)} contains control characters`)
    }
    if (tag.length > MAX_TAG_LENGTH) {
      throw new InvalidInputError(`entry tag ${JSON.stringify(tag.slice(0, 20))}… exceeds ${MAX_TAG_LENGTH} chars`)
    }
    if (!seen.has(tag)) {
      seen.add(tag)
      result.push(tag)
    }
  }
  if (result.length > MAX_TAGS_PER_ENTRY) {
    throw new InvalidInputError(`entry has ${result.length} tags; at most ${MAX_TAGS_PER_ENTRY} are allowed`)
  }
  return result
}

/**
 * 七面多边形 facet 规范化与校验：undefined/null → null；非词汇 → INVALID_INPUT。
 * @param {unknown} facet - 输入 facet。
 * @returns {string | null} 规范化 facet。
 */
export function normalizeFacet(facet) {
  if (facet === undefined || facet === null) return null
  if (typeof facet !== 'string' || !PROFILE_FACETS.includes(facet)) {
    throw new InvalidInputError(`entry facet must be one of ${PROFILE_FACETS.join('|')} (got ${JSON.stringify(facet)})`)
  }
  return facet
}

/**
 * 分领域知识水平 level 规范化与校验：undefined/null → null；非 1..10 整数 → INVALID_INPUT。
 * @param {unknown} level - 输入 level。
 * @returns {number | null} 规范化 level。
 */
export function normalizeLevel(level) {
  if (level === undefined || level === null) return null
  if (!Number.isInteger(level) || /** @type {number} */ (level) < 1 || /** @type {number} */ (level) > 10) {
    throw new InvalidInputError(`entry level must be an integer 1..10 (got ${JSON.stringify(level)})`)
  }
  return /** @type {number} */ (level)
}

/**
 * 条目 status 规范化：undefined/null → 'active'（soft delete：写入恒 active，降级只走
 * supersede/arbitrate，回滚只走 restore）。
 * @param {unknown} status - 输入 status。
 * @returns {'active' | 'superseded'} 规范化 status。
 */
export function normalizeStatus(status) {
  if (status === undefined || status === null) return 'active'
  if (!/** @type {readonly string[]} */ (ENTRY_STATUSES).includes(/** @type {string} */ (status))) {
    throw new InvalidInputError(`entry status must be one of ${ENTRY_STATUSES.join('|')} (got ${JSON.stringify(status)})`)
  }
  return /** @type {'active' | 'superseded'} */ (status)
}

/**
 * 落盘条目的结构校验（一致性套件与导入共用；协议条目规范的机器实现面）。
 * @param {unknown} entry - 待校验条目。
 * @returns {{id: string, track: string, scope: string, workspaceKey: string, agentKey: string, text: string, source: string, tags: string[], version: number, facet: string | null, level: number | null, status: 'active' | 'superseded', createdAt: number, updatedAt: number, lastRecalled: number | null, recallCount: number, sessionId: string | null}} 校验通过的条目（字段已核对）。
 */
export function validateMemoryEntry(entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new InvalidInputError('memory entry must be an object')
  }
  const record = /** @type {{[key: string]: unknown}} */ (entry)
  if (typeof record.id !== 'string' || !ENTRY_ID_PATTERN.test(record.id)) {
    throw new InvalidInputError(`memory entry id must be a UUID v4 string (got ${JSON.stringify(record.id)})`)
  }
  if (!/** @type {readonly string[]} */ (TRACKS).includes(/** @type {string} */ (record.track)) || !/** @type {readonly string[]} */ (SCOPES).includes(/** @type {string} */ (record.scope))) {
    throw new InvalidInputError(`invalid memory scope: track=${JSON.stringify(record.track)} scope=${JSON.stringify(record.scope)}`)
  }
  if (typeof record.workspaceKey !== 'string' || typeof record.agentKey !== 'string') {
    throw new InvalidInputError('memory entry workspaceKey/agentKey must be strings')
  }
  if (typeof record.text !== 'string' || record.text.length === 0) {
    throw new InvalidInputError('memory entry text must be a non-empty string')
  }
  if (typeof record.source !== 'string' || record.source.length === 0) {
    throw new InvalidInputError('memory entry source must be a non-empty string')
  }
  if (!Number.isInteger(record.version) || /** @type {number} */ (record.version) < 1) {
    throw new InvalidInputError(`memory entry version must be an integer >= 1 (got ${JSON.stringify(record.version)})`)
  }
  if (!Number.isInteger(record.createdAt) || !Number.isInteger(record.updatedAt) || /** @type {number} */ (record.updatedAt) < /** @type {number} */ (record.createdAt)) {
    throw new InvalidInputError('memory entry timestamps must be integers with updatedAt >= createdAt')
  }
  if (record.lastRecalled !== null && !Number.isInteger(record.lastRecalled)) {
    throw new InvalidInputError('memory entry lastRecalled must be null or an integer timestamp')
  }
  if (!Number.isInteger(record.recallCount) || /** @type {number} */ (record.recallCount) < 0) {
    throw new InvalidInputError('memory entry recallCount must be a non-negative integer')
  }
  if (record.sessionId !== null && typeof record.sessionId !== 'string') {
    throw new InvalidInputError('memory entry sessionId must be null or a string')
  }
  const tags = normalizeTags(record.tags)
  const facet = normalizeFacet(record.facet)
  const level = normalizeLevel(record.level)
  const status = normalizeStatus(record.status)
  return {
    id: /** @type {string} */ (record.id),
    track: /** @type {string} */ (record.track),
    scope: /** @type {string} */ (record.scope),
    workspaceKey: /** @type {string} */ (record.workspaceKey),
    agentKey: /** @type {string} */ (record.agentKey),
    text: /** @type {string} */ (record.text),
    source: /** @type {string} */ (record.source),
    tags,
    version: /** @type {number} */ (record.version),
    facet,
    level,
    status,
    createdAt: /** @type {number} */ (record.createdAt),
    updatedAt: /** @type {number} */ (record.updatedAt),
    lastRecalled: /** @type {number | null} */ (record.lastRecalled),
    recallCount: /** @type {number} */ (record.recallCount),
    sessionId: /** @type {string | null} */ (record.sessionId),
  }
}

/**
 * 导出信封校验（dsh-memento 的 memory-export-v1 文档；备份/迁移/一致性用例共用）。
 * @param {unknown} payload - JSON 文档。
 * @returns {{plugin: string, schema: string, exportedAt: string, budgets: Array<{track: string, scope: string, used: number, limit: number}>, entries: ReturnType<typeof validateMemoryEntry>[]}} 校验通过的信封。
 */
export function validateExportEnvelope(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new InvalidInputError('export document must be an object')
  }
  const record = /** @type {{[key: string]: unknown}} */ (payload)
  if (record.plugin !== 'dsh-memento' || record.schema !== 'memory-export-v1') {
    throw new InvalidInputError('export document must declare plugin "dsh-memento" and schema "memory-export-v1"')
  }
  if (typeof record.exportedAt !== 'string' || Number.isNaN(Date.parse(record.exportedAt))) {
    throw new InvalidInputError('export document exportedAt must be an ISO timestamp string')
  }
  if (!Array.isArray(record.budgets)) {
    throw new InvalidInputError('export document budgets must be an array')
  }
  const budgets = record.budgets.map((row) => {
    if (row === null || typeof row !== 'object') throw new InvalidInputError('export budget row must be an object')
    const r = /** @type {{[key: string]: unknown}} */ (row)
    if (!/** @type {readonly string[]} */ (TRACKS).includes(/** @type {string} */ (r.track)) || !/** @type {readonly string[]} */ (SCOPES).includes(/** @type {string} */ (r.scope))) {
      throw new InvalidInputError(`export budget row has invalid track/scope: ${JSON.stringify(r.track)}/${JSON.stringify(r.scope)}`)
    }
    if (!Number.isInteger(r.used) || !Number.isInteger(r.limit) || /** @type {number} */ (r.used) < 0 || /** @type {number} */ (r.limit) < 0) {
      throw new InvalidInputError('export budget row used/limit must be non-negative integers')
    }
    return { track: /** @type {string} */ (r.track), scope: /** @type {string} */ (r.scope), used: /** @type {number} */ (r.used), limit: /** @type {number} */ (r.limit) }
  })
  if (!Array.isArray(record.entries)) {
    throw new InvalidInputError('export document entries must be an array')
  }
  const entries = record.entries.map((entry) => validateMemoryEntry(entry))
  return { plugin: 'dsh-memento', schema: 'memory-export-v1', exportedAt: /** @type {string} */ (record.exportedAt), budgets, entries }
}

/**
 * 审计行结构校验（协议审计事件规范：任何写入可由审计账本 + 审批审计对重建）。
 * @param {unknown} row - 审计行。
 * @returns {{seq: number, ts: number, action: string, track: string | null, scope: string | null, entryId: string | null, text: string | null, outcome: string | null, source: string | null, sessionId: string | null}} 校验通过的审计行。
 */
export function validateAuditRow(row) {
  if (row === null || typeof row !== 'object') {
    throw new InvalidInputError('audit row must be an object')
  }
  const r = /** @type {{[key: string]: unknown}} */ (row)
  if (!Number.isInteger(r.seq) || !Number.isInteger(r.ts)) {
    throw new InvalidInputError('audit row seq/ts must be integers')
  }
  if (typeof r.action !== 'string' || r.action.length === 0) {
    throw new InvalidInputError('audit row action must be a non-empty string')
  }
  for (const field of ['track', 'scope', 'entryId', 'text', 'outcome', 'source', 'sessionId']) {
    if (r[field] !== null && typeof r[field] !== 'string') {
      throw new InvalidInputError(`audit row ${field} must be null or a string`)
    }
  }
  return {
    seq: /** @type {number} */ (r.seq),
    ts: /** @type {number} */ (r.ts),
    action: /** @type {string} */ (r.action),
    track: /** @type {string | null} */ (r.track),
    scope: /** @type {string | null} */ (r.scope),
    entryId: /** @type {string | null} */ (r.entryId),
    text: /** @type {string | null} */ (r.text),
    outcome: /** @type {string | null} */ (r.outcome),
    source: /** @type {string | null} */ (r.source),
    sessionId: /** @type {string | null} */ (r.sessionId),
  }
}

/** 协议层使用的条目形状（types.d.ts 是唯一出处；本文件的 JSDoc 一律引这名，避免内联 import 类型散落）。 */
/** @typedef {import('../types.js').MemoryEntry} ProtocolEntry */

/**
 * @typedef {object} ProtocolBudgets
 * @property {{userGlobal: number, workspace: number}} user
 * @property {{userGlobal: number, workspace: number}} agent
 */

/** 协议核心依赖的 Provider 面（lib/store.mjs 实现；一致性套件的第三方 Provider 同形状）。 */
/**
 * @typedef {{domain: string, level: number, tier: string, updatedAt: number}} ProfileRow - profile 表行（分领域知识水平）。
 */
/**
 * @typedef {object} ProtocolStore
 * @property {(filter?: {track?: string, scope?: string, text?: string, limit?: number, agentKey?: string}) => import('../types.js').MemoryQueryResult} queryEntries
 * @property {() => ProtocolEntry[]} listEntries
 * @property {() => ProtocolEntry[]} allEntries
 * @property {(ids: string[]) => void} bumpRecall
 * @property {(track: string, scope: string, match: string, opts?: {agentKey?: string, workspaceKey?: string}) => ProtocolEntry[]} matchCandidates
 * @property {(track: string, scope: string) => number} usage
 * @property {(input: object) => ProtocolEntry} insertEntry
 * @property {(inputs: object[]) => ProtocolEntry[]} seedEntries
 * @property {(input: object) => {previous: ProtocolEntry, entry: ProtocolEntry}} replaceEntry
 * @property {(input: object) => ProtocolEntry} removeEntry
 * @property {(input: object) => {removed: ProtocolEntry[], entry: ProtocolEntry}} consolidateEntries
 * @property {(input: object) => {superseded: ProtocolEntry[], entry: ProtocolEntry | null}} supersedeEntries
 * @property {(input: {ids: string[]}) => ProtocolEntry[]} restoreEntries
 * @property {(input: {ids: string[], tag: string}) => ProtocolEntry[]} tagEntries
 * @property {(id: string) => ProtocolEntry | null} entryById
 * @property {(row: object) => object} auditAppend
 * @property {(limit?: number) => object[]} auditList
 * @property {(input: object) => object | null} proposalUpsert
 * @property {(status?: string, limit?: number) => object[]} proposalList
 * @property {(id: string, status: string) => object} proposalDecide
 * @property {(input: {domain: string, level: number, tier?: string}) => ProfileRow} profileUpsert
 * @property {() => ProfileRow[]} profileList
 * @property {(domain: string) => ProfileRow | null} profileGet
 * @property {(sessionId: unknown) => boolean} sessionEnabled
 * @property {(sessionId: unknown, enabled: unknown) => boolean} sessionSetEnabled
 * @property {() => string[]} disabledSessionIds
 * @property {() => {id: string, createdAt: number, status: string} | null} tidyRequestPending
 * @property {() => {request: {id: string, createdAt: number, status: string}, created: boolean}} tidyRequestAdd
 * @property {() => {id: string, createdAt: number, status: string} | null} tidyRequestClear
 * @property {() => void} close
 */

/**
 * 协议写语义核心（dsh-memory-protocol v1 的参考实现，零 DSH 依赖）。
 *
 * 依赖注入的两个回调是它与具体 harness 的全部接触面：
 * - `gate(payload, write)`：写审批传输，返回 ApprovalOutcome；唯一放行值是
 *   `allowed-once`，其余（rejected/cancelled/unavailable）一律失败封闭并落
 *   `<action>-denied` 审计行。index.mjs 注入 ctx.approval 传输。
 * - `emit(session, type, data)`：会话事件派发回调（可选）；index.mjs 注入
 *   memory/* 词汇的已知类型自适应门。
 *
 * 写路径不变量（协议语义，一致性套件锁定）：
 * gate → 事务落盘 → 审计；任何一步失败无部分写入（v2 起写路径不再有预算门）；
 * 替换/删除/整合以唯一大小写不敏感子串定位，零/多命中结构化报错。
 */
export class MemoryProtocolCore {
  /**
   * @param {object} deps - 依赖。
   * @param {ProtocolStore} deps.store - Provider（lib/store.mjs 面）。
   * @param {ProtocolBudgets} deps.budgets - 每轨每层硬字符预算。
   * @param {string} deps.writePolicy - ask/auto/off（非法值响亮失败）。
   * @param {number} [deps.defaultQueryLimit] - query 缺省返回上限（默认 20）。
   * @param {string} [deps.sourceLabel] - 条目默认来源标注（默认 dsh-memento）。
   * @param {(payload: object, write: object) => Promise<string>} deps.gate - 审批传输。
   * @param {(session: object | null | undefined, type: string, data: object) => void} [deps.emit] - 会话事件派发。
   */
  constructor(deps) {
    this.store = deps.store
    this.budgetsConfig = deps.budgets
    this.limits = budgetLimits(deps.budgets)
    this.writePolicy = normalizeWritePolicy(deps.writePolicy)
    this.defaultQueryLimit = deps.defaultQueryLimit ?? 20
    this.sourceLabel = deps.sourceLabel ?? DEFAULT_SOURCE
    this.gate = deps.gate
    this.emit = deps.emit ?? (() => {})
  }

  /** @returns {Array<{track: string, scope: string, used: number, limit: number}>} 预算报表。 */
  budgets() {
    return budgetReport(this.store.listEntries(), this.budgetsConfig)
  }

  /**
   * 查询条目（读路径无审批；带 sessionId 时记 recalled 审计）。
   * @param {{track?: string, scope?: string, text?: string, limit?: number}} [filter] - {track, scope, text, limit}。
   * @param {{sessionId?: string, session?: import('../types.js').MemorySessionLike | null, agentKey?: string}} [opts] - {sessionId, session, agentKey}。
   * @returns {import('../types.js').MemoryQueryResult}。
   */
  query(filter = {}, opts = {}) {
    const { entries, total, truncated } = this.store.queryEntries({
      ...(filter.track === undefined ? {} : { track: filter.track }),
      ...(filter.scope === undefined ? {} : { scope: filter.scope }),
      ...(typeof filter.text === 'string' && filter.text.length > 0 ? { text: filter.text } : {}),
      limit: Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : this.defaultQueryLimit,
      ...(typeof opts.agentKey === 'string' ? { agentKey: opts.agentKey } : {}),
    })
    if (opts.sessionId !== undefined) {
      this.store.auditAppend({
        action: 'recalled',
        ...(filter.track === undefined ? {} : { track: filter.track }),
        ...(filter.scope === undefined ? {} : { scope: filter.scope }),
        text: typeof filter.text === 'string' ? filter.text : null,
        // F7-2：零命中也要留一行（outcome='empty'），否则召回命中率的分母只剩成功样本，
        // 「查了但没查到」的次数会在统计里凭空消失（失败要大声）。
        outcome: total > 0 ? 'ok' : 'empty',
        source: this.sourceLabel,
        sessionId: opts.sessionId,
      })
    }
    if (opts.session !== undefined && opts.session !== null) {
      this.emit(opts.session, SESSION_EVENTS.recalled, {
        query: typeof filter.text === 'string' ? filter.text : '',
        matches: total,
        sessionId: opts.sessionId ?? opts.session.id ?? '',
      })
    }
    return { entries, total, truncated }
  }

  /**
   * 新增条目（写：审批门）。
   * @param {{track: string, scope: string, text: string, source?: string, workspaceKey?: string, agentKey?: string, tags?: string[], facet?: string, level?: number}} input - 写入输入。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}；agent 缺失即失败封闭。
   * @returns {Promise<{entry: ProtocolEntry, usage: {track: string, scope: string, used: number, limit: number}}>}。
   */
  async add(input, write) {
    const { track, scope, text, tags, facet, level } = this.#validateEntry(input, write)
    const via = await this.#ask({ action: 'add', track, scope, text, source: input.source ?? this.sourceLabel }, write)
    this.#throwIfAborted(write)
    const entry = this.store.insertEntry({
      track, scope, text, tags, facet, level,
      workspaceKey: input.workspaceKey ?? this.#workspaceKeyOf(write),
      agentKey: input.agentKey ?? this.#agentKeyOf(write),
      source: input.source ?? this.sourceLabel,
      sessionId: write.agent.session?.id ?? null,
    })
    this.#auditWrite('add', track, scope, entry, write, via)
    this.#appendWriteEvent(write, SESSION_EVENTS.added, { entry, source: entry.source })
    return { entry, usage: this.#usage(track, scope) }
  }

  /**
   * 按唯一子串替换条目（写：审批门；零/多命中报错，绝不截断）。
   * facet/level 省略时保持原条目的画像坐标，显式传入才覆盖。
   * @param {{track: string, scope: string, match: string, text: string, source?: string, agentKey?: string, workspaceKey?: string, tags?: string[], facet?: string | null, level?: number | null}} input - 替换方案。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{previous: ProtocolEntry, entry: ProtocolEntry, usage: {track: string, scope: string, used: number, limit: number}}>}。
   */
  async replace(input, write) {
    const { track, scope, text, tags } = this.#validateEntry(input, write)
    this.#assertMatch(input)
    // 审批前先定位：零/多命中在打扰用户之前就响亮失败。
    const initial = this.#resolveMatch(input, track, scope, write)
    // 审批载荷携带将被改写的旧条目全文（approve-what-you-see：人批准的不是抽象动作，是具体变更）。
    const via = await this.#ask({
      action: 'replace', track, scope,
      text: `from:\n${initial.text}\n\nto:\n${text}`,
      source: input.source ?? this.sourceLabel,
    }, write)
    this.#throwIfAborted(write)
    // 事务内重新定位+更新：零/多命中仍会响亮报错（不静默）。
    const replaced = this.store.replaceEntry({
      track, scope, match: input.match, text,
      // 乐观锁：钉入审批时看到的版本，审批期间被并发改动即响亮失败（红队⑦：不静默覆盖）。
      expectedVersion: initial.version,
      ...(tags.length > 0 ? { tags } : {}),
      ...(input.facet === undefined ? {} : { facet: normalizeFacet(input.facet) }),
      ...(input.level === undefined ? {} : { level: normalizeLevel(input.level) }),
      sessionId: write.agent.session?.id ?? null,
    })
    this.#auditWrite('replace', track, scope, replaced.entry, write, via)
    this.#appendWriteEvent(write, SESSION_EVENTS.updated, {
      previous: replaced.previous,
      entry: replaced.entry,
      source: replaced.entry.source,
    })
    return { previous: replaced.previous, entry: replaced.entry, usage: this.#usage(track, scope) }
  }

  /**
   * 按唯一子串删除条目（写：审批门；零/多命中报错）。
   * @param {{track: string, scope: string, match: string, agentKey?: string, workspaceKey?: string}} input - 定位。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{entry: ProtocolEntry, usage: {track: string, scope: string, used: number, limit: number}}>}。
   */
  async remove(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('remove', write)
    this.#assertScope(input.track, input.scope)
    this.#assertMatch(input)
    // 审批前先定位：零/多命中在打扰用户之前就响亮失败。
    const target = this.#resolveMatch(input, input.track, input.scope, write)
    // 审批载荷携带将被删除的条目全文（approve-what-you-see），而非裸子串。
    const via = await this.#ask({ action: 'remove', track: input.track, scope: input.scope, text: target.text, source: target.source }, write)
    this.#throwIfAborted(write)
    const removed = this.store.removeEntry({ track: input.track, scope: input.scope, match: input.match })
    this.#auditWrite('remove', input.track, input.scope, removed, write, via)
    this.#appendWriteEvent(write, SESSION_EVENTS.removed, { entry: removed, source: removed.source })
    return { entry: removed, usage: this.#usage(input.track, input.scope) }
  }

  /**
   * 批量种子（一次 ask 审批整个批次；dsh-claude-move 等插件喂数据用）。
   * 整批在一事务内原子落盘，无部分写入（v2 起不再有预算拒绝）。
   * @param {Array<{track: string, scope: string, text: string, source?: string, workspaceKey?: string, agentKey?: string, tags?: string[], facet?: string, level?: number}>} inputs - 条目数组。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{added: number, entries: ProtocolEntry[]}>}。
   */
  async seed(inputs, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('seed', write)
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new InvalidInputError('seed requires a non-empty entry list')
    }
    const normalized = inputs.map((input) => {
      const { track, scope, text, tags, facet, level } = this.#validateEntry(input, write)
      return {
        track, scope, text, tags, facet, level,
        source: input.source ?? this.sourceLabel,
        workspaceKey: input.workspaceKey ?? this.#workspaceKeyOf(write),
        agentKey: input.agentKey ?? this.#agentKeyOf(write),
      }
    })
    const summary = normalized.map((entry) => `${entry.track}/${entry.scope}: ${entry.text}`).join('\n')
    // 同源批次把 source 带进审批载荷：粒度策略键 `source:<name>`（如观察通道的
    // `source:observation`）才有着力点；混源批次不带（回退 track/scope 与全局策略）。
    const sources = new Set(normalized.map((entry) => entry.source))
    const gateSource = sources.size === 1 ? normalized[0].source : undefined
    const via = await this.#ask({
      action: 'seed', track: 'batch', scope: 'batch', text: summary, count: normalized.length,
      ...(gateSource === undefined ? {} : { source: gateSource }),
    }, write)
    this.#throwIfAborted(write)
    const sessionId = write.agent.session?.id ?? null
    const entries = this.store.seedEntries(normalized.map((entry) => ({ ...entry, sessionId })))
    this.store.auditAppend({
      action: 'seed',
      track: null, scope: null, entryId: null,
      text: summary, outcome: this.#outcomeLabel(via),
      source: this.sourceLabel, sessionId,
    })
    for (const entry of entries) {
      this.#auditWrite('add', entry.track, entry.scope, entry, write, via)
      this.#appendWriteEvent(write, SESSION_EVENTS.added, { entry, source: entry.source })
    }
    return { added: entries.length, entries }
  }

  /**
   * 整合多个条目为一条新条目（写：审批门；一次审批 + Provider 单事务原子执行）。
   * 零/多命中、审批拒绝、目标在审批期间消失都响亮失败；任一步失败无部分写入。
   * @param {{track: string, scope: string, matches: string[], text: string, source?: string, workspaceKey?: string, agentKey?: string, tags?: string[], facet?: string, level?: number}} input - 整合方案。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{removed: ProtocolEntry[], entry: ProtocolEntry, usage: {track: string, scope: string, used: number, limit: number}}>}。
   */
  async consolidate(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('consolidate', write)
    const { track, scope, text, tags, facet, level } = this.#validateEntry(input, write)
    this.#assertConsolidateMatches(input)
    // 审批前先定位全部目标：零/多命中在打扰用户之前就响亮失败。
    const initial = input.matches.map((match) => this.#resolveMatch({ match }, track, scope, write))
    // 审批载荷携带每个目标的定位条目原文（单条超长只截前 300 字，避免 20×满预算条目撑爆载荷）。
    const plan = [
      ...initial.map((entry, index) => {
        const body = entry.text.length > 300 ? `${entry.text.slice(0, 300)}…` : entry.text
        return `remove: ${input.matches[index]}\n${body}`
      }),
      `new text: ${text}`,
    ].join('\n')
    const via = await this.#ask({ action: 'consolidate', track, scope, text: plan, source: input.source ?? this.sourceLabel }, write)
    this.#throwIfAborted(write)
    const { removed, entry } = this.store.consolidateEntries({
      track, scope, matches: input.matches, text,
      // 乐观锁：钉入审批时各目标的版本，并发改动即响亮失败（与 replace 同型）。
      expectedVersions: initial.map((entry) => entry.version),
      source: input.source ?? this.sourceLabel,
      workspaceKey: input.workspaceKey ?? this.#workspaceKeyOf(write),
      agentKey: input.agentKey ?? this.#agentKeyOf(write),
      ...(tags.length > 0 ? { tags } : {}),
      facet,
      level,
      sessionId: write.agent.session?.id ?? null,
    })
    const sessionId = write.agent.session?.id ?? null
    for (const old of removed) {
      this.store.auditAppend({
        action: 'consolidate-remove', track, scope, entryId: old.id, text: old.text,
        outcome: this.#outcomeLabel(via), source: old.source, sessionId,
      })
      this.#appendWriteEvent(write, SESSION_EVENTS.removed, { entry: old, source: old.source })
    }
    this.store.auditAppend({
      action: 'consolidate-add', track, scope, entryId: entry.id, text: entry.text,
      outcome: this.#outcomeLabel(via), source: entry.source, sessionId,
    })
    this.#appendWriteEvent(write, SESSION_EVENTS.added, { entry, source: entry.source })
    return { removed, entry, usage: this.#usage(track, scope) }
  }

  /**
   * 「整理全库」登记面（收边 §2，规格 3.5.9 的排队式按钮）：只写一条待整理标记，
   * 不调模型、不碰任何条目。真正的整理仍由模型在会话内显式跑（`memory action=tidy`
   * 看计划、`action=supersede` 落写），跑完由 `supersede` 清掉这条标记。
   *
   * 审批：走注入的 gate。面板按钮不来自任何会话（connection.fetch 路由没有 agent），
   * 因此 `write.agent.session` 为 null —— 审计行的 sessionId 也如实为 null，不编造
   * 归属；面板来源用 turn 外 gate（与 /memory 命令同一条 waterfall、同一套 writePolicy）。
   * @param {{source?: string}} input - {source?}（缺省 `panel`；登记只能来自面板，故除来源外没有别的入参）。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{request: {id: string, createdAt: number, status: string}, created: boolean}>} 标记行与「本次是否新建」。
   */
  async requestTidy(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('tidy-request', write)
    const source = typeof input?.source === 'string' && input.source.length > 0 ? input.source : PANEL_SOURCE
    const via = await this.#ask({
      action: 'tidy-request',
      track: LIBRARY_BUCKET.track,
      scope: LIBRARY_BUCKET.scope,
      text: `${source} asked for a whole-library tidy (marker only: no entry is touched and no model is called here; the model runs the tidy inside a session)`,
      source,
    }, write)
    const { request, created } = this.store.tidyRequestAdd()
    this.store.auditAppend({
      action: 'tidy-request',
      track: null,
      scope: null,
      entryId: null,
      // 标记表里没有正文可记：审计只记「谁登的、结果如何」，text 恒为 null。
      text: null,
      outcome: `${created ? 'registered' : 'already-pending'} ${this.#outcomeLabel(via)}`,
      source,
      sessionId: /** @type {string | null} */ (write.agent.session?.id ?? null),
    })
    return { request, created }
  }

  /**
   * 整理机的落写面（F6）：按 id 批量把旧条目降级为 `superseded`（留痕、可回滚、
   * 不物理删），并可同时落一条合并后的新条目（自带 `merged` 标）。与 consolidate
   * 的差别只有一条：consolidate 物理删旧条目，本动作把旧条目留痕降级。
   *
   * 语义红线（与写路径同档）：
   * - 未知 id、已降级目标、跨桶混装、审批未放行，一律响亮失败且整批回滚；
   * - **桶内不跨**（规格 3.5.8）：所有 id 必须同属一个 `track × scope × agentKey`
   *   （scope=workspace 时还须同 workspaceKey）——跨桶合并会污染作用域；
   * - **合并条目继承源桶**：新条目的 agentKey / workspaceKey 取自 `targets[0]`，与写方会话的
   *   preset 无关（显式 input 才覆盖）；写方会话键只用于判断可见集；
   * - 审批载荷携带每个目标的原文（approve-what-you-see），但**审计行 `text` 恒为
   *   null、只记 id**（降级是元数据动作，审计不复制正文；新条目照常记 text）。
   * @param {{ids: string[], text?: string, tags?: string[], facet?: string | null, level?: number | null, source?: string, workspaceKey?: string, agentKey?: string}} input - {ids, text?, tags?, facet?, level?, source?}。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{superseded: ProtocolEntry[], entry: ProtocolEntry | null, usage: {track: string, scope: string, used: number, limit: number}, tidyRequestCleared: boolean}>} 降级清单、合并条目、用量，以及本次是否清掉了待整理标记。
   */
  async supersede(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('supersede', write)
    if (input === null || typeof input !== 'object') {
      throw new InvalidInputError('supersede input must be an object')
    }
    const ids = assertEntryIdList(input.ids, 'supersede')
    const mergeText = input.text === undefined ? undefined : assertEntryText(input.text)
    const tags = mergeText === undefined ? [] : normalizeTags([...normalizeTags(input.tags), MERGED_TAG])
    const facet = normalizeFacet(input.facet)
    const level = normalizeLevel(input.level)
    // 审批前先定位：未知 id / 已降级 / 出会话可见集 / 跨桶在打扰用户之前就响亮失败。
    const visibleAgentKey = typeof input.agentKey === 'string' && input.agentKey.length > 0 ? input.agentKey : this.#agentKeyOf(write)
    const visibleWorkspaceKey = typeof input.workspaceKey === 'string' && input.workspaceKey.length > 0 ? input.workspaceKey : this.#workspaceKeyOf(write)
    const targets = ids.map((id) => {
      const entry = this.store.entryById(id)
      if (entry === null) throw new InvalidInputError(`no entry with id ${JSON.stringify(id)}; nothing was changed`)
      if (entry.status !== ACTIVE_STATUS) throw new InvalidInputError(`entry ${JSON.stringify(id)} is already ${entry.status}; only active entries can be superseded`)
      this.#assertVisible(entry, visibleAgentKey, visibleWorkspaceKey)
      return entry
    })
    assertSameBucket(targets)
    const { track, scope } = targets[0]
    // 合并条目**继承源桶**（红队②高 1）：目标的 agentKey / workspaceKey 由 targets[0] 决定
    // （assertSameBucket 已保证同桶），写方会话的 agentKey 只用来判断「本会话能不能看见」。
    // 拿写方会话的键当落桶键，会让带 preset 的会话把共享记忆静默收进该 agent 专属（单向不可逆）。
    // 显式 input 仍以显式为准（既有跨桶覆盖能力不变）。
    const agentKey = typeof input.agentKey === 'string' && input.agentKey.length > 0 ? input.agentKey : targets[0].agentKey
    const workspaceKey = typeof input.workspaceKey === 'string' && input.workspaceKey.length > 0 ? input.workspaceKey : targets[0].workspaceKey
    const source = input.source ?? this.sourceLabel
    const plan = [
      ...targets.map((entry, index) => {
        const body = entry.text.length > 300 ? `${entry.text.slice(0, 300)}…` : entry.text
        return `supersede: ${ids[index]}\n${body}`
      }),
      ...(mergeText === undefined ? [] : [`merged text: ${mergeText}`]),
    ].join('\n')
    const via = await this.#ask({ action: 'supersede', track, scope, text: plan, source }, write)
    this.#throwIfAborted(write)
    const sessionId = write.agent.session?.id ?? null
    const { superseded, entry } = this.store.supersedeEntries({
      ids,
      ...(mergeText === undefined ? {} : { text: mergeText, tags }),
      facet,
      level,
      source,
      workspaceKey,
      agentKey,
      sessionId,
    })
    for (const old of superseded) {
      // 审计只记 id：text 恒为 null（降级不复制正文），时间线由审计行的 ts 承担。
      this.store.auditAppend({
        action: 'supersede', track: old.track, scope: old.scope, entryId: old.id, text: null,
        outcome: this.#outcomeLabel(via), source: old.source, sessionId,
      })
      this.#appendWriteEvent(write, SESSION_EVENTS.removed, { entry: old, source: old.source })
    }
    if (entry !== null) {
      this.store.auditAppend({
        action: 'supersede-add', track: entry.track, scope: entry.scope, entryId: entry.id, text: entry.text,
        outcome: this.#outcomeLabel(via), source: entry.source, sessionId,
      })
      this.#appendWriteEvent(write, SESSION_EVENTS.added, { entry, source: entry.source })
    }
    // 收尾回执（规格 3.5.7「摘要 / 回执 / 审计」）：一行变更摘要，`/memory audit` 可查、
    // 同时充当整理机的「上次整理」时间锚（index.mjs 的开工线据此算积压）。
    this.store.auditAppend({
      action: 'consolidation',
      track,
      scope,
      entryId: null,
      text: `superseded ${superseded.length} (${superseded.map((old) => old.id).join(', ')})${entry === null ? '; no merged entry' : `; merged entry ${entry.id} tagged ${MERGED_TAG}`}`,
      outcome: this.#outcomeLabel(via),
      source,
      sessionId,
    })
    // 收边（§2）：用户点过「整理全库」时库里有一条待整理标记，本次整理跑完即结案
    // （pending → done；审计再落一行，text 恒为 null）。标记只在模型显式落写之后消失——
    // 面板点一下绝不等于记忆被整理过。
    const cleared = /** @type {{id: string, createdAt: number, status: string} | null} */ (this.store.tidyRequestClear())
    if (cleared !== null) {
      this.store.auditAppend({
        action: 'tidy-request',
        track,
        scope,
        entryId: null,
        text: null,
        outcome: `cleared ${this.#outcomeLabel(via)}`,
        source,
        sessionId,
      })
    }
    return { superseded, entry, usage: this.#usage(track, scope), tidyRequestCleared: cleared !== null }
  }

  /**
   * 自动整理落写面（F8 把握分级的内核出口）：把一批候选交给内核**自己重跑一遍分级**，
   * 只有判为 `auto` 的批次才落写。调用方（工具面、后台无头会话、命令面）只能提议
   * 「这几个 id ＋ 这段合并文本」，不能声明「这是 auto」——判定的强制点在核心内部、
   * 与审批门同级，任何调用路径都绕不过。
   *
   * 复用 `supersede` 的全部红线：审批门、会话开关、桶内不跨、合并条目继承源桶、
   * 审计形状（降级行 `text` 恒为 `null`、每批一行 `consolidation` 摘要）、待整理标记清理。
   * 与非自动路径的唯一差别是入口多一道分级守门：verdict 不是 `auto` 即结构化拒绝、零落盘。
   * @param {{ids: string[], text: string, tags?: string[], facet?: string | null, level?: number | null}} input - {ids, text, tags?, facet?, level?}；来源由动作自己钉死为 `AUTO_TIDY_SOURCE`，不接受覆盖。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{grade: ReturnType<typeof gradeMerge>, superseded: ProtocolEntry[], entry: ProtocolEntry | null, usage: {track: string, scope: string, used: number, limit: number}, tidyRequestCleared: boolean}>} 分级依据（含逐杠明细，可复述）与落写结果。
   */
  async autoTidy(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('auto-tidy', write)
    if (input === null || typeof input !== 'object') {
      throw new InvalidInputError('auto-tidy input must be an object')
    }
    const ids = assertEntryIdList(input.ids, 'auto-tidy')
    const mergedText = assertEntryText(input.text)
    // 分级之前先定位：未知 id / 已降级 / 出会话可见集，在打扰审批之前就响亮失败。
    const targets = this.#resolveByIds(ids, write, ACTIVE_STATUS, 'auto-tidy')
    assertSameBucket(targets, 'auto-tidy')
    const grade = gradeMerge({ members: targets, mergedText })
    if (grade.verdict !== 'auto') {
      throw new InvalidInputError(
        `auto-tidy refused: this batch grades as ${grade.verdict} (failed gates: ${grade.failed.length === 0 ? 'none' : grade.failed.join(', ')}; similarity ${grade.similarity}, coverage ${grade.coverage}); only an auto-grade batch is written without a human pass`,
      )
    }
    // 来源由动作自己钉死，不接受调用方覆盖：`source:auto-tidy` 这个粒度键要可信，
    // 否则「把自动整理设成 off」会被一个伪造的来源名绕过，审计也分不出这活是谁干的。
    const result = await this.supersede({
      ids,
      text: mergedText,
      tags: input.tags,
      facet: input.facet,
      level: input.level,
      source: AUTO_TIDY_SOURCE,
    }, write)
    return { grade, ...result }
  }

  /**
   * soft delete 的回滚面（S5 §1）：把降级过的条目救回在场集（`superseded → active`）。
   * 与 `supersede` 严格互逆：**只允许 superseded → active**，目标是 active（或未知 id）即
   * 响亮失败；回滚只动会话可见集（与写定位同语义：跨 agent / 跨工作区的条目本会话看不见，
   * 也就不该由本会话救回）。恢复的条目 `version` 不自增——它没被改写。
   * @param {{ids: string[], source?: string}} input - {ids, source?}（source 缺省走治理面标注 `governance`）。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{restored: ProtocolEntry[], usage: {track: string, scope: string, used: number, limit: number}}>}。
   */
  async restore(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('restore', write)
    if (input === null || typeof input !== 'object') {
      throw new InvalidInputError('restore input must be an object')
    }
    const ids = assertEntryIdList(input.ids, 'restore')
    // 审批前先定位：未知 id / 已在场 / 出会话可见集在打扰用户之前就响亮失败。
    const targets = this.#resolveByIds(ids, write, SUPERSEDED_STATUS)
    const { track, scope } = targets[0]
    const source = input.source ?? GOVERNANCE_SOURCE
    const plan = targets
      .map((entry, index) => `restore: ${ids[index]}\n${snippetOf(entry.text)}`)
      .join('\n')
    const via = await this.#ask({ action: 'restore', track, scope, text: plan, source }, write)
    this.#throwIfAborted(write)
    const sessionId = /** @type {string | null} */ (write.agent.session?.id ?? null)
    const restored = /** @type {ProtocolEntry[]} */ (this.store.restoreEntries({ ids }))
    for (const entry of restored) {
      this.#auditGovernance('restore', entry, write, via, sessionId, String(entry.text))
      this.#appendWriteEvent(write, SESSION_EVENTS.added, { entry, source: entry.source })
    }
    return { restored, usage: this.#usage(track, scope) }
  }

  /**
   * 分面裁决（S5 §2）：同一件事上「观察」与「自陈」冲突时，按 `ARBITRATION_BY_FACET` 裁决。
   * 方向由**表**决定，调用方没有反向参数——「能力听观察、意愿听自陈」是代码不变量，不是纪律。
   *
   * 语义红线（与写路径同档）：
   * - 至少各有一条 observation（`source='observation'`）与一条 self（其余来源）；
   * - 两组 facet 必须一致（都是同一个七面值），不一致或为空一律响亮拒绝，不猜；
   * - 同组多条时取 `updatedAt` 最新者保留，其余**同组条目一并降级**（规则可复核，不给模型挑的机会）；
   * - **保留者在审批后复检**：审批窗口里 champion 被降级（或消失）即响亮失败、零落盘，
   *   绝不写一句与库况相反的「kept X」审计；
   * - coexist 面：两条都不降级，两组各打一枚 `gap` 标（落差是证据）；
   * - 一次审批；落盘是**两次各自原子的 store 事务**——降级一批、打标一批（审批在两次落盘之前
   *   已完成，故不存在「没批就写」的旁路；跨这两个动作则不具备单一事务的原子性）。
   * @param {{ids: string[], source?: string}} input - {ids, source?}（source 缺省走治理面标注 `governance`）。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{facet: string, direction: string, kept: ProtocolEntry[], demoted: ProtocolEntry[], tagged: ProtocolEntry[], usage: {track: string, scope: string, used: number, limit: number}}>}。
   */
  async arbitrate(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('arbitrate', write)
    if (input === null || typeof input !== 'object') {
      throw new InvalidInputError('arbitrate input must be an object')
    }
    const ids = assertEntryIdList(input.ids, 'arbitrate')
    const targets = this.#resolveByIds(ids, write)
    // 桶边界先于面校验：跨桶要在「两组面不一致」之前报出来，病因才对得上（两种都拒，只是顺序）。
    assertSameBucket(targets, 'arbitrate')
    const { track, scope } = targets[0]
    const facet = assertArbitrationFacet(targets)
    const direction = ARBITRATION_BY_FACET[/** @type {keyof typeof ARBITRATION_BY_FACET} */ (facet)]
    const observation = targets.filter((entry) => entry.source === OBSERVATION_SOURCE)
    const self = targets.filter((entry) => entry.source !== OBSERVATION_SOURCE)
    if (observation.length === 0) {
      throw new InvalidInputError(`arbitrate needs at least one observation entry (source ${JSON.stringify(OBSERVATION_SOURCE)}) among the targets; all ${targets.length} came from other sources, so there is no cross-source gap to judge`)
    }
    if (self.length === 0) {
      throw new InvalidInputError(`arbitrate needs at least one self-report entry among the targets; all ${targets.length} are observations, so there is no cross-source gap to judge`)
    }
    const hasGap = direction === ARBITRATION_COEXIST
    // 保留者是「听的那一组」里 updatedAt 最新的一条；另一组整体降级，听的那一组的多余条目一并降级。
    /** @type {ProtocolEntry[]} */
    let kept = []
    /** @type {ProtocolEntry[]} */
    let demoted = []
    if (!hasGap) {
      const winner = direction === ARBITRATION_SELF_REPORT ? self : observation
      const loser = direction === ARBITRATION_SELF_REPORT ? observation : self
      const champion = latestOf(winner)
      kept = [champion]
      demoted = [...winner.filter((entry) => entry.id !== champion.id), ...loser]
    }
    const source = input.source ?? GOVERNANCE_SOURCE
    const plan = [
      `facet: ${facet} → arbitrate by ${direction}`,
      ...(hasGap
        ? [
            'keep both (coexist): the gap itself is the evidence',
            ...targets.map((entry) => `tag ${GAP_TAG}: ${entry.id} [${entry.source}]\n${snippetOf(entry.text)}`),
          ]
        : [
            ...kept.map((entry) => `keep: ${entry.id} [${entry.source}]\n${snippetOf(entry.text)}`),
            ...demoted.map((entry) => `demote: ${entry.id} [${entry.source}]\n${snippetOf(entry.text)}`),
          ]),
    ].join('\n')
    const via = await this.#ask({ action: 'arbitrate', track, scope, text: plan, source }, write)
    this.#throwIfAborted(write)
    // 审批放行后、落盘之前复检保留者（红队②高 2）：审批窗口里 champion 可能已被降级，
    // 不复检就会写一句与库况相反的「kept X」审计（库、审计、可见集三处说法对不上）。
    // 与 supersede 的「审批期间目标变了就响亮失败」对齐：宁可失败让模型重来，零落盘。
    // coexist 面没有保留者，跳过这一步。
    if (kept.length > 0) {
      const fresh = this.store.entryById(kept[0].id)
      if (fresh === null || fresh.status !== ACTIVE_STATUS) {
        throw new InvalidInputError(`arbitrate would keep ${JSON.stringify(kept[0].id)}, but it is ${fresh === null ? 'unknown' : fresh.status} now; nothing was changed, re-read the entries and arbitrate again`)
      }
      // 审批期间它可能被 replace 过：回带库里当下的快照，而不是审批前缓存的那一份。
      kept = [fresh]
    }
    const sessionId = /** @type {string | null} */ (write.agent.session?.id ?? null)
    const demotedRows = demoted.length === 0 ? [] : this.store.supersedeEntries({ ids: demoted.map((entry) => entry.id) }).superseded
    const taggedRows = hasGap ? this.store.tagEntries({ ids: targets.map((entry) => entry.id), tag: GAP_TAG }) : []
    for (const entry of demotedRows) {
      // 与整理机同形：降级审计只记 id，text 恒为 null（降级是元数据动作，审计不复制正文）。
      this.#auditGovernance('arbitrate', entry, write, via, sessionId, null)
      this.#appendWriteEvent(write, SESSION_EVENTS.removed, { entry, source: entry.source })
    }
    for (const entry of taggedRows) {
      this.#auditGovernance('arbitrate-tag', entry, write, via, sessionId, String(entry.text))
    }
    // 收尾一行裁决摘要：`/memory audit` 可查，写清「按面裁决：保留谁、降级谁、理由」。
    this.store.auditAppend({
      action: 'arbitrate',
      track,
      scope,
      entryId: null,
      text: `facet ${facet} → ${direction}: ${hasGap
        ? `kept both, tagged ${GAP_TAG} on ${targets.length} (${targets.map((entry) => entry.id).join(', ')})`
        : `kept ${kept[0].id} (${kept[0].source}), demoted ${demotedRows.length} (${demotedRows.map((entry) => entry.id).join(', ')})`}`,
      outcome: this.#outcomeLabel(via),
      source,
      sessionId,
    })
    return { facet, direction, kept, demoted: demotedRows, tagged: taggedRows, usage: this.#usage(track, scope) }
  }

  /**
   * 分领域知识水平列表（读路径无审批，与 query 同待遇）。
   * @returns {ProfileRow[]} 全部画像行（按 domain 升序）。
   */
  listProfiles() {
    return this.store.profileList()
  }

  /**
   * 按领域读单条画像行（读路径无审批）。
   * @param {string} domain - 知识子领域名（KNOWLEDGE_DOMAINS 之一）。
   * @returns {ProfileRow | null} 画像行；未记录返回 null。
   */
  getProfile(domain) {
    return this.store.profileGet(assertKnowledgeDomain(domain))
  }

  /**
   * 幂等写入一条分领域知识水平（写：审批门 + 审计；domain 主键，覆盖旧值）。
   * 审批载荷携带 from → to（approve-what-you-see）：人批准的是具体档位变更。
   * tier 缺省由 level 推导（tierForLevel）；domain/level/tier 非法在打扰用户之前响亮失败。
   * @param {{domain: string, level: number, tier?: string, source?: string}} input - {domain, level, tier?, source?}。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{profile: ProfileRow, previous: ProfileRow | null}>} 已落盘画像行与旧值（首次写入为 null）。
   */
  async setProfile(input, write) {
    this.#assertAgent(write)
    this.#assertSessionOn('profile', write)
    const domain = assertKnowledgeDomain(input.domain)
    if (!Number.isInteger(input.level) || input.level < 1 || input.level > 10) {
      throw new InvalidInputError(`profile level must be an integer 1..10 (got ${JSON.stringify(input.level)})`)
    }
    const level = input.level
    const tier = input.tier ?? tierForLevel(level)
    if (!/** @type {readonly string[]} */ (KNOWLEDGE_TIERS).includes(tier)) {
      throw new InvalidInputError(`profile tier must be one of ${KNOWLEDGE_TIERS.join('|')} (got ${JSON.stringify(tier)})`)
    }
    const previous = /** @type {{domain: string, level: number, tier: string, updatedAt: number} | null} */ (this.store.profileGet(domain))
    // 画像写归 user 轨的 user-global 层：粒度策略表（user/user-global、source:<name>）对它同样生效。
    const plan = previous === null
      ? `domain: ${domain}\nlevel: ${level}/10 (${tier})`
      : `domain: ${domain}\nlevel: ${previous.level}/10 (${previous.tier}) → ${level}/10 (${tier})`
    const source = input.source ?? this.sourceLabel
    const via = await this.#ask({ action: 'profile', track: 'user', scope: 'user-global', text: plan, source }, write)
    this.#throwIfAborted(write)
    const profile = this.store.profileUpsert({ domain, level, tier })
    this.store.auditAppend({
      action: 'profile-set',
      track: 'user',
      scope: 'user-global',
      entryId: null,
      text: plan,
      outcome: this.#outcomeLabel(via),
      source,
      sessionId: write.agent.session?.id ?? null,
    })
    return { profile, previous }
  }

  /**
   * 写路径审批门。默认走注入的 gate（index.mjs 注入 ctx.approval.request 传输）。
   * write.gate 为可选自定义传输（/memory 命令在 turn 外使用：同一裁决语义）。
   * 被拒（rejected/cancelled/unavailable/off）一律落 `<action>-denied` 审计行再抛——
   * turn 外 gate 路径没有审批审计对，这是拒绝的唯一证据链。
   * @param {{action: string, track: string, scope: string, text: string, count?: number, source?: string}} payload - {action, track, scope, text, count?}。
   * @param {import('../types.js').MemoryWriteContext} write - {agent, callId?, signal?, gate?}。
   * @returns {Promise<{outcome: string, source: 'approval'|'gate'}>} 实际裁决结果与传输来源（审计标签用）。
   */
  async #ask(payload, write) {
    try {
      // 纵深防御：write.gate 只能是被内部登记过的传输；伪造的 gate 一律拒绝（不静默回落）。
      if (write.gate !== undefined && !TRUSTED_GATES.has(/** @type {object} */ (write.gate))) {
        throw new InvalidInputError('write.gate is not a trusted approval transport; only the command path may override the approval gate')
      }
      const via = typeof write.gate === 'function'
        ? { outcome: await write.gate(payload, write), source: /** @type {'approval'|'gate'} */ ('gate') }
        : { outcome: await this.gate(payload, write), source: /** @type {'approval'|'gate'} */ ('approval') }
      this.#assertOutcome(via.outcome)
      return via
    } catch (error) {
      if (error instanceof WriteDeniedError) {
        const outcome = typeof error.details.outcome === 'string' ? error.details.outcome : 'denied'
        const viaLabel = typeof write.gate === 'function'
          ? `${outcome} (via write gate)`
          : `${outcome} (via approval, writePolicy ${this.writePolicy})`
        this.store.auditAppend({
          action: `${payload.action}-denied`,
          track: payload.track,
          scope: payload.scope,
          entryId: null,
          text: payload.text,
          outcome: viaLabel,
          source: payload.source ?? this.sourceLabel,
          sessionId: write.agent?.session?.id ?? null,
        })
      }
      throw error
    }
  }

  /** 审计 outcome 标签：审批传输标注策略，gate 传输标注 gate（真实裁决来源，不张冠李戴）。 */
  #outcomeLabel(/** @type {{outcome: string, source: 'approval'|'gate'}} */ via) {
    return via.source === 'gate'
      ? `${via.outcome} (via write gate)`
      : `${via.outcome} (via approval, writePolicy ${this.writePolicy})`
  }

  /**
   * 会话可见集内的按 id 定位（治理面 restore/arbitrate 共用）：未知 id / 状态不符 / 出可见集
   * 一律响亮失败，绝不静默跳过（治理动作谎报成功比失败更坏），且全部发生在审批门之前。
   * @param {string[]} ids - 目标条目 id。
   * @param {import('../types.js').MemoryWriteContext} write - {agent}。
   * @param {'active' | 'superseded'} [expectedStatus] - 该动作要求的状态（缺省 active；restore 传 superseded）。
   * @param {string} [action] - 动作名（报错文案用；缺省 arbitrate）。
   * @returns {ProtocolEntry[]} 目标条目（与 ids 同序）。
   */
  #resolveByIds(ids, write, expectedStatus = ACTIVE_STATUS, action = 'arbitrate') {
    const agentKey = this.#agentKeyOf(write)
    const workspaceKey = this.#workspaceKeyOf(write)
    return ids.map((id) => {
      const entry = this.store.entryById(id)
      if (entry === null) throw new InvalidInputError(`no entry with id ${JSON.stringify(id)}; nothing was changed`)
      if (entry.status !== expectedStatus) {
        const hint = expectedStatus === SUPERSEDED_STATUS
          ? 'only superseded entries can be restored'
          : `only active entries can be passed to ${action} (use restore to bring a superseded entry back first)`
        throw new InvalidInputError(`entry ${JSON.stringify(id)} is ${entry.status}; ${hint}`)
      }
      this.#assertVisible(entry, agentKey, workspaceKey)
      return entry
    })
  }

  /** 治理面审计行（S5）：restore 与 arbitrate 共用形状，`text` 由调用方决定（降级/打标行传 null）。 */
  #auditGovernance(/** @type {string} */ action, /** @type {ProtocolEntry} */ entry, /** @type {import('../types.js').MemoryWriteContext} */ write, /** @type {{outcome: string, source: 'approval'|'gate'}} */ via, /** @type {string | null} */ sessionId, /** @type {string | null} */ text) {
    this.store.auditAppend({
      action,
      track: entry.track,
      scope: entry.scope,
      entryId: entry.id,
      text,
      outcome: this.#outcomeLabel(via),
      source: entry.source,
      sessionId,
    })
  }

  /** 写路径必须有 agent（审批路由与审计归属）：缺失即失败封闭。 */
  #assertAgent(/** @type {import('../types.js').MemoryWriteContext} */ write) {
    if (write === null || typeof write !== 'object' || write.agent === undefined || write.agent === null) {
      throw new NoAgentError()
    }
  }

  /**
   * 会话级记忆开关门（F5）：会话关闭时写一律拒绝，位置与审批门同级（在 gate 与任何
   * 落盘之前），因此工具路径、命令路径、import、提案 approve 全都绕不过。
   * 拒绝时落一条 outcome='session-off' 的审计行（只记动作与会话，text 恒为 null）：
   * 「这个会话不留痕」连被拒的正文也不留。
   * @param {string} action - 写动作名（审计行 action；与成功行同名，靠 outcome 区分）。
   * @param {import('../types.js').MemoryWriteContext} write - {agent}。
   */
  #assertSessionOn(/** @type {string} */ action, /** @type {import('../types.js').MemoryWriteContext} */ write) {
    const sessionId = write.agent?.session?.id
    if (this.store.sessionEnabled(sessionId)) return
    this.store.auditAppend({
      action,
      track: null,
      scope: null,
      entryId: null,
      text: null,
      outcome: SESSION_OFF_OUTCOME,
      source: this.sourceLabel,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
    })
    throw new SessionMemoryOffError(typeof sessionId === 'string' ? sessionId : undefined)
  }

  /** track/scope 词汇校验（响亮失败，绝不落到 SQL）。 */
  #assertScope(/** @type {string} */ track, /** @type {string} */ scope) {
    if (!/** @type {readonly string[]} */ (TRACKS).includes(track) || !/** @type {readonly string[]} */ (SCOPES).includes(scope)) {
      throw new InvalidInputError(`invalid memory scope: track=${JSON.stringify(track)} scope=${JSON.stringify(scope)} (track ∈ ${TRACKS.join('|')}, scope ∈ ${SCOPES.join('|')})`)
    }
  }

  /** match 参数校验（replace/remove 共用）。 */
  #assertMatch(/** @type {{match?: unknown}} */ input) {
    if (typeof input.match !== 'string' || input.match.length === 0) {
      throw new InvalidInputError('replace/remove match must be a non-empty string')
    }
  }

  /** consolidate matches 校验（1..MAX_CONSOLIDATE_MATCHES 个非空字符串）。 */
  #assertConsolidateMatches(/** @type {{matches?: unknown}} */ input) {
    if (!Array.isArray(input.matches) || input.matches.length === 0 || input.matches.length > MAX_CONSOLIDATE_MATCHES) {
      throw new InvalidInputError(`consolidate matches must be an array of 1..${MAX_CONSOLIDATE_MATCHES} non-empty strings`)
    }
    for (const match of input.matches) {
      if (typeof match !== 'string' || match.length === 0) {
        throw new InvalidInputError(`consolidate matches must be an array of 1..${MAX_CONSOLIDATE_MATCHES} non-empty strings`)
      }
    }
  }

  /** 条目公共校验：agent + scope + 非空文本 + 标签 + facet 词汇 + level 范围。 */
  #validateEntry(/** @type {{track: string, scope: string, text: string, tags?: string[], facet?: string, level?: number}} */ input, /** @type {import('../types.js').MemoryWriteContext} */ write) {
    this.#assertAgent(write)
    this.#assertSessionOn('write', write)
    if (input === null || typeof input !== 'object') {
      throw new InvalidInputError('memory entry input must be an object')
    }
    this.#assertScope(input.track, input.scope)
    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new InvalidInputError('entry text must be a non-empty string')
    }
    if (input.text.includes('\u0000')) {
      throw new InvalidInputError('entry text must not contain U+0000 (NUL)')
    }
    return {
      track: input.track,
      scope: input.scope,
      text: input.text,
      tags: normalizeTags(input.tags),
      facet: normalizeFacet(input.facet),
      level: normalizeLevel(input.level),
    }
  }

  /**
   * 审批前定位替换/删除目标（唯一子串语义，大小写不敏感，零/多命中结构化报错）。
   * 写定位 = 会话可见集：agentKey 共享 + 写方会话键（显式 input 覆盖）；scope='workspace'
   * 时按写方会话 cwd 键过滤——跨 agent/跨工作区条目对本会话不可见、也不可被误改。
   */
  #resolveMatch(/** @type {{match: string, agentKey?: string, workspaceKey?: string}} */ input, /** @type {string} */ track, /** @type {string} */ scope, /** @type {import('../types.js').MemoryWriteContext} */ write) {
    const agentKey = typeof input.agentKey === 'string' && input.agentKey.length > 0 ? input.agentKey : this.#agentKeyOf(write)
    const workspaceKey = typeof input.workspaceKey === 'string' && input.workspaceKey.length > 0 ? input.workspaceKey : this.#workspaceKeyOf(write)
    const hits = /** @type {ProtocolEntry[]} */ (this.store.matchCandidates(track, scope, input.match, {
      agentKey,
      workspaceKey: scope === 'workspace' ? workspaceKey : undefined,
    }))
      .filter((entry) => entry.text.toLowerCase().includes(input.match.toLowerCase()))
    if (hits.length === 0) throw new EntryNotFoundError({ track, scope, match: input.match })
    if (hits.length > 1) {
      throw new AmbiguousMatchError({
        track, scope, match: input.match,
        candidates: hits.length,
        sample: hits.map((entry) => entry.text.length > 200 ? `${entry.text.slice(0, 200)}…` : entry.text),
      })
    }
    return hits[0]
  }

  // v2：预算门已拆——写入永不因容量被拒，故 #assertBudget 整体移除。

  /** 审批结果门：唯一放行是 allowed-once。 */
  #assertOutcome(/** @type {string} */ outcome) {
    if (outcome !== 'allowed-once') throw new WriteDeniedError(outcome)
  }

  /** @param {{signal?: AbortSignal}} write - {signal?}。 */
  #throwIfAborted(write) {
    write.signal?.throwIfAborted()
  }

  /** 写成功的审计行（outcome 携带真实裁决来源：审批传输标注策略，gate 传输标注 gate）。 */
  #auditWrite(/** @type {string} */ action, /** @type {string} */ track, /** @type {string} */ scope, /** @type {ProtocolEntry} */ entry, /** @type {import('../types.js').MemoryWriteContext} */ write, /** @type {{outcome: string, source: 'approval'|'gate'}} */ via) {
    this.store.auditAppend({
      action,
      track,
      scope,
      entryId: entry.id,
      text: entry.text,
      outcome: this.#outcomeLabel(via),
      source: entry.source,
      sessionId: write.agent.session?.id ?? null,
    })
  }

  /** 写事件派发（emit 回调决定是否落会话日志——index.mjs 注入已知类型自适应门）。 */
  #appendWriteEvent(/** @type {import('../types.js').MemoryWriteContext} */ write, /** @type {string} */ type, /** @type {object} */ data) {
    const sessionId = write.agent.session?.id ?? ''
    this.emit(write.agent.session, type, { ...data, sessionId })
  }

  /**
   * 会话可见集校验（整理只动会话可见集，规格 3.5.8 / 方案 §6）：agentKey 为共享层或
   * 本会话键；scope=workspace 时 workspaceKey 必须相等。跨 agent / 跨工作区的条目
   * 对本会话不可见，也就不该被本会话的整理碰。
   */
  #assertVisible(/** @type {ProtocolEntry} */ entry, /** @type {string} */ agentKey, /** @type {string} */ workspaceKey) {
    if (entry.agentKey !== '' && entry.agentKey !== agentKey) {
      throw new InvalidInputError(`entry ${JSON.stringify(entry.id)} belongs to agent ${JSON.stringify(entry.agentKey)}, which this session cannot see; tidy only touches the session-visible set`)
    }
    if (entry.scope === 'workspace' && entry.workspaceKey !== workspaceKey) {
      throw new InvalidInputError(`entry ${JSON.stringify(entry.id)} belongs to workspace ${JSON.stringify(entry.workspaceKey)}, not this session's workspace; tidy only touches the session-visible set`)
    }
  }

  /** (track, scope) 用量与上限（工具结果回带，模型据此整合重试）。 */
  #usage(/** @type {string} */ track, /** @type {string} */ scope) {
    return { track, scope, used: this.store.usage(track, scope), limit: this.limits[/** @type {'user'|'agent'} */ (track)][/** @type {'user-global'|'workspace'} */ (scope)] }
  }

  /** @param {{agent?: {session?: import('../types.js').MemorySessionLike | null} | null}} write - {agent}。 */
  #workspaceKeyOf(write) {
    return workspaceKeyOf(/** @type {string | undefined} */ (write.agent?.session?.header?.cwd))
  }

  /** @param {{agent?: {session?: import('../types.js').MemorySessionLike | null} | null}} write - {agent}。 */
  #agentKeyOf(write) {
    return agentKeyOf(/** @type {string | undefined} */ (write.agent?.session?.header?.agentPreset))
  }
}

/**
 * 知识子领域名校验（profile 读写共用）：非 KNOWLEDGE_DOMAINS 之一即 INVALID_INPUT。
 * @param {unknown} domain - 输入领域名。
 * @returns {string} 校验通过的领域名。
 */
function assertKnowledgeDomain(domain) {
  if (typeof domain !== 'string' || !KNOWLEDGE_DOMAINS.includes(domain)) {
    throw new InvalidInputError(`profile domain must be one of the ${KNOWLEDGE_DOMAINS.length} knowledge subdomains (got ${JSON.stringify(domain)})`)
  }
  return domain
}

/**
 * 合并新条目正文校验（非空、不含 NUL——node:sqlite 的 TEXT 列在 U+0000 处静默截断）。
 * @param {unknown} text - 输入正文。
 * @returns {string} 原文本（已校验）。
 */
function assertEntryText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new InvalidInputError('entry text must be a non-empty string')
  }
  if (text.includes('\u0000')) {
    throw new InvalidInputError('entry text must not contain U+0000 (NUL)')
  }
  return text
}

/**
 * 治理面 id 列表校验（restore / arbitrate 共用）：1..MAX_CONSOLIDATE_MATCHES 个非空字符串、
 * 互不重复。重复 id 会在第二遍被当成「已在场」而误报，故在入口就响亮拒绝。
 * @param {unknown} ids - 输入 id 列表。
 * @param {string} action - 动作名（报错文案用）。
 * @returns {string[]} 原数组（已校验）。
 */
function assertEntryIdList(ids, action) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CONSOLIDATE_MATCHES) {
    throw new InvalidInputError(`${action} ids must be an array of 1..${MAX_CONSOLIDATE_MATCHES} entry ids`)
  }
  const seen = new Set()
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidInputError(`${action} ids must be non-empty strings`)
    }
    if (seen.has(id)) throw new InvalidInputError(`${action} ids must be unique (got ${JSON.stringify(id)} twice)`)
    seen.add(id)
  }
  return /** @type {string[]} */ (ids)
}

/**
 * 裁决面的取法与校验（S5 §2.2 第 3 步）：两组条目的 facet 必须一致且是七面之一。
 * facet 为空（没打坐标）或两组不一致时响亮拒绝——表只有七个键，取不出值就不许猜方向。
 * @param {ProtocolEntry[]} targets - 已定位的裁决目标（非空）。
 * @returns {string} 两组一致的 facet。
 */
function assertArbitrationFacet(targets) {
  const facets = new Set(targets.map((entry) => entry.facet ?? null))
  if (facets.size !== 1) {
    throw new InvalidInputError(`arbitrate needs one facet across all targets (got ${[...facets].map((facet) => JSON.stringify(facet)).join(', ')}); the arbitration table only resolves a single face`)
  }
  const facet = targets[0].facet
  if (facet === null || facet === undefined || !(facet in ARBITRATION_BY_FACET)) {
    throw new InvalidInputError(`arbitrate needs every target to carry one of the seven profile facets (got ${JSON.stringify(facet)}); an entry without a face has no arbitration direction and is never guessed`)
  }
  return facet
}

/**
 * 同组保留者（S5 §2.2）：取 `updatedAt` 最新者，`updatedAt` 相同时按 id 稳定决胜——
 * 规则可复核，不给模型挑的机会。
 * @param {ProtocolEntry[]} group - 非空的同组条目。
 * @returns {ProtocolEntry} 保留者。
 */
function latestOf(group) {
  return group.reduce((best, entry) => {
    if (entry.updatedAt > best.updatedAt) return entry
    if (entry.updatedAt === best.updatedAt && entry.id > best.id) return entry
    return best
  }, group[0])
}

/** 审批载荷里的正文片段（单条超长只截前 300 字，避免 20×满条目撑爆载荷）。 */
function snippetOf(/** @type {string} */ text) {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * 桶边界校验（规格 3.5.8「桶内不跨」）：降级目标必须同属一个 track × scope × agentKey
 * 三角，scope=workspace 时还须同 workspaceKey——合并后的新条目只会落在一个桶里，
 * 混装会把 A 桶的正文搬进 B 桶。
 * @param {ProtocolEntry[]} targets - 已定位的降级目标（非空）。
 * @param {string} [action] - 动作名（报错文案用；缺省 supersede；自动整理传 auto-tidy）。
 */
function assertSameBucket(targets, action = 'supersede') {
  const first = targets[0]
  // 桶键的拼装只有一处出处（lib/consolidate.mjs 的 bucketKeyOf）：两套拼装各写各的，
  // 将来任一列允许空值或分隔符变动，「同桶」就会在两个面上各说各话。
  const expected = bucketKeyOf(first)
  for (const entry of targets) {
    if (bucketKeyOf(entry) !== expected) {
      throw new InvalidInputError(
        `${action} must stay inside one bucket (track × scope × agentKey${first.scope === 'workspace' ? ' × workspaceKey' : ''}): ${JSON.stringify(first.track)}/${JSON.stringify(first.scope)}/${JSON.stringify(first.agentKey)} mixes with ${JSON.stringify(entry.track)}/${JSON.stringify(entry.scope)}/${JSON.stringify(entry.agentKey)}`,
      )
    }
  }
}


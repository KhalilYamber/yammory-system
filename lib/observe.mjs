// lib/observe.mjs — 观察通道的纯函数核心（零 DSH 依赖）。
//
// 观察 = 读历史（闸一授权收窄）→ 只留真人发言（闸二事件过滤）→ 窗口采样与
// 预算记账。本模块不碰服务、不碰存储、不调模型：输入是已经读到的会话日志
// 快照，输出是「一段待推断的切片 ＋ 一份没看到哪儿的诚实账单」。
//
// 两条闸：闸一决定「能读谁」（sessionScope），闸二决定「什么算他说的话」
// （isHumanMessageEvent）。两条都是白名单——黑名单会漏（见施工清单 S4b-0 实测：
// 1892 条 user/message 里 910 条是系统注入的伪发言，`source.kind` 实有 9 种）。
// 白名单之上另有一条**窄排除**：本机无人值守轮的任务文本（SCHEDULED_ROUND_MARKER 开头）
// 由我们自己生成，kind 虽为 user，也不是他说的话。

import { InvalidInputError } from './errors.mjs'
import { extractEventText } from './extract.mjs'
import {
  MAX_OBSERVATION_ENTRIES,
  OBSERVATION_CORRECTION,
  OBSERVATION_FACES,
  OBSERVATION_FACE_VALUES,
  OBSERVATION_SOURCE,
  OBSERVATION_TAG,
  OBSERVE_KEYS,
  OBSERVE_LIMITS,
  PROFILE_FACETS,
  SCHEDULED_ROUND_MARKER,
} from './constants.mjs'

/** 一天的毫秒数（窗口计算共用）。 */
const DAY_MS = 86400000

/**
 * 观察参数（与 Config.observe 的字段一一对应；键表在 constants.mjs 的 OBSERVE_KEYS）。
 * @typedef {{days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}} ObserveOptions
 */
/** @typedef {'days'|'sessions'|'perSession'|'messageChars'|'totalChars'} ObserveKey */

/**
 * 闸二白名单：只有这两种 source.kind 是真人发言。
 * `user` = 终端/直连/浏览器提交（本机浏览器提交也是 `user` ＋ rpcId，实测无 `user-rpc`，
 * 保留它是为了不误伤其它 DSH 版本）；其余一律是系统注入（plugin / agent-instructions /
 * skill-catalog / goal / subagent-* / agent-message / skill-invocation）。
 */
export const HUMAN_SOURCE_KINDS = Object.freeze(['user', 'user-rpc'])

/** 时间戳 → `YYYY-MM-DD`（本地时区；给条目文本与标签用）。 */
export function formatDate(/** @type {number} */ ms) {
  const date = new Date(ms)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 时间戳 → `YYYY-MM-DD HH:mm`（本地时区；给切片行与覆盖账单用）。 */
export function formatStamp(/** @type {number} */ ms) {
  const date = new Date(ms)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${formatDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 钳制观察参数：非数/非有限值回退默认，合法值夹进硬上限（模型不能放大预算）。
 * @param {{[key: string]: unknown}} input - 调用方给的原始参数（可为部分/非法）。
 * @param {ObserveOptions} defaults - 配置层默认值（完整）。
 * @param {{[key: string]: number}} [limits] - 硬上限表（默认 OBSERVE_LIMITS）。
 * @returns {{options: ObserveOptions, clamped: Array<{key: string, requested: number, applied: number}>}} 钳制后的参数与「被钳过哪些」（供工具响亮报告）。
 */
export function resolveObserveOptions(input, defaults, limits = OBSERVE_LIMITS) {
  /** @type {ObserveOptions} */
  const options = { days: 0, sessions: 0, perSession: 0, messageChars: 0, totalChars: 0 }
  /** @type {Array<{key: string, requested: number, applied: number}>} */
  const clamped = []
  for (const key of /** @type {readonly ObserveKey[]} */ (OBSERVE_KEYS)) {
    const raw = input === null || typeof input !== 'object' ? undefined : /** @type {{[key: string]: unknown}} */ (input)[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      options[key] = defaults[key]
      continue
    }
    const requested = Math.floor(raw)
    const applied = Math.min(Math.max(requested, 1), limits[key])
    if (applied !== raw) clamped.push({ key, requested: raw, applied })
    options[key] = applied
  }
  return { options, clamped }
}

/**
 * 闸一（授权收窄）：算出「允许读哪些会话」的过滤条件。
 * - 有 cwd：只读 cwd 精确相等的会话（内核按存储值比较，这里原值直传）。
 * - 无 cwd：只读当前会话自己（id 精确相等），绝不跨会话读。
 * - 两者都没有：拒绝（拿不到任何可信的身份锚点）。
 * 时间窗无条件下推，与身份过滤 AND。
 * @param {{cwd?: string | undefined, sessionId?: string | undefined, days: number, now: number}} input - 当前会话身份与窗口。
 * @returns {{filters: object[], selfOnly: boolean, cwd: string | null}} 过滤条件（AND 数组）与自限标记。
 */
export function sessionScope({ cwd, sessionId, days, now }) {
  /** @type {object[]} */
  const filters = [{ kind: 'created-at', from: now - days * DAY_MS }]
  if (typeof cwd === 'string' && cwd.length > 0) {
    return { filters: [{ kind: 'cwd', values: [cwd] }, ...filters], selfOnly: false, cwd }
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return { filters: [{ kind: 'id', values: [sessionId] }, ...filters], selfOnly: true, cwd: null }
  }
  throw new InvalidInputError('observe scan needs the calling session id or cwd to narrow which sessions may be read; refusing to read history without an authorization anchor')
}

/** 事件类型判定：是不是 user/message（不看来源）。 */
export function isUserMessageEvent(/** @type {unknown} */ event) {
  return event !== null && typeof event === 'object' && /** @type {{type?: unknown}} */ (event).type === 'user/message'
}

/**
 * 闸二：真人发言判定（`user/message` 且 `source.kind` 在白名单内）。
 * @param {unknown} event - 会话事件（{type, data}）。
 * @returns {boolean} 是否算「用户本人说的」。
 */
export function isHumanMessageEvent(event) {
  if (!isUserMessageEvent(event)) return false
  const data = /** @type {{data?: unknown}} */ (event).data
  if (data === null || typeof data !== 'object') return false
  const source = /** @type {{source?: unknown}} */ (data).source
  if (source === null || typeof source !== 'object') return false
  const kind = /** @type {{kind?: unknown}} */ (source).kind
  return typeof kind === 'string' && HUMAN_SOURCE_KINDS.includes(kind)
}

/**
 * 从一个会话日志快照的事件流里抽出真人发言（闸二＋自产文本窄排除＋单条截断）。
 * @param {unknown} events - 事件数组（形状不信任，防御性解析）。
 * @param {number} maxChars - 单条发言字符上限（超出即截断加省略号）。
 * @returns {{messages: Array<{seq: number, at: number, text: string, truncated: boolean}>, injected: number}} 发言清单与被闸二挡下的伪发言条数（含无人值守轮的自产任务文本）。
 */
export function extractHumanMessages(events, maxChars) {
  /** @type {Array<{seq: number, at: number, text: string, truncated: boolean}>} */
  const messages = []
  let injected = 0
  if (!Array.isArray(events)) return { messages, injected }
  // 边界：maxChars 非正整数时钳到 1，避免 slice(0, maxChars - 1) 退化成 slice(0, -1)（删尾不截长）。
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 1
  for (const event of events) {
    if (!isHumanMessageEvent(event)) {
      if (isUserMessageEvent(event)) injected += 1
      continue
    }
    const text = extractEventText(event).trim()
    if (text.length === 0) continue
    // 自产文本的窄排除：无人值守轮的任务说明由本机生成，不是他说的话。挡下即计数。
    if (text.startsWith(SCHEDULED_ROUND_MARKER)) {
      injected += 1
      continue
    }
    const over = text.length > limit
    const record = /** @type {{seq?: unknown, time?: unknown}} */ (event)
    messages.push({
      seq: typeof record.seq === 'number' ? record.seq : messages.length,
      at: typeof record.time === 'number' ? record.time : 0,
      text: over ? `${text.slice(0, limit - 1)}…` : text,
      truncated: over,
    })
  }
  return { messages, injected }
}

/**
 * 均匀间隔采样：保住首条与末条，中间等距取——前 N 条只反映开场，而思维与决策的
 * 证据往往出现在中后段（用户被追问、改主意、纠错的地方）。
 * @param {Array<{seq: number, at: number, text: string, truncated: boolean}>} items - 发言清单。
 * @param {number} count - 至多取几条。
 * @returns {Array<{seq: number, at: number, text: string, truncated: boolean}>} 采样结果（保持原序）。
 */
export function sampleEvenly(items, count) {
  if (count <= 0 || items.length === 0) return []
  if (items.length <= count) return [...items]
  if (count === 1) return [items[0]]
  /** @type {Array<{seq: number, at: number, text: string, truncated: boolean}>} */
  const picked = []
  for (let index = 0; index < count; index++) {
    picked.push(items[Math.round((index * (items.length - 1)) / (count - 1))])
  }
  return picked
}

/**
 * @typedef {object} SliceLabels - 切片文本的分行文案（语言面由调用方给，本模块只管预算与结构）。
 * @property {(info: {from: number, to: number, days: number, sessions: number, messages: number}) => string} header
 * @property {(info: {sessionId: string, title: string | null, at: number, messages: number}) => string} session
 * @property {(info: {at: number, text: string}) => string} message
 */

/**
 * @typedef {object} ObservationSlice
 * @property {string} text - 待推断的切片正文（字符数 ≤ options.totalChars）。
 * @property {{from: number, to: number}} window - 本次窗口。
 * @property {{limit: number, used: number, truncated: boolean}} budget - 预算账单。
 * @property {{sessions: number, read: number, messages: number, injected: number, skippedOff: number}} scanned - 窗口内候选会话数、真正读过的会话数、读到的真人发言数、被闸二挡下的伪发言数、因会话记忆关闭被跳过的会话数。
 * @property {{sessions: number, messages: number, chars: number, from: number | null, to: number | null}} covered - 真正进了切片的范围。
 * @property {{sessions: number, messages: number, days: number}} uncovered - 没看到的部分（到顶必须报）。
 * @property {Array<{sessionId: string, title: string | null, at: number, messages: number}>} picked - 贡献了内容的会话。
 */

/**
 * 组装观察切片：窗口过滤 → 会话数截断 → 逐会话采样 → 逐条预算记账。
 * 到顶即停，并把「没看到的会话数 / 条数 / 天数」如实写进 uncovered——绝不静默截断。
 * @param {Array<{sessionId: string, createdAt: number, title?: string | null, events?: unknown[]}>} sessions - 候选会话（服务端 newest-first）。
 * @param {{days: number, sessions: number, perSession: number, messageChars: number, totalChars: number}} options - 已钳制参数。
 * @param {number} now - 当前时刻（毫秒）。
 * @param {SliceLabels} labels - 文案面。
 * @param {number} [skippedOff] - 因会话记忆关闭被选区提前滤掉的会话数（F5；进账单，不静默）。
 * @returns {ObservationSlice} 切片与账单。
 */
export function buildObservationSlice(sessions, options, now, labels, skippedOff = 0) {
  const from = now - options.days * DAY_MS
  const candidates = sessions.filter((session) => Number.isFinite(session.createdAt) && session.createdAt >= from)
  const selected = candidates.slice(0, options.sessions)
  /** @type {string[]} */
  const lines = []
  let used = 0
  let truncated = false
  /** @param {string} line */
  const push = (line) => {
    const cost = used === 0 ? line.length : line.length + 1
    if (used + cost > options.totalChars) {
      truncated = true
      return false
    }
    lines.push(line)
    used += cost
    return true
  }

  let scannedMessages = 0
  let injected = 0
  let sampled = 0
  let coveredMessages = 0
  /** @type {Array<{sessionId: string, title: string | null, at: number, messages: number}>} */
  const picked = []
  /** @type {number | null} */
  let coveredFrom = null
  /** @type {number | null} */
  let coveredTo = null

  push(labels.header({ from, to: now, days: options.days, sessions: selected.length, messages: 0 }))
  for (const session of selected) {
    const extracted = extractHumanMessages(session.events, options.messageChars)
    scannedMessages += extracted.messages.length
    injected += extracted.injected
    const chosen = sampleEvenly(extracted.messages, options.perSession)
    sampled += chosen.length
    if (chosen.length === 0) continue
    const title = typeof session.title === 'string' && session.title.length > 0 ? session.title : null
    const sessionAt = chosen[0].at
    // 会话抬头按「条数上限」预留（实际条数只会更少，抬头只会更短），
    // 于是下面的逐条记账不会出现「抬头已写、条数对不上」的错账。
    const headerReserve = labels.session({ sessionId: session.sessionId, title, at: sessionAt, messages: chosen.length }).length
    const available = options.totalChars - used - 1 - headerReserve
    /** @type {Array<{line: string, at: number}>} */
    const body = []
    let bodyChars = 0
    for (const message of chosen) {
      const line = labels.message({ at: message.at, text: message.text })
      if (bodyChars + line.length + 1 > available) {
        truncated = true
        break
      }
      body.push({ line, at: message.at })
      bodyChars += line.length + 1
    }
    if (body.length === 0) {
      truncated = true
      break
    }
    if (!push(labels.session({ sessionId: session.sessionId, title, at: sessionAt, messages: body.length }))) break
    for (const item of body) {
      if (!push(item.line)) break
      coveredMessages += 1
      if (coveredFrom === null || item.at < coveredFrom) coveredFrom = item.at
      if (coveredTo === null || item.at > coveredTo) coveredTo = item.at
    }
    picked.push({ sessionId: session.sessionId, title, at: sessionAt, messages: body.length })
    if (used >= options.totalChars) {
      truncated = true
      break
    }
  }

  return {
    text: lines.join('\n'),
    window: { from, to: now },
    budget: { limit: options.totalChars, used, truncated },
    scanned: { sessions: candidates.length, read: selected.length, messages: scannedMessages, injected, skippedOff },
    covered: { sessions: picked.length, messages: coveredMessages, chars: used, from: coveredFrom, to: coveredTo },
    uncovered: {
      sessions: candidates.length - picked.length,
      messages: sampled - coveredMessages,
      days: coveredFrom === null ? options.days : Math.max(0, Math.round((coveredFrom - from) / DAY_MS)),
    },
    picked,
  }
}

/**
 * 组装一条观察条目的存储文本：来源与观察时间前置（方案 4.3「并存＋标注」的落地），
 * 证据随条目一起落库——审批时人看到的就是证据。
 * @param {{text: string, evidence: string}} entry - 模型给出的结论与证据片段。
 * @param {number} now - 观察时刻（毫秒）。
 * @param {'en'|'zh'} [language] - 文案语言。
 * @returns {string} 条目文本。
 */
export function composeObservationText(entry, now, language = 'en') {
  const stamp = formatDate(now)
  return language === 'zh'
    ? `[观察 ${stamp}] ${entry.text}\n证据：${entry.evidence}`
    : `[observed ${stamp}] ${entry.text}\nevidence: ${entry.evidence}`
}

/**
 * 组装一条观察条目的标签：子板块 ＋ observation ＋ 观察日期（方案 4.3「tags 带时间戳」）。
 * 面板与后续查询据此把观察条目与问卷条目分开。
 * @param {{face: string, tags?: string[]}} entry - 模型给出的面与可选附加标签。
 * @param {number} now - 观察时刻（毫秒）。
 * @returns {string[]} 标签数组。
 */
export function observationTags(entry, now) {
  const extra = Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string' && tag.length > 0) : []
  return [...new Set([entry.face, ...extra, OBSERVATION_TAG, formatDate(now)])]
}

/**
 * 校验并规范化模型给出的观察条目——落库口径的唯一入口（方案 7.1 裁决 (a)：
 * `facet` 取七面值、子板块进 `tags`；`source` 由工具锚死，不由模型传）。
 * 面/结论/证据缺一即响亮拒绝；把握为「低」的条目按提示词纪律直接拒绝（低把握不写）；
 * 「校正」面必须自己给出七面之一的 facet。
 * @param {unknown} rawEntries - 模型给出的条目数组。
 * @param {number} now - 观察时刻（毫秒）。
 * @param {'en'|'zh'} [language] - 条目文本语言。
 * @returns {Array<{track: string, scope: string, text: string, source: string, tags: string[], facet: string}>} 可直接交给 service.seed 的条目。
 */
export function normalizeObservationEntries(rawEntries, now, language = 'en') {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new InvalidInputError('observe commit needs at least one entry (an empty commit writes nothing)')
  }
  if (rawEntries.length > MAX_OBSERVATION_ENTRIES) {
    throw new InvalidInputError(`observe commit accepts at most ${MAX_OBSERVATION_ENTRIES} entries (got ${rawEntries.length}); a single observation is meant to be short`)
  }
  const entries = []
  for (const [index, raw] of rawEntries.entries()) {
    const at = `entries[${index}]`
    if (raw === null || typeof raw !== 'object') throw new InvalidInputError(`${at} must be an object`)
    const record = /** @type {{face?: unknown, text?: unknown, evidence?: unknown, confidence?: unknown, facet?: unknown, tags?: unknown}} */ (raw)
    if (typeof record.face !== 'string' || !OBSERVATION_FACE_VALUES.includes(record.face)) {
      throw new InvalidInputError(`${at}.face must be one of ${OBSERVATION_FACE_VALUES.join(' | ')}`)
    }
    if (typeof record.text !== 'string' || record.text.trim().length === 0) {
      throw new InvalidInputError(`${at}.text must be the one-sentence conclusion (non-empty)`)
    }
    if (typeof record.evidence !== 'string' || record.evidence.trim().length === 0) {
      throw new InvalidInputError(`${at}.evidence must quote the user's own words; a conclusion without evidence is not written`)
    }
    if (record.confidence !== undefined) {
      if (record.confidence !== '高' && record.confidence !== '中' && record.confidence !== '低') {
        throw new InvalidInputError(`${at}.confidence must be 高 | 中 | 低`)
      }
      if (record.confidence === '低') {
        throw new InvalidInputError(`${at} is marked low confidence; low-confidence conclusions are dropped, not written — submit only 高 or 中`)
      }
    }
    const correction = record.face === OBSERVATION_CORRECTION
    if (correction && (typeof record.facet !== 'string' || !PROFILE_FACETS.includes(record.facet))) {
      throw new InvalidInputError(`${at} is a correction, so it must name the face it corrects: facet must be one of ${PROFILE_FACETS.join(' | ')}`)
    }
    const face = record.face
    entries.push({
      track: 'user',
      scope: 'user-global',
      text: composeObservationText({ text: record.text.trim(), evidence: record.evidence.trim() }, now, language),
      source: OBSERVATION_SOURCE,
      tags: observationTags({ face, ...(Array.isArray(record.tags) ? { tags: /** @type {string[]} */ (record.tags) } : {}) }, now),
      facet: correction ? /** @type {string} */ (record.facet) : OBSERVATION_FACES[/** @type {keyof typeof OBSERVATION_FACES} */ (face)],
    })
  }
  return entries
}

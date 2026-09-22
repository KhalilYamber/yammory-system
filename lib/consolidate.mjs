// lib/consolidate.mjs — F6 整理机纯函数核心（零 DSH 依赖）。
//
// 整理机的语义判断（哪几条在讲同一件事）由**当前会话的模型**做，本文件只做机械部分：
// ① 挑候选（热度公式，规格 3.5.10）；② 跳过已整理（`merged` 标，规格 3.5.11）；
// ③ 划桶（桶内不跨，规格 3.5.8）；④ 算积压量（开工线，规格 3.5.1）；
// ⑤ 把握分级（`gradeMerge`：哪一批不必再过人眼就能合，见其 JSDoc 的档位判据）。
//
// 一句话边界：本文件不读库、不写库、不调模型、不知 DSH 存在；index.mjs 把库里的
// 条目喂进来，把这份计划交给模型，模型再经 memory 工具落写。

import { jaccard, tokenSet } from './stats.mjs'
import { InvalidInputError } from './errors.mjs'
import { MERGE_GATES, MERGE_GRADE_LINES, MERGE_VERDICTS, MERGED_TAG, TIDY_RUN_FAILURES, TIDY_RUN_OUTCOMES } from './constants.mjs'

/** 热度窗口（天）：先取近 7 天更新过的条目（规格 3.5.10）。 */
export const HEAT_WINDOW_DAYS = 7

/** 高召回线的默认值：召回次数达到它的条目也算「热」，哪怕久未更新。 */
export const POPULAR_RECALL_COUNT = 3

/** 一次整理交给模型的候选上限（分批 ≤ MAX_CONSOLIDATE_MATCHES 是对单次落写的要求，这里是计划规模）。 */
export const DEFAULT_CANDIDATE_LIMIT = 40

/** 候选内「可能同一件事」的提示线：比重复率的判线宽松（这里是给人/模型看的线索，不是结论）。 */
export const PAIR_HINT_THRESHOLD = 0.5

/** 每个桶最多展示的相似对（计划是线索，不是清单）。 */
export const MAX_PAIRS_PER_BUCKET = 12

/**
 * 整理计划看到的条目面（`lib/store.mjs` 的 `MemoryEntry` 满足它；纯函数只读这些字段，
 * 故这里刻意声明成最小形状，而不是 import store 的形状）。
 * @typedef {object} PlanEntry
 * @property {string} id
 * @property {string} track
 * @property {string} scope
 * @property {string} text
 * @property {string[]} [tags]
 * @property {string} [status]
 * @property {string} [agentKey]
 * @property {string} [workspaceKey]
 * @property {number} [recallCount]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * 积压核算看到的条目面（只数在场条目与字数）。
 * @typedef {{text: string, status?: string, createdAt: number, updatedAt: number}} BacklogEntry
 */

/**
 * 开工线默认值（规格 3.5.1）：自上次整理以来 ≥ 2000 字符或 ≥ 10 条，另加 12 小时兜底。
 * 数值是可调默认，不替用户钉死；本仓库不新增 Config，故这里是唯一出处。
 */
export const TIDY_DEFAULTS = Object.freeze({
  charsLine: 2000,
  entriesLine: 10,
  hoursLine: 12,
  windowDays: HEAT_WINDOW_DAYS,
  candidateLimit: DEFAULT_CANDIDATE_LIMIT,
  pairThreshold: PAIR_HINT_THRESHOLD,
})

/** 条目是否已带「已整理」标（下次整理见到就跳过）。 */
export function isMerged(/** @type {{tags?: string[]}} */ entry) {
  return Array.isArray(entry.tags) && entry.tags.includes(MERGED_TAG)
}

/** 条目是否在场（降级条目已不在会话可见集内，不参与整理）。 */
export function isActive(/** @type {{status?: string}} */ entry) {
  return (entry.status ?? 'active') === 'active'
}

/**
 * 桶键（规格 3.5.8「桶内不跨」）：`track × scope × agentKey`，scope=workspace 时
 * 追加 workspaceKey——workspace 层的工作区身份属于「层」本身，不并进来会把 A 工作区
 * 的记忆并进 B 工作区。
 * @param {{track: string, scope: string, agentKey?: string, workspaceKey?: string}} entry - 条目。
 * @returns {string} 桶键。
 */
export function bucketKeyOf(entry) {
  const agentKey = entry.agentKey ?? ''
  const workspaceKey = entry.scope === 'workspace' ? (entry.workspaceKey ?? '') : ''
  return `${entry.track}/${entry.scope}${agentKey.length > 0 ? ` #${agentKey}` : ''}${workspaceKey.length > 0 ? ` @${workspaceKey}` : ''}`
}

/**
 * 挑候选（热度公式）：active 且未带 `merged` 标的条目里，取「近 N 天更新过」或
 * 「召回次数达到高召回线」的那些，按 recall_count DESC → updated_at DESC → id 排序，
 * 截到 limit。**被跳过的已整理条目数如实回报**（收益判据要看得见）。
 *
 * `heatOnly: false` 是「点一下即跑」那一轮用的口径（F9）：后台轮是用户显式点出来的全库整理，
 * 不该被 7 天热度窗口挡在门外——库里久未动过的重复条目同样是重复。两条口径在别处不影响：
 * 默认值不变，会话内 `/memory tidy` 与 action=tidy 的老计划一字不动。
 * @param {PlanEntry[]} entries - 全部条目。
 * @param {{now?: number, windowDays?: number, popularRecallCount?: number, limit?: number, heatOnly?: boolean}} [options] - {now, windowDays, popularRecallCount, limit, heatOnly}。
 * @returns {{candidates: PlanEntry[], skippedMerged: number, skippedSuperseded: number, inWindow: number, windowFrom: number}} 候选与跳过账目。
 */
export function selectCandidates(entries, options = {}) {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? HEAT_WINDOW_DAYS
  const popularRecallCount = options.popularRecallCount ?? POPULAR_RECALL_COUNT
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT
  const heatOnly = options.heatOnly !== false
  const windowFrom = now - windowDays * 86400000
  let skippedMerged = 0
  let skippedSuperseded = 0
  let inWindow = 0
  /** @type {PlanEntry[]} */
  const hot = []
  for (const entry of entries) {
    if (!isActive(entry)) {
      skippedSuperseded += 1
      continue
    }
    if (isMerged(entry)) {
      skippedMerged += 1
      continue
    }
    const recent = entry.updatedAt >= windowFrom
    if (recent) inWindow += 1
    if (!heatOnly || recent || (entry.recallCount ?? 0) >= popularRecallCount) hot.push(entry)
  }
  hot.sort((a, b) =>
    (b.recallCount ?? 0) - (a.recallCount ?? 0)
    || b.updatedAt - a.updatedAt
    || a.createdAt - b.createdAt
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { candidates: hot.slice(0, limit), skippedMerged, skippedSuperseded, inWindow, windowFrom }
}

/**
 * 全库候选（F9 后台轮的口径）：与热度计划同一套排序与跳过账目，只是不设热度窗口——
 * 后台轮由用户点出来，目标是「库里所有还没整理的重复」，不是「最近动过的那批」。
 * @param {PlanEntry[]} entries - 全部条目。
 * @returns {ReturnType<typeof selectCandidates>} 候选与跳过账目。
 */
export function selectWholeLibraryCandidates(entries) {
  return selectCandidates(entries, { heatOnly: false })
}

/**
 * 按桶分组（保序：桶按首条目出现顺序，桶内保持传入顺序）。
 * @param {PlanEntry[]} entries - 候选条目。
 * @returns {Map<string, PlanEntry[]>} 桶键 → 条目。
 */
export function groupByBucket(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = bucketKeyOf(entry)
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  return groups
}

/**
 * 桶内相似对提示（模型的线索，不是结论）：候选两两 Jaccard ≥ 阈值的对，按相似度降序，
 * 每桶截到 MAX_PAIRS_PER_BUCKET。任一候选都不跨桶比较。
 * @param {PlanEntry[]} candidates - 同一桶的候选条目。
 * @param {number} [threshold] - 提示线。
 * @returns {Array<{aId: string, bId: string, similarity: number, a: string, b: string}>} 相似对。
 */
export function similarPairs(candidates, threshold = PAIR_HINT_THRESHOLD) {
  const sets = candidates.map((entry) => tokenSet(entry.text))
  /** @type {Array<{aId: string, bId: string, similarity: number, a: string, b: string}>} */
  const pairs = []
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const similarity = jaccard(sets[i], sets[j])
      if (similarity < threshold) continue
      pairs.push({
        aId: candidates[i].id,
        bId: candidates[j].id,
        similarity: Number(similarity.toFixed(4)),
        a: clip(candidates[i].text),
        b: clip(candidates[j].text),
      })
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity)
  return pairs.slice(0, MAX_PAIRS_PER_BUCKET)
}

/**
 * 把握分级（硬杠判定表）：把一批同桶候选判成三档——`auto` 够确定（可直接合）、
 * `review` 不够确定（进待批单子）、`skip` 不合格（原地不动）。
 *
 * 五根硬杠（名与阈值见 lib/constants.mjs 的 MERGE_GATES / MERGE_GRADE_LINES）：
 * ① `same-bucket` 同桶；② `member-count` 成员数 2..maxMembers；③ `verbatim` 去掉空白、
 * 标点与符号后与拟合并文本逐字一致；④ `similarity` 两两 Jaccard 的最小值（最不相像的
 * 那一对说了算）；⑤ `coverage` 拟合并文本对每条源条目的词元覆盖率最小值（信息不丢）。
 *
 * 档位判据：①②过关且④⑤不低于各自底线（review 线）才谈得上 auto/review；其中只有
 * 「③逐字一致 且 ④⑤双双落在 auto 线以上」判 `auto`，其余一律 `review`（进单子等人看）。
 * ③ 是补上的守门杠：词元重合度是**字面**尺子，长条目里一字之差（否定词、数值、人名）
 * 会被共享上下文稀释到 0.85 以上，光靠抬高阈值分不出「改了标点」与「语义反转」。
 * 判据因此落在「有没有任何实质字符差异」这个二元事实上，而不是某个阈值上。
 *
 * 本函数只看字面与形状，**不承担语义判断**：「这两条意思是不是一回事」仍是会话里
 * 模型的活；它只回答「哪一批不必再过人眼就能合」。判定无随机、无时间依赖，故同输入恒同输出。
 * @param {{members: PlanEntry[], mergedText: string}} input - 同桶候选成员与拟合并的文本。
 * @param {{maxMembers?: number, autoSimilarity?: number, reviewSimilarity?: number, autoCoverage?: number, reviewCoverage?: number}} [options] - 覆盖阈值（缺省取 MERGE_GRADE_LINES）。
 * @returns {{verdict: 'auto' | 'review' | 'skip', gates: Array<{name: string, passed: boolean, detail: string}>, passed: string[], failed: string[], similarity: number | null, coverage: number | null, memberIds: string[], bucketKey: string | null, lines: {maxMembers: number, autoSimilarity: number, reviewSimilarity: number, autoCoverage: number, reviewCoverage: number}}} 判定与逐杠依据（`passed`/`failed` 即「命中了哪几根硬杠」的复述面）。
 */
export function gradeMerge(input, options = {}) {
  const members = input?.members
  if (!Array.isArray(members)) throw new InvalidInputError('gradeMerge needs input.members as an array of candidate entries')
  const mergedText = input?.mergedText
  if (typeof mergedText !== 'string' || mergedText.length === 0) {
    throw new InvalidInputError('gradeMerge needs input.mergedText as the proposed merged text (a non-empty string)')
  }
  const lines = {
    maxMembers: options.maxMembers ?? MERGE_GRADE_LINES.maxMembers,
    autoSimilarity: options.autoSimilarity ?? MERGE_GRADE_LINES.autoSimilarity,
    reviewSimilarity: options.reviewSimilarity ?? MERGE_GRADE_LINES.reviewSimilarity,
    autoCoverage: options.autoCoverage ?? MERGE_GRADE_LINES.autoCoverage,
    reviewCoverage: options.reviewCoverage ?? MERGE_GRADE_LINES.reviewCoverage,
  }
  const bucketKeys = members.map((entry) => bucketKeyOf(entry))
  const distinctBuckets = new Set(bucketKeys).size
  const sameBucket = members.length > 0 && distinctBuckets === 1
  const countOk = members.length >= 2 && members.length <= lines.maxMembers
  const sets = members.map((entry) => tokenSet(entry.text))
  const similarity = minPairSimilarity(sets)
  const coverage = minCoverage(sets, tokenSet(mergedText))
  const similarityTier = tierOf(similarity, lines.autoSimilarity, lines.reviewSimilarity)
  const coverageTier = tierOf(coverage, lines.autoCoverage, lines.reviewCoverage)
  const plainForms = [mergedText, ...members.map((entry) => entry.text)].map(plainFormOf)
  // 成员不足两条时不构成合并：空批上 every() 恒真，会写出一根空过的硬杠（红队复核 L1）。
  const verbatim = members.length >= 2 && plainForms[0].length > 0 && plainForms.every((text) => text === plainForms[0])
  /** @type {Array<{name: string, passed: boolean, detail: string}>} */
  const gates = [
    { name: MERGE_GATES.sameBucket, passed: sameBucket, detail: sameBucket ? String(bucketKeys[0]) : `spans ${distinctBuckets} buckets` },
    { name: MERGE_GATES.memberCount, passed: countOk, detail: `${members.length}/${lines.maxMembers}` },
    { name: MERGE_GATES.verbatim, passed: verbatim, detail: verbatim ? `${plainForms[0].length} chars identical after punctuation strip` : 'members and merged text differ beyond punctuation and whitespace' },
    { name: MERGE_GATES.similarity, passed: similarityTier !== 'low', detail: `${similarity} (auto ${lines.autoSimilarity} / review ${lines.reviewSimilarity})` },
    { name: MERGE_GATES.coverage, passed: coverageTier !== 'low', detail: `${coverage} (auto ${lines.autoCoverage} / review ${lines.reviewCoverage})` },
  ]
  /** @type {'auto' | 'review' | 'skip'} */
  let verdict = 'skip'
  if (sameBucket && countOk && similarityTier !== 'low' && coverageTier !== 'low') {
    verdict = verbatim && similarityTier === 'high' && coverageTier === 'high' ? 'auto' : 'review'
  }
  if (!MERGE_VERDICTS.includes(verdict)) {
    throw new Error(`gradeMerge produced ${verdict}, which is not one of ${MERGE_VERDICTS.join('|')}`)
  }
  return {
    verdict,
    gates,
    passed: gates.filter((gate) => gate.passed).map((gate) => gate.name),
    failed: gates.filter((gate) => !gate.passed).map((gate) => gate.name),
    similarity,
    coverage,
    memberIds: members.map((entry) => entry.id),
    bucketKey: sameBucket ? String(bucketKeys[0]) : null,
    lines,
  }
}

/**
 * 逐字比对用的归一形式：去掉空白、标点与符号，只留实义字符。
 * 「同一句话的两种标点写法」归一到同一串；差一个实义字（否定词、数值、人名）就不同。
 * @param {unknown} text - 条目或合并文本。
 * @returns {string} 归一形式（非字符串记空串）。
 */
function plainFormOf(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 两两 Jaccard 的最小值（保守口径；不足两条时不构成比对，返回 null）。 */
function minPairSimilarity(/** @type {Set<string>[]} */ sets) {
  if (sets.length < 2) return null
  let min = Infinity
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const value = jaccard(sets[i], sets[j])
      if (value < min) min = value
    }
  }
  return Number(min.toFixed(4))
}

/** 拟合并文本对每条源条目的词元覆盖率的最小值；空词元集（空白/纯符号）记 0 分。 */
function minCoverage(/** @type {Set<string>[]} */ sets, /** @type {Set<string>} */ mergedSet) {
  if (sets.length === 0) return null
  let min = Infinity
  for (const set of sets) {
    let shared = 0
    for (const token of set) {
      if (mergedSet.has(token)) shared += 1
    }
    const value = set.size === 0 ? 0 : shared / set.size
    if (value < min) min = value
  }
  return Number(min.toFixed(4))
}

/** 分档：≥ auto 线为 high，≥ review 线为 mid，其余（含 null）为 low。 */
function tierOf(/** @type {number | null} */ value, /** @type {number} */ autoLine, /** @type {number} */ reviewLine) {
  if (value === null) return 'low'
  if (value >= autoLine) return 'high'
  if (value >= reviewLine) return 'mid'
  return 'low'
}

/**
 * 积压量（开工线，规格 3.5.1）：自上次整理以来的新增/变动量与时间。
 * - `chars`/`count`：`createdAt > since` 或 `updatedAt > since` 的 active 条目之和；
 * - `dueByTime`：距上次整理 ≥ hoursLine 且确有变动（从没整理过时不触发时间线——
 *   否则新库第一天就喊「该整理了」，那是噪音不是信号）；
 * - `due`：三者任一。
 * @param {BacklogEntry[]} entries - 全部条目。
 * @param {{since?: number, now?: number, charsLine?: number, entriesLine?: number, hoursLine?: number}} [options] - {since, now, ...线}。
 * @returns {{since: number, now: number, hours: number | null, chars: number, count: number, overChars: boolean, overCount: boolean, dueByTime: boolean, due: boolean, reason: 'chars' | 'count' | 'time' | null}} 积压账目。
 */
export function backlogOf(entries, options = {}) {
  const now = options.now ?? Date.now()
  const since = options.since ?? 0
  const charsLine = options.charsLine ?? TIDY_DEFAULTS.charsLine
  const entriesLine = options.entriesLine ?? TIDY_DEFAULTS.entriesLine
  const hoursLine = options.hoursLine ?? TIDY_DEFAULTS.hoursLine
  let chars = 0
  let count = 0
  for (const entry of entries) {
    if (!isActive(entry)) continue
    if (entry.createdAt <= since && entry.updatedAt <= since) continue
    chars += entry.text.length
    count += 1
  }
  const hours = since > 0 ? (now - since) / 3600000 : null
  const overChars = chars >= charsLine
  const overCount = count >= entriesLine
  const dueByTime = since > 0 && hours !== null && hours >= hoursLine && count > 0
  return {
    since,
    now,
    hours: hours === null ? null : Number(hours.toFixed(2)),
    chars,
    count,
    overChars,
    overCount,
    dueByTime,
    due: overChars || overCount || dueByTime,
    reason: overChars ? 'chars' : overCount ? 'count' : dueByTime ? 'time' : null,
  }
}

/**
 * 组装一次整理计划（`/memory tidy` 与 memory 工具 action=tidy 共用的数据面）：
 * 候选 → 桶内分组 → 桶内相似对。计划只是线索，真正的「这几条讲的是同一件事」由模型判。
 * @param {PlanEntry[]} entries - 全部条目。
 * @param {{now?: number, since?: number, windowDays?: number, candidateLimit?: number, pairThreshold?: number, charsLine?: number, entriesLine?: number, hoursLine?: number}} [options] - 见 TIDY_DEFAULTS。
 * @returns {{backlog: ReturnType<typeof backlogOf>, buckets: Array<{key: string, track: string, scope: string, agentKey: string, workspaceKey: string, candidates: Array<{id: string, text: string, recallCount: number, updatedAt: number, chars: number}>, pairs: ReturnType<typeof similarPairs>, batchHint: number}>, candidates: number, skippedMerged: number, skippedSuperseded: number, windowDays: number, windowFrom: number}} 计划。
 */
export function buildTidyPlan(entries, options = {}) {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? TIDY_DEFAULTS.windowDays
  const selection = selectCandidates(entries, {
    now,
    windowDays,
    ...(options.candidateLimit === undefined ? {} : { limit: options.candidateLimit }),
  })
  const groups = groupByBucket(selection.candidates)
  /** @type {Array<{key: string, track: string, scope: string, agentKey: string, workspaceKey: string, candidates: Array<{id: string, text: string, recallCount: number, updatedAt: number, chars: number}>, pairs: ReturnType<typeof similarPairs>, batchHint: number}>} */
  const buckets = []
  for (const [key, list] of groups) {
    const first = list[0]
    buckets.push({
      key,
      track: first.track,
      scope: first.scope,
      agentKey: first.agentKey ?? '',
      workspaceKey: first.scope === 'workspace' ? (first.workspaceKey ?? '') : '',
      candidates: list.map((entry) => ({
        id: entry.id,
        text: entry.text,
        recallCount: entry.recallCount ?? 0,
        updatedAt: entry.updatedAt,
        chars: entry.text.length,
      })),
      pairs: similarPairs(list, options.pairThreshold ?? TIDY_DEFAULTS.pairThreshold),
      batchHint: Math.ceil(list.length / 20),
    })
  }
  return {
    backlog: backlogOf(entries, {
      now,
      since: options.since ?? 0,
      ...(options.charsLine === undefined ? {} : { charsLine: options.charsLine }),
      ...(options.entriesLine === undefined ? {} : { entriesLine: options.entriesLine }),
      ...(options.hoursLine === undefined ? {} : { hoursLine: options.hoursLine }),
    }),
    buckets,
    candidates: selection.candidates.length,
    skippedMerged: selection.skippedMerged,
    skippedSuperseded: selection.skippedSuperseded,
    windowDays,
    windowFrom: selection.windowFrom,
  }
}

/** 计划里的条目文本裁剪（展示用；落写时用原文）。 */
function clip(/** @type {string} */ text) {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

// ── 后台整理轮的运行态（F9：点一下即跑的面板状态行）──────────────────────────
//
// 状态不落新表、不加新列：它从三样现成的东西算出来——`tidy_requests` 的待整理标记、
// `audit(action='tidy-run')` 的起止行、以及批次收尾的 `audit(action='consolidation')` 行。
// 这样面板那一行的每个字都有库里的凭据，且没有第四份会与它们对不上的状态。

/** 后台整理轮的默认判活窗口（8 分钟）：超过它就认定这一轮没起来或已经死了。 */
export const TIDY_RUN_DEFAULT_TIMEOUT_MS = 480000

/** 已完成的结果最多展示多久（一天）；更老的批次不再占据面板那一行，退成按钮旁的说明。 */
export const TIDY_RUN_RESULT_MAX_AGE_MS = 86400000

/**
 * 整理轮的审计行面（`store.auditList()` 的行满足它；纯函数只读这几个字段）。
 * @typedef {object} TidyAuditRow
 * @property {string} [action]
 * @property {string} [outcome]
 * @property {number} [ts]
 * @property {string} [source]
 * @property {string} [text]
 */

/**
 * 一轮后台整理的账目（`index.mjs` 的路由把 store 的三样东西取出来喂进来）。
 * @typedef {object} TidyRunInput
 * @property {{id: string, createdAt: number, status: string} | null} pending - 待整理标记（无则 null）。
 * @property {TidyAuditRow[]} auditRows - 近期审计行（顺序不限，本函数自己按时间比大小）。
 * @property {Array<{batchId: string, at: number, count: number | null}>} batches - 已有批次（只需最新一条，多传无害）。
 * @property {number} [now] - 当前时间（测试注入）。
 * @property {number} [timeoutMs] - 判活窗口。
 * @property {number} [resultMaxAgeMs] - 结果最多展示多久。
 * @property {'en'|'zh'} [language] - 状态行语言。
 * @property {(batchId: string) => number | null} [batchReportedAt] - 批次号 → 该批次的收尾时间；给不出就退回批次行自己的 at。
 */

/**
 * 算一轮后台整理的运行态：`idle` / `pending`（已排队，执行体未起）/ `running`（执行体在跑）/
 * `done` / `failed`。四档的判据全部来自审计与标记，没有第四份状态可漂移。
 *
 * 优先级（先到先判）：标记存在且这一轮没有任何更新的起止行 → `pending`；最近一行整理轮审计是
 * `started` → `running`；是 `failed` → `failed`；否则看有没有比这一轮标记更新的批次收尾行 → `done`，
 * 都没有 → `idle`。
 *
 * 一处刻意的不对称：`done` 只在「标记已被清掉」或「批次比标记新」时才成立。整理轮跑完会清标记，
 * 于是清掉即完成；而失败的轮次按设计**不清标记**（它是排队的凭据），状态行才敢说「可重试」而不是
 * 「没跑过」。
 * @param {TidyRunInput} input - 标记、审计行与批次账目。
 * @returns {{state: 'idle' | 'pending' | 'running' | 'done' | 'failed', batchId: string | null, batchCount: number | null, batchAt: number | null, failure: string | null, startedAt: number | null, lines: string[]}} 状态与状态行（面板照抄；语言跟随 language）。
 */
export function buildTidyRunState(input) {
  const now = input.now ?? Date.now()
  const timeoutMs = input.timeoutMs ?? TIDY_RUN_DEFAULT_TIMEOUT_MS
  const resultMaxAgeMs = input.resultMaxAgeMs ?? TIDY_RUN_RESULT_MAX_AGE_MS
  const pending = input.pending ?? null
  const rows = Array.isArray(input.auditRows) ? input.auditRows : []
  let startedAt = 0
  let failedAt = 0
  let exitedAt = 0
  /** @type {string} 失败码或执行体自己报上来的原因文本（写进状态行，故是自由字符串）。 */
  let failedCode = /** @type {string} */ (TIDY_RUN_FAILURES.spawn)
  for (const row of rows) {
    if (row.action !== 'tidy-run' || typeof row.ts !== 'number') continue
    if (row.outcome === TIDY_RUN_OUTCOMES.started) startedAt = Math.max(startedAt, row.ts)
    else if (row.outcome === TIDY_RUN_OUTCOMES.exited) exitedAt = Math.max(exitedAt, row.ts)
    else if (row.outcome === TIDY_RUN_OUTCOMES.failed) {
      if (row.ts >= failedAt) {
        failedAt = row.ts
        failedCode = typeof row.text === 'string' && row.text.length > 0 ? row.text : TIDY_RUN_FAILURES.spawn
      }
    }
  }
  /** @type {Array<{batchId: string, at: number, count: number | null}>} */
  const batches = Array.isArray(input.batches) ? input.batches : []
  /** @type {{batchId: string, at: number, count: number | null} | null} */
  let latest = null
  for (const batch of batches) {
    if (batch === null || typeof batch !== 'object') continue
    const at = typeof input.batchReportedAt === 'function' ? (input.batchReportedAt(batch.batchId) ?? batch.at) : batch.at
    if (latest === null || at > latest.at) latest = { ...batch, at }
  }
  const pendingCreatedAt = pending === null ? 0 : pending.createdAt
  const stale = pending !== null && startedAt < pendingCreatedAt && now - pendingCreatedAt > timeoutMs
  /** @type {'idle' | 'pending' | 'running' | 'done' | 'failed'} */
  let state = 'idle'
  // 一个「比这一轮更新」的批次收尾行说了算：它比 started 行新，说明那一轮已经干完收工了。
  // 这条要排在 running 之前判——否则跑完之后状态会永远停在「整理中」，面板那一行就废了。
  const freshBatch = latest !== null && latest.at > startedAt && (pending === null || latest.at > pending.createdAt)
  if (freshBatch) {
    state = /** @type {{at: number}} */ (latest).at >= now - resultMaxAgeMs ? 'done' : 'idle'
  } else if (exitedAt > 0 && exitedAt >= startedAt) {
    // 执行体正常退出了，这一轮到此为止。**没有产出的轮次也要收尾**：模型回 NOTHING 时批次
    // 收尾行不会出现，只有这一条凭据；缺了它面板会永久停在「整理中」，按钮连同它一起被禁掉。
    state = exitedAt >= now - resultMaxAgeMs ? 'done' : 'idle'
  } else if (pending !== null && startedAt < pendingCreatedAt) {
    state = stale ? 'failed' : 'pending'
  } else if (failedAt > 0 && failedAt >= startedAt) {
    // 失败优先于「在跑」：started 与 failed 撞在同一毫秒是常态（假进程同步退出、真进程
    // 秒退都会这样），先判 running 会把「已经失败」读成「还在跑」，面板就此永远转圈。
    state = 'failed'
  } else if (startedAt > 0 && now - startedAt > timeoutMs) {
    // 起了进程、过了判活窗口，却既没有正常退出行也没有失败行：这一轮的收尾凭据永远不会来了
    // （宿主重启、进程被外部结束都会这样）。不判它一句，面板就永久停在「整理中」、按钮一并
    // 被禁掉——重启一次宿主就足以把按钮锁死。有凭据的轮次在这条之前已经走掉了，轮不到它。
    state = 'failed'
    failedCode = TIDY_RUN_FAILURES.abandoned
  } else if (startedAt > 0) {
    state = 'running'
  } else if (latest !== null && (pending === null || latest.at > pending.createdAt)) {
    state = latest.at >= now - resultMaxAgeMs ? 'done' : 'idle'
  }
  if (state === 'failed' && stale) failedCode = TIDY_RUN_FAILURES.stale
  // 报给面板的批次只能是**这一轮**的产出：库里留着更早的批次（前几轮的、别的工作区的）时，
  // 把它的批次号挂到这次的完成态上，用户会拿到一个自己没见过的批次号与一条撤回提示
  // （2026-09-22 真机实测撞见：本轮什么都没合，面板却报出旧批次的编号）。没有本轮产出
  // 就报 null，状态行照实说「没有需要合并的条目」。
  const own = freshBatch ? latest : null
  return {
    state,
    batchId: state === 'done' && own !== null ? own.batchId : null,
    batchCount: state === 'done' && own !== null ? own.count : null,
    batchAt: latest === null ? null : latest.at,
    failure: state === 'failed' ? failedCode : null,
    startedAt: startedAt > 0 ? startedAt : null,
    lines: tidyRunLines(state, state === 'done' && own !== null ? { batchId: own.batchId, count: own.count } : null, state === 'failed' ? failedCode : null, input.language),
  }
}

/** 状态行的失败原因文案（en 源文 / zh 译文）。 */
const TIDY_RUN_FAILURE_TEXT = {
  en: {
    spawn: 'the tidy session could not be started (the executor command failed to launch)',
    exit: 'the tidy session exited without finishing a batch',
    timeout: `no tidy session came up within the wait window`,
    disabled: 'the background executor is switched off (tidy.enabled: false)',
    stale: 'the request is older than the wait window and no session picked it up',
    abandoned: 'the round started but never reported back within the wait window (the host may have restarted, or the process was killed)',
  },
  zh: {
    spawn: '后台会话起不来（执行体命令没能拉起）',
    exit: '后台会话没跑完一批就退出了',
    timeout: '等待窗口内没有后台会话起来',
    disabled: '后台执行体已关（tidy.enabled: false）',
    stale: '标记的等待窗口已过，没有会话接手',
    abandoned: '这一轮起了却没在判活窗口内收尾（多半是宿主重启，或进程被外部结束了）',
  },
}

/**
 * 状态行文案（状态与失败的措辞单一出处；面板与服务端响应共用同一份）。
 * @param {'idle' | 'pending' | 'running' | 'done' | 'failed'} state - 状态。
 * @param {{batchId: string, count: number | null} | null} latest - 完成时的批次。
 * @param {string | null} failure - 失败码。
 * @param {'en'|'zh'} [language] - 语言。
 * @returns {string[]} 状态行（最多两行）。
 */
export function tidyRunLines(state, latest, failure, language = 'en') {
  const zh = language === 'zh'
  if (state === 'done' && latest !== null) {
    const count = latest.count === null
      ? (zh ? '已合并若干组' : 'merged one or more groups')
      : (zh ? `合并 ${latest.count} 组` : `merged ${latest.count} group(s)`)
    return [
      zh
        ? `已完成 · ${count} · 批次 ${latest.batchId}`
        : `Done · ${count} · batch ${latest.batchId}`,
      zh
        ? `不同意可整批撤回：\`/memory restore --batch=${latest.batchId}\`；面板下方的批次块里也有撤回按钮。`
        : `Disagree? Roll the whole batch back with \`/memory restore --batch=${latest.batchId}\` — the batch block below has the button too.`,
    ]
  }
  if (state === 'done' && latest === null) {
    // 正常退出但一轮没落下任何批次：无事可做是合法结局（内置任务文本也这么告诉那一轮的模型），
    // 状态行就照实说，不去编一个「合并 0 组」。
    return [zh
      ? '已完成 · 没有需要合并的条目'
      : 'Done · nothing needed merging']
  }
  if (state === 'running') {
    return [zh
      ? '整理中…（后台会话在跑，本行自己会更新）'
      : 'Tidying… (a background session is running; this line updates on its own)']
  }
  if (state === 'pending') {
    return [zh
      ? '已排队，正在等后台会话起来…'
      : 'Queued — waiting for the background session to come up…']
  }
  if (state === 'failed') {
    const table = TIDY_RUN_FAILURE_TEXT[zh ? 'zh' : 'en']
    // 失败行里那句文本可能是已知失败码，也可能是执行体自己报的原因（自由字符串）——
    // 认得出就翻成人话，认不出原样端出来：「写得难看」好过「说得不准」。
    const reason = /** @type {Record<string, string>} */ (table)[failure ?? 'spawn'] ?? (failure ?? table.spawn)
    return [
      zh ? `整理失败：${reason}` : `Tidy failed: ${reason}`,
      zh ? '按「重试」再排一次；也可以说「整理一下记忆」，让当前会话的模型来做。' : 'Press Retry to queue it again, or say "tidy my memory" and let the current session do it.',
    ]
  }
  return [zh
    ? '点一下就交给后台：不起对话、不占上下文。结果回在「最近整理批次」里，同意与否都能整批撤回。'
    : 'One click hands it to the background: no conversation, no context cost. The result lands in the batch block below, and a whole batch can always be rolled back.']
}

/**
 * 一轮整理轮的行数上限（看最近这些行足够判出状态；审计流每天都在长，
 * 固定窗口一满就会把更早的记录挤出去，故按动作精确取而不是靠窗口大小）。
 */
export const TIDY_RUN_AUDIT_WINDOW = 200

/** 从审计行文本里抠批次号（整理轮的收尾行记的就是它；抠不出即 null）。 */
export function batchIdFromAudit(/** @type {TidyAuditRow} */ row) {
  const match = /batch[=\s]+([0-9a-fA-F-]{8,})/.exec(typeof row?.text === 'string' ? row.text : '')
  return match === null ? null : match[1]
}

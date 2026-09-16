// lib/consolidate.mjs — F6 整理机纯函数核心（零 DSH 依赖）。
//
// 整理机的语义判断（哪几条在讲同一件事）由**当前会话的模型**做，本文件只做机械部分：
// ① 挑候选（热度公式，规格 3.5.10）；② 跳过已整理（`merged` 标，规格 3.5.11）；
// ③ 划桶（桶内不跨，规格 3.5.8）；④ 算积压量（开工线，规格 3.5.1）；
// ⑤ 把握分级（`gradeMerge`：哪一批不必再过人眼就能合，见其 JSDoc 的档位判据）。
//
// 一句话边界：本文件不读库、不写库、不调模型、不知 DSH 存在；index.mjs 把库里的
// 条目喂进来，把这份计划交给模型，模型再经 memory 工具落写。

import { MERGED_TAG } from './protocol.mjs'
import { jaccard, tokenSet } from './stats.mjs'
import { InvalidInputError } from './errors.mjs'
import { MERGE_GATES, MERGE_GRADE_LINES, MERGE_VERDICTS } from './constants.mjs'

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
 * @param {PlanEntry[]} entries - 全部条目。
 * @param {{now?: number, windowDays?: number, popularRecallCount?: number, limit?: number}} [options] - {now, windowDays, popularRecallCount, limit}。
 * @returns {{candidates: PlanEntry[], skippedMerged: number, skippedSuperseded: number, inWindow: number, windowFrom: number}} 候选与跳过账目。
 */
export function selectCandidates(entries, options = {}) {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? HEAT_WINDOW_DAYS
  const popularRecallCount = options.popularRecallCount ?? POPULAR_RECALL_COUNT
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT
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
    if (recent || (entry.recallCount ?? 0) >= popularRecallCount) hot.push(entry)
  }
  hot.sort((a, b) =>
    (b.recallCount ?? 0) - (a.recallCount ?? 0)
    || b.updatedAt - a.updatedAt
    || a.createdAt - b.createdAt
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { candidates: hot.slice(0, limit), skippedMerged, skippedSuperseded, inWindow, windowFrom }
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

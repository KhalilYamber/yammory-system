// lib/stats.mjs — F7 可观测三数（零 DSH 依赖，纯函数）。
//
// 三个数回答的是「这套记忆有没有在变好」：
// ① 重复率——条目在讲同一件事的比例（tokenize ＋ Jaccard，O(n²)，语料小可接受）；
// ② 召回命中率——查了有命中 / 查了总数（供数靠 recalled 审计行的 outcome）；
// ③ 注入量——预热段每次注入的字符数与条数（取自 audit(snapshot) 行）。
//
// 「注入量-成功率」里的**成功率刻意留空**（buildStats 返回 successRate: null）：
// 它的本义是「注入之后对方是否真的听懂了」，本仓库没有这条信号源。拿别的东西
// 冒充（例如把命中率改叫成功率）比留白更坏——留白至少诚实。
//
// 本文件只做度量，不写库、不调模型、不落审计；阈值是默认值（可传参覆盖）。

import { tokenize } from './retrieval.mjs'

/** 判「重复」的 Jaccard 线（同一件事的两种说法通常落在 0.7 以上）。 */
export const DUPLICATE_THRESHOLD = 0.7

/** 重复率两两比较的条目上限；超出时只算前 N 条并在结果里如实标注（绝不静默截断）。 */
export const MAX_COMPARED_ENTRIES = 500

/** 重复对样本的展示上限。 */
export const TOP_PAIRS = 5

/** 审计窗口默认行数（命中率与注入量都只看这个窗口内的行，窗口大小如实回报）。 */
export const AUDIT_WINDOW = 1000

/**
 * 词元集合（与 keyword 检索器同一套 tokenize：CJK 相邻二字 bigram ＋ 拉丁/数字整词）。
 * @param {string} text - 条目正文。
 * @returns {Set<string>} 词元集合。
 */
export function tokenSet(text) {
  return new Set(tokenize(typeof text === 'string' ? text : ''))
}

/**
 * Jaccard 相似度 = 交集 / 并集（两边都空 → 0，不是 1：两句空话谈不上「相似」）。
 * @param {Set<string>} a - 词元集合 A。
 * @param {Set<string>} b - 词元集合 B。
 * @returns {number} 0..1。
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const token of small) {
    if (large.has(token)) shared += 1
  }
  return shared / (a.size + b.size - shared)
}

/** 条目的 status 归一（老行可能没有 status 列值）。 */
function isActive(/** @type {{status?: unknown}} */ entry) {
  return (entry.status ?? 'active') === 'active'
}

/**
 * 重复率：两两相似度超阈值的对占比。只算 active 条目（降级条目已不在场）。
 * @param {Array<{id?: string, text: string, status?: string}>} entries - 条目（可含已降级；内部自行过滤）。
 * @param {{threshold?: number, top?: number, maxEntries?: number}} [options] - 阈值与样本数。
 * @returns {{entries: number, considered: number, truncated: boolean, pairs: number, comparablePairs: number, ratio: number | null, flaggedEntries: number, top: Array<{a: string, b: string, similarity: number, aId: string | null, bId: string | null}>, threshold: number}} 重复率账目。
 */
export function repetitionStats(entries, options = {}) {
  const threshold = options.threshold ?? DUPLICATE_THRESHOLD
  const top = options.top ?? TOP_PAIRS
  const maxEntries = options.maxEntries ?? MAX_COMPARED_ENTRIES
  const active = entries.filter(isActive)
  const considered = active.slice(0, maxEntries)
  const sets = considered.map((entry) => tokenSet(entry.text))
  let pairs = 0
  let comparablePairs = 0
  /** @type {Set<number>} */
  const flagged = new Set()
  /** @type {Array<{a: string, b: string, similarity: number, aId: string | null, bId: string | null}>} */
  const samples = []
  for (let i = 0; i < considered.length; i += 1) {
    for (let j = i + 1; j < considered.length; j += 1) {
      // 两边都无词元（空白/纯符号）不构成可比对样本——算进去会凭空拉低重复率。
      if (sets[i].size === 0 || sets[j].size === 0) continue
      comparablePairs += 1
      const similarity = jaccard(sets[i], sets[j])
      if (similarity < threshold) continue
      pairs += 1
      flagged.add(i)
      flagged.add(j)
      samples.push({
        a: clip(considered[i].text),
        b: clip(considered[j].text),
        similarity: Number(similarity.toFixed(4)),
        aId: considered[i].id ?? null,
        bId: considered[j].id ?? null,
      })
    }
  }
  samples.sort((x, y) => y.similarity - x.similarity)
  return {
    entries: active.length,
    considered: considered.length,
    truncated: active.length > considered.length,
    pairs,
    comparablePairs,
    ratio: comparablePairs === 0 ? null : pairs / comparablePairs,
    flaggedEntries: flagged.size,
    top: samples.slice(0, top),
    threshold,
  }
}

/**
 * 召回命中率：有命中的 recall 次数 ÷ 总 recall 次数（数据源 = `recalled` 审计行）。
 * outcome 语义：'ok' = 有命中，'empty' = 零命中（F7-2 起补记），其余（缺列/旧格式）
 * 单列 unknown 如实报出，不并进分子。
 * @param {Array<{action?: string, outcome?: string | null}>} auditRows - 审计行。
 * @returns {{total: number, hits: number, empty: number, unknown: number, rate: number | null}} 命中率账目（无样本时 rate 为 null）。
 */
export function recallHitStats(auditRows) {
  const recalls = auditRows.filter((row) => row.action === 'recalled')
  let hits = 0
  let empty = 0
  let unknown = 0
  for (const row of recalls) {
    if (row.outcome === 'ok') hits += 1
    else if (row.outcome === 'empty') empty += 1
    else unknown += 1
  }
  return {
    total: recalls.length,
    hits,
    empty,
    unknown,
    rate: recalls.length === 0 ? null : hits / recalls.length,
  }
}

/**
 * 注入量：预热段每次注入的字符数与条数（数据源 = `snapshot` 审计行的 text）。
 * 条数按预热段的条目行（`- ` 开头）数出来——是估算而非精确计数，措辞里照说。
 * @param {Array<{ts?: number, action?: string, text?: string | null}>} auditRows - 审计行。
 * @returns {{samples: number, lastChars: number | null, lastEntries: number | null, lastTs: number | null, avgChars: number | null, avgEntries: number | null}} 注入量账目。
 */
export function injectionStats(auditRows) {
  const snapshots = auditRows.filter((row) => row.action === 'snapshot' && typeof row.text === 'string' && row.text.length > 0)
  if (snapshots.length === 0) {
    return { samples: 0, lastChars: null, lastEntries: null, lastTs: null, avgChars: null, avgEntries: null }
  }
  // auditList 按 seq 倒序（最新在前），last* 取最新一行。
  const latest = snapshots[0]
  let chars = 0
  let entries = 0
  for (const row of snapshots) {
    const text = /** @type {string} */ (row.text)
    chars += text.length
    entries += countBulletLines(text)
  }
  return {
    samples: snapshots.length,
    lastChars: /** @type {string} */ (latest.text).length,
    lastEntries: countBulletLines(/** @type {string} */ (latest.text)),
    lastTs: latest.ts ?? null,
    avgChars: Math.round(chars / snapshots.length),
    avgEntries: Number((entries / snapshots.length).toFixed(2)),
  }
}

/**
 * 三数总装（`/memory stats` 的数据面）。
 * @param {{entries: Array<{id?: string, text: string, status?: string}>, auditRows: Array<{action?: string, outcome?: string | null, text?: string | null, ts?: number}>, threshold?: number, auditWindow?: number}} input - {entries, auditRows, threshold?, auditWindow?}。
 * @returns {{repetition: ReturnType<typeof repetitionStats>, recall: ReturnType<typeof recallHitStats>, injection: ReturnType<typeof injectionStats>, auditWindow: number, superseded: number, successRate: null}} 三数报告。
 */
export function buildStats(input) {
  const entries = input.entries ?? []
  const auditRows = input.auditRows ?? []
  return {
    repetition: repetitionStats(entries, input.threshold === undefined ? {} : { threshold: input.threshold }),
    recall: recallHitStats(auditRows),
    injection: injectionStats(auditRows),
    auditWindow: input.auditWindow ?? auditRows.length,
    superseded: entries.filter((entry) => !isActive(entry)).length,
    // 成功率没有信号源（见文件头）：这里永远是 null，不得用别的数冒充。
    successRate: null,
  }
}

/** 样本文本裁剪（展示用，不改动被统计的原文）。 */
function clip(/** @type {string} */ text) {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** 预热段里的条目行数（`- ` 开头的行）。 */
function countBulletLines(/** @type {string} */ text) {
  let count = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) count += 1
  }
  return count
}

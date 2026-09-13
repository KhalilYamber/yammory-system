// test/consolidate.test.mjs — F6 整理机纯函数核心（方案 docs/F6F7施工方案.md §1）。
//
// 这一层只做机械判断：挑谁（热度）、跳过谁（merged 标 / 已降级）、能不能放一桶（桶内不跨）、
// 攒够没有（开工线）。「哪几条在讲同一件事」是模型的活，不在这里断言。

import test from 'node:test'
import assert from 'node:assert/strict'
import { MERGED_TAG } from '../lib/protocol.mjs'
import {
  HEAT_WINDOW_DAYS,
  MAX_PAIRS_PER_BUCKET,
  TIDY_DEFAULTS,
  backlogOf,
  bucketKeyOf,
  buildTidyPlan,
  groupByBucket,
  isActive,
  isMerged,
  selectCandidates,
  similarPairs,
} from '../lib/consolidate.mjs'

const NOW = 1700000000000
const HOUR = 3600000

/** 合成条目（与 store 条目同形；内容全是编造的通用示例）。 */
function entry(def) {
  return {
    id: def.id,
    track: def.track ?? 'user',
    scope: def.scope ?? 'user-global',
    agentKey: def.agentKey ?? '',
    workspaceKey: def.workspaceKey ?? (def.scope === 'workspace' ? 'C:\\work\\proj' : ''),
    text: def.text,
    source: 'fixture',
    tags: def.tags ?? [],
    version: 1,
    facet: null,
    level: null,
    status: def.status ?? 'active',
    createdAt: def.createdAt ?? NOW - 1000,
    updatedAt: def.updatedAt ?? NOW - 1000,
    lastRecalled: null,
    recallCount: def.recallCount ?? 0,
    sessionId: null,
  }
}

test('F6 纯函数：isMerged 认 tags 里的 merged 标，isActive 认 status（缺列按在场算）', () => {
  assert.equal(isMerged(entry({ id: 'a', text: 'x', tags: [MERGED_TAG] })), true)
  assert.equal(isMerged(entry({ id: 'b', text: 'x', tags: ['observation'] })), false)
  assert.equal(isMerged(entry({ id: 'c', text: 'x' })), false, '没有 tags 不炸')
  assert.equal(isActive(entry({ id: 'd', text: 'x' })), true)
  assert.equal(isActive({ text: 'x' }), true, 'status 列缺失按在场算')
  assert.equal(isActive(entry({ id: 'e', text: 'x', status: 'superseded' })), false)
})

test('F6 纯函数：桶键 = track × scope × agentKey（workspace 层追加工作区键）', () => {
  assert.equal(bucketKeyOf(entry({ id: 'a', text: 'x' })), 'user/user-global')
  assert.equal(bucketKeyOf(entry({ id: 'b', text: 'x', track: 'agent', scope: 'workspace' })), 'agent/workspace @C:\\work\\proj')
  assert.equal(bucketKeyOf(entry({ id: 'c', text: 'x', agentKey: 'preset-a' })), 'user/user-global #preset-a')
  assert.equal(bucketKeyOf(entry({ id: 'd', text: 'x', scope: 'workspace', workspaceKey: 'D:\\other' })), 'user/workspace @D:\\other')
  // 同一 (track, scope, agent) 但不同工作区 → 不同桶（跨工作区合并会把 A 的正文搬进 B）
  assert.notEqual(
    bucketKeyOf(entry({ id: 'e', text: 'x', scope: 'workspace', workspaceKey: 'D:\\a' })),
    bucketKeyOf(entry({ id: 'f', text: 'x', scope: 'workspace', workspaceKey: 'D:\\b' })),
  )
})

test('F6 纯函数：选候选——窗口内 + 高召回，按 recall_count → updated_at 排序，截到 limit', () => {
  const entries = [
    entry({ id: 'hot-recall', text: 'a', recallCount: 9, updatedAt: NOW - 30 * 24 * HOUR }),
    entry({ id: 'recent-2', text: 'b', recallCount: 2, updatedAt: NOW - HOUR }),
    entry({ id: 'recent-5', text: 'c', recallCount: 5, updatedAt: NOW - 2 * HOUR }),
    entry({ id: 'cold-old', text: 'd', recallCount: 0, updatedAt: NOW - 30 * 24 * HOUR }),
  ]
  const selected = selectCandidates(entries, { now: NOW })
  assert.deepEqual(selected.candidates.map((candidate) => candidate.id), ['hot-recall', 'recent-5', 'recent-2'], '高召回跨出窗口也进来，且排最前')
  assert.equal(selected.inWindow, 2, '窗口内两条（InWindow 只数 7 天内的）')
  assert.equal(selected.windowFrom, NOW - HEAT_WINDOW_DAYS * 24 * HOUR)

  const limited = selectCandidates(entries, { now: NOW, limit: 1 })
  assert.deepEqual(limited.candidates.map((candidate) => candidate.id), ['hot-recall'], 'limit 生效')

  const narrow = selectCandidates(entries, { now: NOW, popularRecallCount: 10 })
  assert.deepEqual(narrow.candidates.map((candidate) => candidate.id), ['recent-5', 'recent-2'], '抬高高召回线后只剩窗口内的')
})

test('F6 纯函数：选候选跳过已整理（收益判据）与已降级，跳过的数如实回报', () => {
  const entries = [
    entry({ id: 'fresh', text: 'a' }),
    entry({ id: 'merged-1', text: 'b', tags: [MERGED_TAG] }),
    entry({ id: 'merged-2', text: 'c', tags: ['x', MERGED_TAG] }),
    entry({ id: 'gone', text: 'd', status: 'superseded' }),
  ]
  const selected = selectCandidates(entries, { now: NOW })
  assert.deepEqual(selected.candidates.map((candidate) => candidate.id), ['fresh'])
  assert.equal(selected.skippedMerged, 2, '已整理的不再动手')
  assert.equal(selected.skippedSuperseded, 1, '已降级的不在候选里')
})

test('F6 纯函数：分桶保序，同桶内保持传入顺序', () => {
  const groups = groupByBucket([
    entry({ id: 'a', text: 'x' }),
    entry({ id: 'b', text: 'y', track: 'agent', scope: 'workspace' }),
    entry({ id: 'c', text: 'z' }),
  ])
  assert.deepEqual([...groups.keys()], ['user/user-global', 'agent/workspace @C:\\work\\proj'])
  assert.deepEqual(groups.get('user/user-global').map((item) => item.id), ['a', 'c'])
})

test('F6 纯函数：桶内相似对——只比同桶候选，按相似度降序，每桶截到上限', () => {
  const pairs = similarPairs([
    entry({ id: 'a', text: '用户偏好：回复一律使用中文' }),
    entry({ id: 'b', text: '用户偏好：回复一律使用中文' }),
    entry({ id: 'c', text: '完全不相干的内容，讲的是另一码事' }),
  ])
  assert.equal(pairs.length, 1, '只有 a~b 越过提示线')
  assert.equal(pairs[0].aId, 'a')
  assert.equal(pairs[0].bId, 'b')
  assert.equal(pairs[0].similarity, 1, '逐字相同 → 相似度 1')

  const many = similarPairs(Array.from({ length: 7 }, (_, index) => entry({ id: `m${index}`, text: '同一条意思重复七遍' })))
  assert.equal(many.length, MAX_PAIRS_PER_BUCKET, '21 对截到上限 12')
  assert.ok(many[0].similarity >= many[many.length - 1].similarity, '按相似度降序')
})

test('F6 纯函数：积压量——字符线、条数线、12 小时兜底三条路各走一次', () => {
  const small = [entry({ id: 'a', text: '短', createdAt: NOW - HOUR, updatedAt: NOW - HOUR })]
  const below = backlogOf(small, { now: NOW, since: 0 })
  assert.equal(below.due, false)
  assert.equal(below.reason, null)
  assert.equal(below.hours, null, '从没整理过 → 没有「距上次整理」这个数')
  assert.equal(below.dueByTime, false, '新库第一天不喊该整理了')

  const long = [entry({ id: 'b', text: 'x'.repeat(TIDY_DEFAULTS.charsLine), createdAt: NOW - HOUR, updatedAt: NOW - HOUR })]
  const byChars = backlogOf(long, { now: NOW, since: 0 })
  assert.equal(byChars.overChars, true)
  assert.equal(byChars.reason, 'chars')

  const many = Array.from({ length: TIDY_DEFAULTS.entriesLine }, (_, index) => entry({ id: `n${index}`, text: 'x', createdAt: NOW - HOUR, updatedAt: NOW - HOUR }))
  const byCount = backlogOf(many, { now: NOW, since: 0 })
  assert.equal(byCount.overCount, true)
  assert.equal(byCount.reason, 'count')

  const byTime = backlogOf(small, { now: NOW, since: NOW - 13 * HOUR })
  assert.equal(byTime.dueByTime, true)
  assert.equal(byTime.reason, 'time')
  assert.equal(byTime.hours, 13)

  const quiet = backlogOf([entry({ id: 'old', text: '短', createdAt: NOW - 30 * HOUR, updatedAt: NOW - 30 * HOUR })], { now: NOW, since: NOW - 11 * HOUR })
  assert.equal(quiet.count, 0, '这段时间没有变动')
  assert.equal(quiet.due, false, '时间到了但没有变动 → 不喊')

  // 已降级条目不算积压（它们不在场）
  const withGone = backlogOf([...small, entry({ id: 'gone', text: 'x'.repeat(5000), status: 'superseded' })], { now: NOW, since: 0 })
  assert.equal(withGone.chars, '短'.length)
})

test('F6 纯函数：整理计划——候选分桶 ＋ 桶内相似线索 ＋ 批次提示，空库返回空计划', () => {
  const plan = buildTidyPlan([
    entry({ id: 'a', text: '用户偏好：回复使用中文' }),
    entry({ id: 'b', text: '用户偏好：回复使用中文' }),
    entry({ id: 'c', text: '环境事实：CI 用 GitHub Actions', track: 'agent' }),
  ], { now: NOW, since: NOW - 2 * HOUR })
  assert.equal(plan.candidates, 3)
  assert.equal(plan.buckets.length, 2)
  const userBucket = /** @type {any} */ (plan.buckets.find((bucket) => bucket.key === 'user/user-global'))
  assert.equal(userBucket.candidates.length, 2)
  assert.equal(userBucket.pairs.length, 1)
  assert.equal(userBucket.batchHint, 1)
  assert.equal(plan.backlog.count, 3)
  assert.equal(plan.windowDays, HEAT_WINDOW_DAYS)

  const empty = buildTidyPlan([], { now: NOW })
  assert.equal(empty.candidates, 0)
  assert.deepEqual(empty.buckets, [])
  assert.equal(empty.backlog.due, false)

  // 21 条同桶候选 → 建议两批（每批 ≤20）
  const many = Array.from({ length: 21 }, (_, index) => entry({ id: `m${index}`, text: `条目 ${index}` }))
  const batched = buildTidyPlan(many, { now: NOW, candidateLimit: 30 })
  assert.equal(batched.buckets[0].batchHint, 2)

  const capped = buildTidyPlan(many, { now: NOW, candidateLimit: 5 })
  assert.equal(capped.candidates, 5, 'candidateLimit 生效')
})

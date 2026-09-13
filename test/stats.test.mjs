// test/stats.test.mjs — F7 可观测三数（方案 docs/F6F7施工方案.md §2）。
//
// 三个数里前两个是能算准的账，第三个只报注入量——「成功率」没有信号源，
// 用例专门钉住它必须是 null（拿别的数冒充比留白更坏）。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_WINDOW,
  DUPLICATE_THRESHOLD,
  buildStats,
  injectionStats,
  jaccard,
  recallHitStats,
  repetitionStats,
  tokenSet,
} from '../lib/stats.mjs'

/** 合成条目（只带 stats 用得到的字段）。 */
function entry(id, text, status = 'active') {
  return { id, text, status }
}

/** 合成 snapshot 审计行（预热段文本）。 */
function snapshot(text, ts) {
  return { action: 'snapshot', text, ts, outcome: 'ok' }
}

test('F7 stats：tokenSet / jaccard —— 同一套分词，空集不参与相似', () => {
  assert.equal(jaccard(tokenSet('用户偏好中文回复'), tokenSet('用户偏好中文回复')), 1)
  assert.equal(jaccard(tokenSet('完全不相干的两个句子'), tokenSet('abcdefg')), 0)
  assert.equal(jaccard(new Set(), tokenSet('任意内容')), 0, '空集 → 0（不谈相似，也不虚报 1）')
  assert.equal(jaccard(tokenSet('   '), tokenSet('任意内容')), 0, '纯空白分词为空')
  const partial = jaccard(tokenSet('用户偏好中文回复'), tokenSet('用户偏好英文回复'))
  assert.ok(partial > 0 && partial < 1, `部分重合落在 0..1（实际 ${partial}）`)
})

test('F7 stats：重复率——空库 / 单条没有样本，重复的两条给出 100%', () => {
  const empty = repetitionStats([])
  assert.equal(empty.ratio, null, '没有条目 → 无样本')
  assert.equal(empty.comparablePairs, 0)
  assert.deepEqual(empty.top, [])

  const single = repetitionStats([entry('a', '只有一条记忆')])
  assert.equal(single.ratio, null, '一条没有可比对的对')
  assert.equal(single.entries, 1)

  const dup = repetitionStats([entry('a', '用户偏好：回复一律使用中文'), entry('b', '用户偏好：回复一律使用中文')])
  assert.equal(dup.pairs, 1)
  assert.equal(dup.comparablePairs, 1)
  assert.equal(dup.ratio, 1)
  assert.equal(dup.flaggedEntries, 2)
  assert.equal(dup.top[0].similarity, 1)
  assert.equal(dup.top[0].aId, 'a')

  const distinct = repetitionStats([entry('a', '用户偏好：回复一律使用中文'), entry('b', '环境事实：CI 跑在三台机器上')])
  assert.equal(distinct.ratio, 0, '不相似 → 0%（有样本，只是没重复）')

  const blanks = repetitionStats([entry('a', '   '), entry('b', '\n')])
  assert.equal(blanks.comparablePairs, 0, '两边都没词元 → 不是可比对样本')
  assert.equal(blanks.ratio, null)
})

test('F7 stats：重复率——阈值可调、已降级不进统计、超上限如实标截断', () => {
  const entries = [
    entry('a', '用户偏好：回复一律使用中文'),
    entry('b', '用户偏好：回复一律使用中文'),
    entry('gone', '用户偏好：回复一律使用中文', 'superseded'),
  ]
  assert.equal(repetitionStats(entries).entries, 2, '降级条目不在场，不参与统计')

  const strict = repetitionStats([entry('a', '用户偏好中文回复'), entry('b', '用户偏好英文回复')], { threshold: 0.99 })
  assert.equal(strict.pairs, 0, '阈值抬高后不算重复')
  assert.equal(strict.threshold, 0.99)

  const capped = repetitionStats(
    [entry('a', '用户偏好：回复一律使用中文'), entry('b', '用户偏好：回复一律使用中文'), entry('c', '用户偏好：回复一律使用中文')],
    { maxEntries: 2 },
  )
  assert.equal(capped.truncated, true, '超过比较上限要如实标出，不静默')
  assert.equal(capped.considered, 2)
  assert.equal(capped.entries, 3)
  assert.equal(DUPLICATE_THRESHOLD, 0.7, '默认阈值是常量，不藏在函数体里')
})

test('F7 stats：召回命中率——ok 记命中、empty 记零命中、其它记未标注，无样本为 null', () => {
  const none = recallHitStats([])
  assert.equal(none.total, 0)
  assert.equal(none.rate, null, '窗口里没有召回 → 无样本（不是 0%）')

  const rows = [
    { action: 'recalled', outcome: 'ok' },
    { action: 'recalled', outcome: 'empty' },
    { action: 'recalled', outcome: 'ok' },
    { action: 'recalled', outcome: null },
    { action: 'add', outcome: 'ok' },
  ]
  const stats = recallHitStats(rows)
  assert.equal(stats.total, 4, '只数 recalled 行')
  assert.equal(stats.hits, 2)
  assert.equal(stats.empty, 1)
  assert.equal(stats.unknown, 1)
  assert.equal(stats.rate, 0.5)
})

test('F7 stats：注入量——无快照为 null；多条取最近一次并给均值；条数按预热段条目行数', () => {
  assert.deepEqual(injectionStats([]).samples, 0)
  assert.equal(injectionStats([{ action: 'add', text: '普通写' }]).lastChars, null, '非 snapshot 行不参与')

  const older = snapshot('## 标题\n- 条目一\n- 条目二', 1000)
  const latest = snapshot('[预热块]\n\n## 常驻画像\n- 条目三', 2000)
  const stats = injectionStats([latest, older])
  assert.equal(stats.samples, 2)
  assert.equal(stats.lastChars, latest.text.length, 'auditList 倒序 → 首行即最近一次')
  assert.equal(stats.lastEntries, 1)
  assert.equal(stats.lastTs, 2000)
  assert.equal(stats.avgChars, Math.round((older.text.length + latest.text.length) / 2))
  assert.equal(stats.avgEntries, 1.5)
})

test('F7 stats：三数总装——成功率必须是 null（没有信号源就不冒充）', () => {
  const stats = buildStats({
    entries: [entry('a', '用户偏好：回复一律使用中文'), entry('b', '用户偏好：回复一律使用中文'), entry('gone', 'x', 'superseded')],
    auditRows: [{ action: 'recalled', outcome: 'ok' }, { action: 'recalled', outcome: 'empty' }, snapshot('- 条目', 5)],
    auditWindow: 3,
  })
  assert.equal(stats.repetition.ratio, 1)
  assert.equal(stats.recall.rate, 0.5)
  assert.equal(stats.injection.lastChars, '- 条目'.length)
  assert.equal(stats.superseded, 1)
  assert.equal(stats.auditWindow, 3)
  assert.equal(stats.successRate, null, '成功率没有信号源：恒为 null')

  const bare = buildStats({})
  assert.equal(bare.successRate, null)
  assert.equal(bare.repetition.ratio, null)
  assert.equal(bare.recall.rate, null)
  assert.equal(bare.injection.samples, 0)
  assert.equal(typeof AUDIT_WINDOW, 'number')
})

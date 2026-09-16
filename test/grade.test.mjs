// test/grade.test.mjs — 把握分级（硬杠判定表）：三档判定的接口面与依据面。
//
// 这个函数的全部价值在于「哪一批不必再过人眼就能合」，所以用例沿三条线钉：
// ① **标注表**——同字面重复／部分重合／形似实异／跨桶／超条数等合成夹具，逐条对照期望档位；
// ② **依据可复述**——`passed`/`failed` 与逐杠 detail 必须与 gates 自洽，不是一句「我判过了」；
// ③ **确定性**——同输入连调两次逐字节相同，且函数体内无时钟、无随机、无网络。
//
// 口径说明：Jaccard 是**字面**尺子。实测「改写过的同义句」只有 0.11，低于「形似实异」的
// 0.27——所以字面不重合的同义条目落 `skip`（原地不动，语义判断留给会话里的模型），
// 这不是漏判，是本表职责边界的如实体现。
//
// 判据演进（红队高 1 撬出）：auto 档额外要求「去空白标点后逐字一致」。词元重合度对长条目
// 里的一字之差极不敏感——实测「…自动遵守它／…自动不遵守它」sim=0.9、「2000／3000」sim=0.9167，
// 两条都在 auto 线以上，光靠阈值会把语义反转判成「可直接合」。故把「把握」落到
// 「有没有任何实质字符差异」这个二元事实上，而不是某个阈值上。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gradeMerge } from '../lib/consolidate.mjs'
import { ERROR_CODES, MERGE_GATES, MERGE_GRADE_LINES, MERGE_VERDICTS } from '../lib/constants.mjs'

/** 用户轨条目（同桶基准；合成数据，不掺真实记忆）。 */
function entry(/** @type {string} */ id, /** @type {string} */ text) {
  return { id, track: 'user', scope: 'user-global', text, createdAt: 1, updatedAt: 1 }
}

/** 智能体轨条目（只用于跨桶用例）。 */
function agentEntry(/** @type {string} */ id, /** @type {string} */ text) {
  return { id, track: 'agent', scope: 'user-global', text, createdAt: 1, updatedAt: 1 }
}

/** 六条同文本（超条数用例）。 */
const sixIdentical = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry(id, '偏好中文回复'))

/**
 * 人工标注表：期望档位由使用者（人）标定，数值由实跑取回。
 * @type {Array<{name: string, members: Array<{id: string, track: string, scope: string, text: string, createdAt: number, updatedAt: number}>, mergedText: string, verdict: string, similarity: number | null, coverage: number | null, failed: string[]}>}
 */
const TABLE = [
  {
    name: '同字面重复（末尾句号不切断 bigram）',
    members: [entry('a', '偏好中文回复'), entry('b', '偏好中文回复。')],
    mergedText: '偏好中文回复',
    verdict: 'auto',
    similarity: 1,
    coverage: 1,
    failed: [],
  },
  {
    name: '标点切断 bigram（字面几乎相同）',
    members: [entry('a', '材料物理专业在读大二'), entry('b', '材料物理专业，在读大二。')],
    mergedText: '材料物理专业在读大二',
    verdict: 'auto',
    similarity: 0.8889,
    coverage: 1,
    failed: [],
  },
  {
    name: '一字之差的语义反转（长句：重合度 0.9 也不许自动合）',
    members: [
      entry('a', '用户希望记住这条长期偏好设置并且以后每次对话都要自动遵守它'),
      entry('b', '用户希望记住这条长期偏好设置并且以后每次对话都要自动不遵守它'),
    ],
    mergedText: '用户希望记住这条长期偏好设置并且以后每次对话都要自动遵守它',
    verdict: 'review',
    similarity: 0.9,
    coverage: 0.931,
    failed: [MERGE_GATES.verbatim],
  },
  {
    name: '一字之差的数值不同（长句：同样不许自动合）',
    members: [
      entry('a', '用户的记忆库字符上限设置为 2000 个字符并在超线时只给提示'),
      entry('b', '用户的记忆库字符上限设置为 3000 个字符并在超线时只给提示'),
    ],
    mergedText: '用户的记忆库字符上限设置为 2000 个字符并在超线时只给提示',
    verdict: 'review',
    similarity: 0.9167,
    coverage: 0.9565,
    failed: [MERGE_GATES.verbatim],
  },
  {
    name: '完全一致',
    members: [entry('a', '偏好中文回复'), entry('b', '偏好中文回复')],
    mergedText: '偏好中文回复',
    verdict: 'auto',
    similarity: 1,
    coverage: 1,
    failed: [],
  },
  {
    name: '字面部分重合（三条近重复）',
    members: [entry('a', '偏好中文回复'), entry('b', '偏好中文回复。'), entry('c', '偏好用中文回复')],
    mergedText: '偏好中文回复',
    verdict: 'review',
    similarity: 0.5714,
    coverage: 0.6667,
    failed: [MERGE_GATES.verbatim],
  },
  {
    name: '明显同义（字面不重合：字面口径判不了，如实落 skip）',
    members: [entry('a', '用户偏好直接给结论'), entry('b', '用户不喜欢铺垫，希望先看到结论')],
    mergedText: '用户偏好直接给结论，不喜欢铺垫',
    verdict: 'skip',
    similarity: 0.1111,
    coverage: 0.5,
    failed: [MERGE_GATES.verbatim, MERGE_GATES.similarity, MERGE_GATES.coverage],
  },
  {
    name: '形似实异',
    members: [entry('a', '用户偏好中文回复'), entry('b', '用户偏好英文界面')],
    mergedText: '用户偏好中文回复与英文界面',
    verdict: 'skip',
    similarity: 0.2727,
    coverage: 0.8571,
    failed: [MERGE_GATES.verbatim, MERGE_GATES.similarity],
  },
  {
    name: '跨桶（字面全同也不合）',
    members: [entry('a', '偏好中文回复'), agentEntry('b', '偏好中文回复')],
    mergedText: '偏好中文回复',
    verdict: 'skip',
    similarity: 1,
    coverage: 1,
    failed: [MERGE_GATES.sameBucket],
  },
  {
    name: '超条数',
    members: sixIdentical,
    mergedText: '偏好中文回复',
    verdict: 'skip',
    similarity: 1,
    coverage: 1,
    failed: [MERGE_GATES.memberCount],
  },
  {
    name: '单条（不构成合并）',
    members: [entry('a', '偏好中文回复')],
    mergedText: '偏好中文回复',
    verdict: 'skip',
    similarity: null,
    coverage: 1,
    failed: [MERGE_GATES.memberCount, MERGE_GATES.verbatim, MERGE_GATES.similarity],
  },
  {
    name: '覆盖不足（合并文本漏掉了源条目）',
    members: [entry('a', '偏好中文回复'), entry('b', '偏好中文回复')],
    mergedText: '偏好',
    verdict: 'skip',
    similarity: 1,
    coverage: 0.2,
    failed: [MERGE_GATES.verbatim, MERGE_GATES.coverage],
  },
  {
    name: '覆盖中间带（字面全同也不自动合）',
    members: [entry('a', '偏好中文回复'), entry('b', '偏好中文回复')],
    mergedText: '偏好中文',
    verdict: 'review',
    similarity: 1,
    coverage: 0.6,
    failed: [MERGE_GATES.verbatim],
  },
]

for (const row of TABLE) {
  test(`分级标注表：${row.name} → ${row.verdict}`, () => {
    const result = gradeMerge({ members: row.members, mergedText: row.mergedText })
    assert.equal(result.verdict, row.verdict, `${row.name} 的档位`)
    assert.equal(result.similarity, row.similarity, `${row.name} 的相似度`)
    assert.equal(result.coverage, row.coverage, `${row.name} 的覆盖率`)
    assert.deepEqual(result.failed, row.failed, `${row.name} 未命中的硬杠`)
    assert.ok(MERGE_VERDICTS.includes(result.verdict), '档位必须是 MERGE_VERDICTS 的成员')
  })
}

test('分级依据：五根硬杠逐条回报命中与否，passed/failed 与 gates 自洽', () => {
  const result = gradeMerge({
    members: [entry('a', '用户偏好中文回复'), entry('b', '用户偏好英文界面')],
    mergedText: '用户偏好中文回复与英文界面',
  })
  assert.equal(result.gates.length, 5, '五根硬杠一根不少')
  assert.deepEqual(result.gates.map((gate) => gate.name), [
    MERGE_GATES.sameBucket,
    MERGE_GATES.memberCount,
    MERGE_GATES.verbatim,
    MERGE_GATES.similarity,
    MERGE_GATES.coverage,
  ])
  assert.deepEqual(result.passed, [MERGE_GATES.sameBucket, MERGE_GATES.memberCount, MERGE_GATES.coverage])
  assert.deepEqual(result.failed, [MERGE_GATES.verbatim, MERGE_GATES.similarity])
  assert.deepEqual(result.gates.filter((gate) => gate.passed).map((gate) => gate.name), result.passed)
  assert.deepEqual(result.gates.filter((gate) => !gate.passed).map((gate) => gate.name), result.failed)
  for (const gate of result.gates) {
    assert.equal(typeof gate.detail, 'string')
    assert.ok(gate.detail.length > 0, `${gate.name} 必须带上可复述的判据`)
  }
  assert.deepEqual(result.memberIds, ['a', 'b'])
  assert.equal(result.bucketKey, 'user/user-global')
  assert.deepEqual(result.lines, { ...MERGE_GRADE_LINES })
})

test('分级确定性：同输入连调两次逐字节相同（无随机、无时间依赖）', () => {
  const input = {
    members: [entry('a', '偏好中文回复'), entry('b', '偏好中文回复。'), entry('c', '偏好用中文回复')],
    mergedText: '偏好中文回复',
  }
  assert.deepEqual(gradeMerge(input), gradeMerge(input))
  // 阈值可覆盖：拿一批 verbatim 已达标、判定全由档位线决定的候选来验，
  // 抬高 auto 线它就降到 review——证明判定里没有写死的线。
  const tweakable = {
    members: [entry('a', '材料物理专业在读大二'), entry('b', '材料物理专业，在读大二。')],
    mergedText: '材料物理专业在读大二',
  }
  assert.equal(gradeMerge(tweakable).verdict, 'auto')
  const strict = gradeMerge(tweakable, { autoSimilarity: 0.95 })
  assert.equal(strict.verdict, 'review', 'auto 线抬到 0.95，同一批只到 review')
  assert.deepEqual(strict.lines, { maxMembers: 5, autoSimilarity: 0.95, reviewSimilarity: 0.5, autoCoverage: 0.9, reviewCoverage: 0.6 })
})

test('分级静态面：分级函数体内无时钟、无随机、无网络，lib 层只 import 同目录', () => {
  const source = readFileSync(new URL('../lib/consolidate.mjs', import.meta.url), 'utf8')
  const specs = [...source.matchAll(/^import .* from '([^']+)'/gmu)].map((match) => match[1])
  assert.ok(specs.length > 0, '至少有一条 import')
  assert.deepEqual(specs.filter((spec) => !spec.startsWith('./')), [], 'lib 层只允许相对同目录 import（零 DSH 依赖）')
  const start = source.indexOf('export function gradeMerge')
  const end = source.indexOf('function minPairSimilarity')
  assert.ok(start >= 0 && end > start, '源码锚点必须找得到，否则本用例会静默失效')
  const body = source.slice(start, end)
  assert.equal(/Date\.now|Math\.random|fetch\(/u.test(body), false, '分级判定不得读时钟、掷随机或发网络请求')
})

test('分级形状面：members 非数组 / mergedText 非非空字符串 → 结构化非法输入', () => {
  const isInvalid = (/** @type {unknown} */ error) => /** @type {{code?: string}} */ (error)?.code === ERROR_CODES.INVALID_INPUT
  assert.throws(() => gradeMerge(/** @type {any} */ ({ mergedText: '偏好中文回复' })), isInvalid)
  assert.throws(() => gradeMerge({ members: [], mergedText: '' }), isInvalid)
  assert.throws(() => gradeMerge(/** @type {any} */ ({ members: [], mergedText: 42 })), isInvalid)
})

test('分级依据：空批不写空过的硬杠（verbatim 在零成员上恒假）', () => {
  const result = gradeMerge({ members: [], mergedText: '偏好中文回复' })
  assert.equal(result.verdict, 'skip')
  assert.deepEqual(result.passed, [], '空批上一根都不许「通过」')
  assert.deepEqual(result.failed, [
    MERGE_GATES.sameBucket,
    MERGE_GATES.memberCount,
    MERGE_GATES.verbatim,
    MERGE_GATES.similarity,
    MERGE_GATES.coverage,
  ])
})

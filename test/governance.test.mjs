// test/governance.test.mjs — S5 治理（方案 docs/S5治理方案.md）：soft delete 回滚 ＋ 分面裁决。
//
// 这个功能的全部价值在三条线上：**回滚是严格互逆的**（只允许 superseded → active）、
// **裁决方向由表决定**（调用方没有反向参数）、**落差两条都留**（coexist 面一条都不降级）。
// 用例沿这三条线逐层钉：store.restoreEntries / tagEntries → 协议 restore / arbitrate
// （审批门 / F5 开关 / 桶边界 / 可见集 / 方向强制）→ memory 工具两个 action → 命令面两个动词。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryProtocolCore, GOVERNANCE_SOURCE } from '../lib/protocol.mjs'
import { openMemoryStore } from '../lib/store.mjs'
import { ARBITRATION_BY_FACET, ERROR_CODES, GAP_TAG, OBSERVATION_SOURCE, PROFILE_FACETS } from '../lib/constants.mjs'
import { apply, handleMemoryCommand, DEFAULT_BUDGETS, SessionMemoryOffError } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent, makeExec } from './helpers/mock-ctx.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const OFF = 's-s5-off'

/** 真 store（临时库）。 */
function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-s5-store-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, cleanup }
}

/** 真 store + 协议核心（gate 记录调用，用来证明拦截发生在审批之前）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-s5-core-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  /** @type {object[]} */
  const gateCalls = []
  const core = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    gate: async (/** @type {object} */ payload) => { gateCalls.push(payload); return 'allowed-once' },
    emit: () => {},
  })
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, core, gateCalls, cleanup }
}

const writeCtx = (/** @type {string} */ sessionId, /** @type {string} */ cwd = '/w') => ({ agent: { session: { id: sessionId, header: { cwd } } } })

/** 直接落一条条目（绕开审批：store 面造夹具）。 */
const seed = (/** @type {any} */ store, /** @type {object} */ over) => store.insertEntry({
  track: 'user', scope: 'user-global', text: '条目', ...over,
})

/** 审计行（按 seq 升序）。 */
const auditRows = (/** @type {any} */ store) => /** @type {Array<{seq: number, action: string, entry_id: string | null, text: string | null, outcome: string | null}>} */ (
  store.db.prepare('SELECT seq, action, entry_id, text, outcome FROM audit ORDER BY seq').all()
)

// ── store 层：回滚与打标 ───────────────────────────────────────────────────

test('S5 store：restoreEntries 把降级条目救回在场集（version/updated_at 不动，留痕数据在库里）', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const a = seed(store, { text: '被降级的第一条' })
  const b = seed(store, { text: '被降级的第二条' })
  const versionA = a.version
  const updatedA = a.updatedAt
  store.supersedeEntries({ ids: [a.id, b.id] })
  assert.equal(store.listEntries().length, 0, '降级后退出在场集')

  const restored = store.restoreEntries({ ids: [a.id, b.id] })
  assert.deepEqual(restored.map((entry) => entry.id), [a.id, b.id], '与 ids 同序')
  for (const entry of restored) {
    assert.equal(entry.status, 'active', '回到在场状态')
    assert.equal(store.entryById(entry.id)?.status, 'active', '库里也是 active')
  }
  assert.equal(restored[0].version, versionA, 'version 不自增（条目没被改写）')
  assert.equal(restored[0].updatedAt, updatedA, '时间线不动（时间线由审计行承担）')
  assert.equal(store.listEntries().length, 2, '两条都重新在场')
  assert.equal(store.allEntries().length, 2, '没有新增行')
  assert.equal(store.usage('user', 'user-global'), '被降级的第一条'.length + '被降级的第二条'.length, '重新计入预警线用量')
})

test('S5 store：restore 只认 superseded——active 目标与未知 id 一律响亮失败且整批回滚', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const superseded = seed(store, { text: '降级过的条目' })
  const live = seed(store, { text: '仍在场的条目' })
  store.supersedeEntries({ ids: [superseded.id] })

  assert.throws(() => store.restoreEntries({ ids: [] }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.throws(() => store.restoreEntries({ ids: [superseded.id, superseded.id] }), (error) => error.code === ERROR_CODES.INVALID_INPUT, '重复 id 入口就拒')
  assert.throws(
    () => store.restoreEntries({ ids: ['00000000-0000-4000-8000-000000000000'] }),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && error.message.includes('no entry with id'),
    '未知 id 响亮失败',
  )
  assert.throws(
    () => store.restoreEntries({ ids: [live.id] }),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /only superseded entries can be restored/.test(error.message),
    '回滚不是「改状态」的通用口子：active 目标拒绝',
  )
  // 第一个合法、第二个非法 → 整批回滚（第一条也不能被救回）
  assert.throws(() => store.restoreEntries({ ids: [superseded.id, live.id] }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.equal(store.entryById(superseded.id)?.status, 'superseded', '回滚：第一条仍在降级态')
  assert.equal(store.listEntries().length, 1, '回滚：在场集没变')
})

test('S5 store：tagEntries 补标幂等、越标签上限响亮失败、未知 id 整批回滚', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const a = seed(store, { text: '第一条', tags: ['observation'] })
  const b = seed(store, { text: '第二条' })

  const tagged = store.tagEntries({ ids: [a.id, b.id], tag: GAP_TAG })
  assert.deepEqual(tagged[0].tags, ['observation', GAP_TAG], '补标不覆盖既有标签')
  assert.deepEqual(tagged[1].tags, [GAP_TAG], '原本无标签的条目拿到一枚')
  const again = store.tagEntries({ ids: [a.id], tag: GAP_TAG })
  assert.deepEqual(again[0].tags, ['observation', GAP_TAG], '已有该标即幂等跳过，不重复写')

  assert.throws(() => store.tagEntries({ ids: [a.id], tag: '' }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.throws(() => store.tagEntries({ ids: [a.id], tag: '脏\u0000标' }), (error) => error.code === ERROR_CODES.INVALID_INPUT, '标签不许带控制字符')
  assert.throws(
    () => store.tagEntries({ ids: ['00000000-0000-4000-8000-000000000000'], tag: GAP_TAG }),
    (error) => error.code === ERROR_CODES.INVALID_INPUT,
  )

  const full = seed(store, { text: '标签塞满的条目', tags: Array.from({ length: 16 }, (_, index) => `t${index}`) })
  assert.throws(
    () => store.tagEntries({ ids: [full.id], tag: GAP_TAG }),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /would exceed 16/.test(error.message),
    '标签数越上限响亮失败，绝不静默丢弃',
  )
})

// ── 协议层：回滚 ──────────────────────────────────────────────────────────

test('S5 协议：restore 走审批门（载荷带原文），审计记 restore 行；恢复后重新进入会话可见集', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-restore')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '用户偏好中文回复' }, write)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '用户偏好中文注释' }, write)
  await core.supersede({ ids: [a.entry.id, b.entry.id], text: '偏好：中文回复与注释' }, write)
  gateCalls.length = 0

  const result = await core.restore({ ids: [a.entry.id, b.entry.id] }, write)
  assert.deepEqual(result.restored.map((entry) => entry.id), [a.entry.id, b.entry.id])
  assert.equal(gateCalls.length, 1, '一次审批整批')
  const payload = /** @type {{action: string, track: string, scope: string, text: string, source: string}} */ (gateCalls[0])
  assert.equal(payload.action, 'restore')
  assert.equal(payload.track, 'user', '单桶批次用桶的 track/scope（粒度策略键能命中）')
  assert.equal(payload.source, GOVERNANCE_SOURCE, 'source 锚死治理面标注')
  assert.ok(payload.text.includes('用户偏好中文回复'), 'approve-what-you-see：载荷带被救回条目的原文')

  // 第二次回滚同一条：它已经回到在场态 → 响亮失败（回滚严格互逆，不是「改状态」的通用口子）
  await assert.rejects(
    () => core.restore({ ids: [a.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /only superseded entries can be restored/.test(error.message),
    '已在场的条目不接受再次回滚',
  )
  assert.equal(gateCalls.length, 1, '被拒的那次没有打扰用户（校验在审批门之前）')

  const rows = auditRows(store)
  const restoreRows = rows.filter((row) => row.action === 'restore')
  assert.equal(restoreRows.length, 2, '每条救回都留一行（带正文：救回是可见性变更）')
  assert.ok(restoreRows.every((row) => row.text !== null))
  assert.equal(result.usage.used, '偏好：中文回复与注释'.length + '用户偏好中文回复'.length + '用户偏好中文注释'.length, '用量把救回的条目算回去')
  assert.equal(store.listEntries().length, 3, '救回的两条 + 合并条目都在场')
  assert.equal(store.matchCandidates('user', 'user-global', '中文注释').length, 1, '写定位重新命中（回到会话可见集）')
})

test('S5 协议：restore 拒绝已在场目标与未知 id；跨工作区/跨 agent 的条目本会话救不回', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-visible', '/w')
  const mine = await core.add({ track: 'user', scope: 'user-global', text: '本会话看得见的条目' }, write)
  const foreign = await core.add({ track: 'agent', scope: 'workspace', text: '别的工作区的事实' }, writeCtx('s-foreign', '/elsewhere'))
  assert.equal(store.entryById(foreign.entry.id)?.status, 'active')
  store.supersedeEntries({ ids: [foreign.entry.id] })
  gateCalls.length = 0

  await assert.rejects(
    () => core.restore({ ids: [mine.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /only superseded entries can be restored/.test(error.message),
    '在场条目不接受回滚',
  )
  await assert.rejects(
    () => core.restore({ ids: ['00000000-0000-4000-8000-000000000000'] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && error.message.includes('no entry with id'),
  )
  await assert.rejects(
    () => core.restore({ ids: [foreign.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /visible set/.test(error.message),
    '回滚只动会话可见集',
  )
  assert.equal(gateCalls.length, 0, '全部校验都在打扰用户之前完成')
  assert.equal(store.entryById(foreign.entry.id)?.status, 'superseded', '被拒的救济零落盘')
})

// ── 协议层：分面裁决（方向由表定） ────────────────────────────────────────

test('S5 协议·能力类：facet=能力与技能 → 保留观察、降级自陈，方向不可反', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-ability')
  const observed = await core.add({ track: 'user', scope: 'user-global', text: '能独立完成矩阵推导（行为证据）', source: OBSERVATION_SOURCE, facet: '能力与技能' }, write)
  const reported = await core.add({ track: 'user', scope: 'user-global', text: '自评数学只到本科', facet: '能力与技能' }, write)
  gateCalls.length = 0

  const result = await core.arbitrate({ ids: [observed.entry.id, reported.entry.id] }, write)
  assert.equal(result.facet, '能力与技能')
  assert.equal(result.direction, 'observation', '方向由表决定')
  assert.deepEqual(result.kept.map((entry) => entry.id), [observed.entry.id], '能力听观察')
  assert.deepEqual(result.demoted.map((entry) => entry.id), [reported.entry.id], '自陈被降级')
  assert.deepEqual(result.tagged, [], '非 coexist 面不打标')
  assert.equal(store.entryById(observed.entry.id)?.status, 'active')
  assert.equal(store.entryById(reported.entry.id)?.status, 'superseded')

  assert.equal(gateCalls.length, 1, '一次审批整批')
  const payload = /** @type {{action: string, text: string, source: string}} */ (gateCalls[0])
  assert.equal(payload.action, 'arbitrate')
  assert.equal(payload.source, GOVERNANCE_SOURCE)
  assert.ok(/facet: 能力与技能 → arbitrate by observation/.test(payload.text), '载荷写清按面裁决的理由')
  assert.ok(payload.text.includes(`keep: ${observed.entry.id}`), '载荷写清保留谁')
  assert.ok(payload.text.includes(`demote: ${reported.entry.id}`), '载荷写清降级谁')

  const rows = auditRows(store)
  const demoteRows = rows.filter((row) => row.action === 'arbitrate' && row.entry_id === reported.entry.id)
  assert.equal(demoteRows.length, 1)
  assert.equal(demoteRows[0].text, null, '降级审计行 text 恒为 null（只记 id）')
  const summary = rows.filter((row) => row.action === 'arbitrate' && row.entry_id === null)
  assert.equal(summary.length, 1, '收尾一行裁决摘要')
  assert.ok(/** @type {string} */ (summary[0].text).includes(`facet 能力与技能 → observation`))
})

test('S5 协议·意愿类：facet=价值与意愿 → 反向（保留自陈、降级观察）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-value')
  const observed = await core.add({ track: 'user', scope: 'user-global', text: '行为上看他很少早睡', source: OBSERVATION_SOURCE, facet: '价值与意愿' }, write)
  const reported = await core.add({ track: 'user', scope: 'user-global', text: '本人说想早睡、在意作息', facet: '价值与意愿' }, write)

  const result = await core.arbitrate({ ids: [observed.entry.id, reported.entry.id] }, write)
  assert.equal(result.direction, 'self-report', '意愿听自陈')
  assert.deepEqual(result.kept.map((entry) => entry.id), [reported.entry.id])
  assert.deepEqual(result.demoted.map((entry) => entry.id), [observed.entry.id])
  assert.equal(store.entryById(reported.entry.id)?.status, 'active')
  assert.equal(store.entryById(observed.entry.id)?.status, 'superseded')
  assert.equal(
    ARBITRATION_BY_FACET['能力与技能'] !== ARBITRATION_BY_FACET['价值与意愿'],
    true,
    '两类走向逐条相反',
  )
})

test('S5 协议·其余五面：coexist——都不降级，两组各得 gap 标（落差本身是证据）', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-coexist')
  for (const facet of PROFILE_FACETS.filter((name) => ARBITRATION_BY_FACET[/** @type {keyof typeof ARBITRATION_BY_FACET} */ (name)] === 'coexist')) {
    const observed = await core.add({ track: 'user', scope: 'user-global', text: `${facet}：观察到的样子`, source: OBSERVATION_SOURCE, facet }, write)
    const reported = await core.add({ track: 'user', scope: 'user-global', text: `${facet}：本人自述的样子`, facet }, write)
    gateCalls.length = 0
    const result = await core.arbitrate({ ids: [observed.entry.id, reported.entry.id] }, write)
    assert.equal(result.direction, 'coexist', `${facet} 走 coexist`)
    assert.deepEqual(result.demoted, [], `${facet}：一条都不降级`)
    assert.deepEqual(result.kept, [], 'coexist 不选赢家')
    assert.deepEqual(result.tagged.map((entry) => entry.id).sort(), [observed.entry.id, reported.entry.id].sort(), `${facet}：两条都打标`)
    assert.ok(result.tagged.every((entry) => entry.tags.includes(GAP_TAG)), `${facet}：标是 gap`)
    assert.equal(store.entryById(observed.entry.id)?.status, 'active', `${facet}：观察条目仍在场`)
    assert.equal(store.entryById(reported.entry.id)?.status, 'active', `${facet}：自陈条目仍在场`)
    assert.equal(gateCalls.length, 1, `${facet}：一次审批`)
  }
  const rows = auditRows(store)
  assert.equal(rows.filter((row) => row.action === 'arbitrate-tag').length, 10, '五面 × 两来源 = 10 行打标审计')
  assert.equal(rows.filter((row) => row.action === 'arbitrate' && row.entry_id === null).length, 5, '每面一行裁决摘要')
})

test('S5 协议：同组多条一并降级（保留谁由规则定，不给模型挑的机会）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-latest')
  const observed = await core.add({ track: 'user', scope: 'user-global', text: '观察到的能力（只此一条）', source: OBSERVATION_SOURCE, facet: '能力与技能' }, write)
  const older = seed(store, { text: '自陈：能力评估（旧）', facet: '能力与技能' })
  const newer = seed(store, { text: '自陈：能力评估（新）', facet: '能力与技能' })

  const result = await core.arbitrate({ ids: [observed.entry.id, older.id, newer.id] }, write)
  assert.equal(result.direction, 'observation')
  assert.deepEqual(result.kept.map((entry) => entry.id), [observed.entry.id], '保留观察组')
  assert.deepEqual(result.demoted.map((entry) => entry.id).sort(), [older.id, newer.id].sort(), '自陈组两条一并降级')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 2)
})

test('S5 协议：同组多条取 updatedAt 最新者保留（时间线可复核）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-latest-wins')
  const observedA = seed(store, { text: '观察到的能力 A', source: OBSERVATION_SOURCE, facet: '能力与技能' })
  const observedB = seed(store, { text: '观察到的能力 B', source: OBSERVATION_SOURCE, facet: '能力与技能' })
  const reported = seed(store, { text: '自陈：能力评估', facet: '能力与技能' })
  // 时间线由 SQL 直接钉死（updated_at 是 Provider 自写列）：A 更新、B 较旧、自陈最新。
  store.db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(3_000, observedA.id)
  store.db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(1_000, observedB.id)
  store.db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(2_000, reported.id)

  // 入参顺序刻意把最新者放在中间，证明选择靠 updatedAt 而不是顺序
  const result = await core.arbitrate({ ids: [observedB.id, observedA.id, reported.id] }, write)
  assert.deepEqual(result.kept.map((entry) => entry.id), [observedA.id], '观察组里 updatedAt 最新者留下')
  assert.deepEqual(result.demoted.map((entry) => entry.id).sort(), [observedB.id, reported.id].sort(), '同组较旧者与自陈组一并降级')
  assert.equal(store.entryById(observedA.id)?.status, 'active')
  assert.equal(store.entryById(observedB.id)?.status, 'superseded')
  assert.equal(store.entryById(reported.id)?.status, 'superseded')
})

test('S5 协议：facet 不一致 / facet 为空 / 单一来源 / 跨桶 一律响亮拒绝且零落盘', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-gates', '/w')
  const observedAbility = await core.add({ track: 'user', scope: 'user-global', text: '观察到的能力', source: OBSERVATION_SOURCE, facet: '能力与技能' }, write)
  const reportedValue = await core.add({ track: 'user', scope: 'user-global', text: '自陈的意愿', facet: '价值与意愿' }, write)
  const observedNoFacet = await core.add({ track: 'user', scope: 'user-global', text: '观察到的、没打面的条目', source: OBSERVATION_SOURCE }, write)
  const reportedNoFacet = await core.add({ track: 'user', scope: 'user-global', text: '自陈的、没打面的条目' }, write)
  const onlyObserved = await core.add({ track: 'user', scope: 'user-global', text: '另一条观察条目', source: OBSERVATION_SOURCE, facet: '心智' }, write)
  const onlyReported = await core.add({ track: 'user', scope: 'user-global', text: '另一条自陈条目', facet: '心智' }, write)
  const otherTrack = await core.add({ track: 'agent', scope: 'user-global', text: '另一轨的条目', facet: '能力与技能' }, write)
  gateCalls.length = 0

  await assert.rejects(
    () => core.arbitrate({ ids: [observedAbility.entry.id, reportedValue.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /one facet across all targets/.test(error.message),
    '两组面不一致 → 拒绝（不猜）',
  )
  await assert.rejects(
    () => core.arbitrate({ ids: [observedNoFacet.entry.id, reportedNoFacet.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /seven profile facets/.test(error.message),
    'facet 为空 → 拒绝',
  )
  await assert.rejects(
    () => core.arbitrate({ ids: [onlyObserved.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /at least one self-report entry/.test(error.message),
    '只有观察来源 → 无可裁的落差',
  )
  await assert.rejects(
    () => core.arbitrate({ ids: [onlyReported.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /at least one observation entry/.test(error.message),
    '只有自陈来源 → 无可裁的落差',
  )
  await assert.rejects(
    () => core.arbitrate({ ids: [observedAbility.entry.id, otherTrack.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /one bucket/.test(error.message),
    '桶内不跨',
  )
  await assert.rejects(
    () => core.arbitrate({ ids: [observedAbility.entry.id, observedAbility.entry.id] }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT,
    '重复 id 入口就拒',
  )
  for (const bad of [null, undefined, []]) {
    await assert.rejects(
      () => core.arbitrate(bad, write),
      (error) => error.code === ERROR_CODES.INVALID_INPUT,
      `${JSON.stringify(bad)} 一律拒绝`,
    )
  }
  assert.equal(gateCalls.length, 0, '全部校验在打扰用户之前完成')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '零降级')
  assert.equal(store.allEntries().filter((entry) => entry.tags.includes(GAP_TAG)).length, 0, '零打标')
})

test('S5 协议：审批被拒 → 落 arbitrate-denied 审计行且零落盘', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-s5-denied-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const core = new MemoryProtocolCore({ store, budgets: BUDGETS, writePolicy: 'ask', gate: async () => 'rejected', emit: () => {} })
  const observed = seed(store, { text: '观察到的能力', source: OBSERVATION_SOURCE, facet: '能力与技能' })
  const reported = seed(store, { text: '自陈的能力', facet: '能力与技能' })

  await assert.rejects(() => core.arbitrate({ ids: [observed.id, reported.id] }, writeCtx('s-denied')), /not approved/)
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '拒绝 → 零降级')
  const denied = auditRows(store).find((row) => row.action === 'arbitrate-denied')
  assert.ok(denied, '拒绝要留痕（turn 外 gate 路径的唯一证据链）')
})

// ── F5 联动 ──────────────────────────────────────────────────────────────

test('F5×S5：会话关闭时 restore 与 arbitrate 同门拦截——零落盘、先于审批门', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const on = writeCtx('s-on')
  const observed = await core.add({ track: 'user', scope: 'user-global', text: '观察到的能力', source: OBSERVATION_SOURCE, facet: '能力与技能' }, on)
  const reported = await core.add({ track: 'user', scope: 'user-global', text: '自陈的能力', facet: '能力与技能' }, on)
  store.sessionSetEnabled(OFF, false)
  gateCalls.length = 0

  await assert.rejects(
    () => core.arbitrate({ ids: [observed.entry.id, reported.entry.id] }, writeCtx(OFF)),
    (error) => {
      assert.ok(error instanceof SessionMemoryOffError)
      assert.equal(error.code, ERROR_CODES.SESSION_MEMORY_OFF)
      return true
    },
  )
  await assert.rejects(
    () => core.restore({ ids: [observed.entry.id] }, writeCtx(OFF)),
    (error) => error.code === ERROR_CODES.SESSION_MEMORY_OFF,
  )
  assert.equal(gateCalls.length, 0, '拦截在审批门之前——用户根本不会被这两个写打扰')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '零降级')
  assert.equal(store.allEntries().filter((entry) => entry.tags.includes(GAP_TAG)).length, 0, '零打标')
  for (const action of ['arbitrate', 'restore']) {
    const offRow = /** @type {{text: string | null} | undefined} */ (store.db.prepare("SELECT text FROM audit WHERE outcome = 'session-off' AND action = ?").get(action))
    assert.equal(offRow?.text, null, `${action} 被拒时一个字都不留`)
  }
})

// ── 集成挂载：工具面 / 命令面 ────────────────────────────────────────────

/** 集成挂载：临时库 + 审批捕获 + 命令捕获。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-s5-'))
  const mock = createMockCtx()
  /** @type {object[]} */
  const approvals = []
  // 审批走 mock 的事件总线（对齐真 ApprovalService 的 waterfall 派发）：
  // 工具面的默认 gate 与命令面的 makeCommandGate 都要能在这一条链上被裁决。
  mock.ctx.approval = {
    asked: approvals,
    config: { policy: 'ask' },
    overrideOf: () => undefined,
    async request(/** @type {object} */ req) {
      approvals.push(req)
      return mock.ctx.waterfall('approval/request', req, async () => 'allowed-once')
    },
  }
  /** @type {object[]} */
  const commands = []
  mock.ctx.provide('commands', { register(/** @type {object} */ def) { commands.push(def); return () => {} } })
  /** @type {object[]} */
  const routes = []
  mock.ctx.provide('connection', { fetch: { register(/** @type {object} */ route) { routes.push(route); return async () => {} } } })
  apply(mock.ctx, {
    enabled: true,
    dbPath: path.join(dir, 'memory.db'),
    budgets: DEFAULT_BUDGETS,
    // 集成面用 auto：插件自带的审批 answerer 认领记忆写请求并放行（语义同 v2 集成测试）——
    // 命令面走 turn 外 waterfall，没有真 UI answerer 时 ask 会失败封闭。
    writePolicy: opts.writePolicy ?? 'auto',
    writePolicies: {},
    snapshotOrder: -50,
    maxEntriesPerQuery: 20,
    commandListLimit: 50,
    commandAuditLimit: 50,
    language: opts.language ?? 'zh',
    recall: { historyLimitDefault: 8, snippetCap: 5, snippetChars: 300, windowDays: 30 },
    panelEntriesLimit: 200,
    panelAuditLimit: 20,
    auditRetentionDays: 0,
  })
  return { dir, mock, approvals, commands, routes, service: mock.services.get('memory') }
}

function teardown(mounted) {
  mounted.mock.dispose()
  rmSync(mounted.dir, { recursive: true, force: true })
}

function memoryTool(mock) {
  const tool = mock.tools.find((/** @type {{name: string}} */ candidate) => candidate.name === 'memory')
  assert.ok(tool, 'memory 工具已注册')
  return tool
}

const command = (mounted, rawInput, session) => handleMemoryCommand(
  mounted.mock.ctx,
  mounted.service,
  { rawInput, agent: makeAgent(session ?? makeSession()) },
  { observe: { days: 14, sessions: 8, perSession: 12, messageChars: 400, totalChars: 12000 }, language: 'zh' },
)

test('S5 工具面：action=restore 救回降级条目；action=arbitrate 能力类保留观察、降级自陈', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-tool' })
  const write = { agent: makeAgent(session) }
  const observed = await service.add({ track: 'user', scope: 'user-global', text: '行为证据：能独立完成矩阵推导', source: OBSERVATION_SOURCE, facet: '能力与技能' }, write)
  const reported = await service.add({ track: 'user', scope: 'user-global', text: '自评：数学只到本科', facet: '能力与技能' }, write)
  const merged = await service.add({ track: 'user', scope: 'user-global', text: '待降级的重复条目' }, write)
  const tool = memoryTool(mock)
  const exec = makeExec({ agent: makeAgent(session) })

  const arbitrated = await tool.execute({ action: 'arbitrate', ids: [observed.entry.id, reported.entry.id] }, exec)
  assert.equal(arbitrated.ok, true)
  assert.equal(arbitrated.facet, '能力与技能')
  assert.equal(arbitrated.direction, 'observation')
  assert.deepEqual(arbitrated.kept.map((/** @type {{id: string}} */ entry) => entry.id), [observed.entry.id])
  assert.deepEqual(arbitrated.demoted.map((/** @type {{id: string}} */ entry) => entry.id), [reported.entry.id])
  assert.deepEqual(arbitrated.tagged, [])

  const restored = await tool.execute({ action: 'restore', ids: [reported.entry.id] }, exec)
  assert.equal(restored.ok, true)
  assert.deepEqual(restored.restored.map((/** @type {{id: string}} */ entry) => entry.id), [reported.entry.id])
  assert.equal(service.store.entryById(reported.entry.id)?.status, 'active', 'restore 把降级走了回来')

  // 已在场的条目再 restore → 结构化失败（响亮，不静默）
  const refused = await tool.execute({ action: 'restore', ids: [reported.entry.id] }, exec)
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, ERROR_CODES.INVALID_INPUT)

  // coexist 走向（其余五面）：都不降级，两条各打 gap 标
  await service.supersede({ ids: [merged.entry.id], source: 'consolidation' }, write)
  const coexistObserved = await service.add({ track: 'user', scope: 'user-global', text: '心智面：观察到常熬夜', source: OBSERVATION_SOURCE, facet: '心智' }, write)
  const coexistReported = await service.add({ track: 'user', scope: 'user-global', text: '心智面：本人说在意作息', facet: '心智' }, write)
  const coexist = await tool.execute({ action: 'arbitrate', ids: [coexistObserved.entry.id, coexistReported.entry.id] }, exec)
  assert.equal(coexist.ok, true)
  assert.equal(coexist.direction, 'coexist')
  assert.deepEqual(coexist.demoted, [])
  assert.equal(coexist.tagged.length, 2)
  assert.ok(coexist.tagged.every((/** @type {{tags: string[]}} */ entry) => entry.tags.includes(GAP_TAG)))
  assert.equal(service.store.entryById(coexistObserved.entry.id)?.status, 'active', 'coexist 不抹落差')
  assert.equal(service.store.entryById(coexistReported.entry.id)?.status, 'active')

  // 渲染面：render 回调已声明（三条动作各有自己的句子，不落到 default）
  assert.equal(typeof tool.output.render, 'function', 'memory 工具声明了 render 回调')
})

test('S5 命令面：/memory restore 与 /memory arbitrate 两个动词端到端', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service } = mounted
  const session = makeSession({ id: 's-cmd' })
  const write = { agent: makeAgent(session) }
  const observed = await service.add({ track: 'user', scope: 'user-global', text: '行为证据：连续用矩阵推导', source: OBSERVATION_SOURCE, facet: '能力与技能' }, write)
  const reported = await service.add({ track: 'user', scope: 'user-global', text: '自评：数学只到本科', facet: '能力与技能' }, write)

  const arbitrated = await command(mounted, `arbitrate ${observed.entry.id} ${reported.entry.id}`, session)
  assert.equal(arbitrated.kind, 'success')
  assert.ok(arbitrated.text.includes('能力与技能'), '回执写明按哪一面裁决')
  assert.ok(arbitrated.text.includes(observed.entry.id), '回执写明保留了谁')
  assert.equal(service.store.entryById(reported.entry.id)?.status, 'superseded')

  const restored = await command(mounted, `restore ${reported.entry.id}`, session)
  assert.equal(restored.kind, 'success')
  assert.ok(restored.text.includes(reported.entry.id))
  assert.equal(service.store.entryById(reported.entry.id)?.status, 'active', '命令面也能救回')

  const noIds = await command(mounted, 'restore', session)
  assert.equal(noIds.kind, 'error', '缺 id 报用法，不静默')
  assert.ok(noIds.text.includes('/memory restore'))
  const noIdsArbitrate = await command(mounted, 'arbitrate', session)
  assert.equal(noIdsArbitrate.kind, 'error')
  assert.ok(noIdsArbitrate.text.includes('arbitrate'))

  const usage = await command(mounted, '', session)
  assert.equal(usage.kind, 'success')
  assert.ok(usage.text.includes('restore <id...>') && usage.text.includes('arbitrate <id...>'), '帮助文本列出两个新动词')
})

test('S5 命令面：关了记忆的会话拒绝 restore/arbitrate（与 query/tidy 同档）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service } = mounted
  const session = makeSession({ id: OFF })
  const observed = await service.add({ track: 'user', scope: 'user-global', text: '观察条目', source: OBSERVATION_SOURCE, facet: '能力与技能' }, { agent: makeAgent(session) })
  const reported = await service.add({ track: 'user', scope: 'user-global', text: '自陈条目', facet: '能力与技能' }, { agent: makeAgent(session) })
  service.store.sessionSetEnabled(OFF, false)

  const arbitrate = await command(mounted, `arbitrate ${observed.entry.id} ${reported.entry.id}`, session)
  assert.equal(arbitrate.kind, 'error', '关灯的会话不裁决')
  assert.ok(arbitrate.text.includes('已关闭记忆'))
  const restore = await command(mounted, `restore ${reported.entry.id}`, session)
  assert.equal(restore.kind, 'error')
  const list = await command(mounted, 'list', session)
  assert.equal(list.kind, 'success', '管理面只读照常可用')
})

test('S5 schema：memory 工具的 action 枚举与 output schema 都声明了两个新动作', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const tool = memoryTool(mounted.mock)
  assert.equal(tool.parameters.type, 'object')
  const actions = tool.parameters.properties.action.enum
  assert.ok(actions.includes('restore') && actions.includes('arbitrate'), '入参枚举含 restore/arbitrate')
  assert.ok(tool.output.schema.properties.action.enum.includes('restore'), 'output action 枚举含 restore')
  assert.ok(tool.output.schema.properties.action.enum.includes('arbitrate'), 'output action 枚举含 arbitrate')
  for (const key of ['restored', 'kept', 'demoted', 'tagged', 'facet', 'direction']) {
    assert.ok(key in tool.output.schema.properties, `output schema 声明了 ${key}（真机校验器 additionalProperties:false 否则丢掉整份返回）`)
  }
})

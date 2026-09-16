// test/rollback.test.mjs — 整批撤回（F8 批次面）：把一批自动整理整体回滚。
//
// 三条验收线：
// ① 可见集复原——撤回后在场条目 id 集合与整理前逐 id 一致（源条目回 active，产出的合并
//    条目退出可见集但仍在库里：降级留痕，绝不物理删）；
// ② 响亮失败 ＋ 零变更——未知批次 / 已撤回批次 / 形状非法一律结构化拒绝，库与可见集分毫不动；
// ③ 审计可重建 ＋ 批次边界——撤回落审计（能还原撤回了哪一批、恢复哪些 id、降级哪一条），
//    且另一批次的条目状态与可见集不受任何影响。
// 另钉两道复用红线：审批不放行零落盘、会话开关先于审批门拦下；以及命令面 `restore --batch=<id>`。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryProtocolCore } from '../lib/protocol.mjs'
import { openMemoryStore } from '../lib/store.mjs'
import { ERROR_CODES } from '../lib/constants.mjs'
import { apply, handleMemoryCommand, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent } from './helpers/mock-ctx.mjs'
import { agentKeyOf } from '../lib/workspace.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const UNKNOWN_BATCH = '00000000-0000-4000-8000-000000000000'
const OFF = 's-rb-off'

/** 协议级脚手架：真 store ＋ 协议核心（gate 结果可中途翻转，用来造「先放行落一批、再拒绝」）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-rollback-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  /** @type {object[]} */
  const gateCalls = []
  let outcome = 'allowed-once'
  const core = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    gate: async (/** @type {object} */ payload) => { gateCalls.push(payload); return outcome },
    emit: () => {},
  })
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, core, gateCalls, setGate: (/** @type {string} */ next) => { outcome = next }, cleanup }
}

/** 集成挂载（命令面用）：临时库 ＋ 全放行审批（与既有命令面用例同一套形状）。 */
function mount() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-rollback-cmd-'))
  const mock = createMockCtx()
  mock.ctx.approval = { request: async () => 'allowed-once', overrideOf: () => undefined, config: { policy: 'ask' } }
  mock.ctx.provide('commands', { register() { return () => {} } })
  mock.ctx.provide('connection', { fetch: { register() { return async () => {} } } })
  apply(mock.ctx, {
    enabled: true,
    dbPath: path.join(dir, 'memory.db'),
    budgets: DEFAULT_BUDGETS,
    writePolicy: 'auto',
    snapshotOrder: -50,
    maxEntriesPerQuery: 20,
    commandListLimit: 50,
    commandAuditLimit: 10,
    language: 'zh',
    recall: { historyLimitDefault: 8, snippetCap: 5, snippetChars: 300, windowDays: 30 },
    panelEntriesLimit: 200,
    panelAuditLimit: 20,
    auditRetentionDays: 0,
  })
  const teardown = () => { mock.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { mock, service: mock.services.get('memory'), teardown }
}

const writeCtx = (/** @type {string} */ sessionId) => ({ agent: { session: { id: sessionId, header: { cwd: '/w' } } } })
const visibleIds = (/** @type {{listEntries: () => Array<{id: string}>}} */ store) => store.listEntries().map((entry) => entry.id).sort()
const countRows = (/** @type {{db: {prepare: (sql: string) => {get: () => unknown}}}} */ store, /** @type {string} */ table) =>
  Number(/** @type {{n: number}} */ (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n)
const addPair = (/** @type {{insertEntry: (input: object) => {id: string}}} */ store, /** @type {string} */ text) => [
  store.insertEntry({ track: 'user', scope: 'user-global', text }),
  store.insertEntry({ track: 'user', scope: 'user-global', text: `${text}。` }),
]
const codeIs = (/** @type {string} */ code) => (/** @type {{code?: string}} */ error) => { assert.equal(error.code, code); return true }
/** 库况快照（失败路径「零变更」的对照面）。 */
const snapshotOf = (/** @type {{listEntries: () => Array<{id: string}>, db: {prepare: (sql: string) => {get: () => unknown}}}} */ store) =>
  ({ audit: countRows(store, 'audit'), entries: countRows(store, 'entries'), visible: visibleIds(store).join(',') })
/** 指定条目的状态快照（审批窗口复检用例用：库况可能被并发写改动）。 */
const statusesOf = (/** @type {{entryById: (id: string) => {status?: string} | null}} */ store, /** @type {string[]} */ ids) =>
  Object.fromEntries(ids.map((id) => [id, store.entryById(id)?.status ?? null]))

test('整批撤回：可见集与整理前逐 id 一致（源条目回场、产出条目退出但留在库里）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const beforeIds = visibleIds(store)

  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-rb'))
  assert.deepEqual(visibleIds(store), [/** @type {string} */ (entry?.id)], '整理后可见集只剩产出的合并条目')

  const result = await core.restoreBatch({ batchId }, writeCtx('s-rb'))
  assert.deepEqual(visibleIds(store), beforeIds, '撤回后可见集与整理前逐 id 一致')
  assert.equal(store.entryById(a.id)?.status, 'active', '源条目 a 回场')
  assert.equal(store.entryById(b.id)?.status, 'active', '源条目 b 回场')
  assert.equal(store.entryById(/** @type {string} */ (entry?.id))?.status, 'superseded', '产出条目退出可见集（留痕，不物理删）')
  assert.equal(result.restored.length, 2, '恢复 2 条源条目')
  assert.deepEqual(result.demoted.map((item) => item.id), [entry?.id], '降级 1 条本批产出')
})

test('整批撤回：未知批次 / 已撤回批次 / 形状非法一律响亮拒绝，库零变更', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-fail'))

  await assert.rejects(() => core.restoreBatch({ batchId: UNKNOWN_BATCH }, writeCtx('s-fail')), codeIs(ERROR_CODES.INVALID_INPUT), '未知批次响亮拒绝')

  await core.restoreBatch({ batchId }, writeCtx('s-fail'))
  const afterRollback = snapshotOf(store)
  await assert.rejects(() => core.restoreBatch({ batchId }, writeCtx('s-fail')), codeIs(ERROR_CODES.INVALID_INPUT), '已撤回的批次再撤回 → 响亮拒绝')
  for (const bad of ['', null, 123, undefined]) {
    await assert.rejects(() => core.restoreBatch({ batchId: /** @type {never} */ (bad) }, writeCtx('s-fail')), codeIs(ERROR_CODES.INVALID_INPUT), `形状非法（${String(bad)}）响亮拒绝`)
  }
  await assert.rejects(() => core.restoreBatch(null, writeCtx('s-fail')), codeIs(ERROR_CODES.INVALID_INPUT), '非对象入参响亮拒绝')
  assert.deepEqual(snapshotOf(store), afterRollback, '失败路径库与审计分毫不动')
})

test('整批撤回：回执按实际动过的条目计数（不按计划清单）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-receipt'))
  // 手工先把一条源条目救回，于是整批撤回时它不需要再被恢复
  await core.restore({ ids: [a.id], source: 'governance' }, writeCtx('s-manual'))

  const result = await core.restoreBatch({ batchId }, writeCtx('s-receipt2'))
  assert.equal(result.restored.length, 1, '实际只恢复了一条')
  const summary = /** @type {{text?: string}} */ (store.auditByBatch(batchId).find((row) => row.action === 'restore-batch'))
  assert.ok(String(summary.text).includes('restored 1 ('), `回执写实际条数，实际文案：${summary.text}`)
  assert.equal(String(summary.text).includes('restored 2'), false, '不得按计划清单报出没发生的事')
  assert.equal(store.entryById(a.id)?.status, 'active')
  assert.equal(store.entryById(b.id)?.status, 'active')
  assert.equal(store.entryById(/** @type {string} */ (entry?.id))?.status, 'superseded')
})

test('整批撤回：产出条目已被手工降级 → 按状态如实拒绝，不报「假动作」', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-phantom'))

  // 手工把产物降级（账本里没有撤回行，故 rolledBack 仍为 false）：此时若放行，撤回会
  // 成功返回 demoted 1，而那条降级在操作前就已经发生了——回执在说没发生的事。
  await core.restore({ ids: [/** @type {string} */ (entry?.id)] }, writeCtx('s-phantom-manual')).catch(() => {})
  store.supersedeEntries({ ids: [/** @type {string} */ (entry?.id)] })

  gateCalls.length = 0
  await assert.rejects(
    () => core.restoreBatch({ batchId }, writeCtx('s-phantom')),
    (/** @type {any} */ error) => error.code === ERROR_CODES.INVALID_INPUT && /no longer active|already rolled back/u.test(error.message),
    '按状态如实拒绝',
  )
  assert.equal(gateCalls.length, 0, '拒绝发生在审批之前，一次许可也没耗')
  assert.equal(store.entryById(a.id)?.status, 'superseded', '源条目仍在降级态——拒绝即零变更')
})

test('整批撤回：回执里的条目是更新后的快照（状态与库内一致，不说反话）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-receipt-state'))

  const result = await core.restoreBatch({ batchId }, writeCtx('s-receipt-state2'))
  // 回执若拿事务前的快照，被恢复的会报 superseded、被降级的会报 active——与库内正好相反。
  for (const restored of result.restored) {
    assert.equal(restored.status, 'active', `恢复回执 ${restored.id.slice(0, 8)} 应报 active`)
    assert.equal(store.entryById(restored.id)?.status, restored.status, '与库内一致')
  }
  for (const demoted of result.demoted) {
    assert.equal(demoted.status, 'superseded', `降级回执 ${demoted.id.slice(0, 8)} 应报 superseded`)
    assert.equal(store.entryById(demoted.id)?.status, demoted.status, '与库内一致')
  }
  assert.equal(result.demoted[0]?.id, entry?.id, '降级的就是本批产出')
})

test('整批撤回：对已撤回批次再撤 → 不打扰审批门（守卫先于审批）', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-guard'))
  await core.restoreBatch({ batchId }, writeCtx('s-guard'))

  // 守卫排在审批之前：先弹审批再报「已经撤回过了」，既白耗一次许可，载荷方向还是反的
  // （把已恢复的源写成降级、把产物写成恢复）。
  gateCalls.length = 0
  await assert.rejects(() => core.restoreBatch({ batchId }, writeCtx('s-guard')), codeIs(ERROR_CODES.INVALID_INPUT), '已撤回批次再撤 → 响亮拒绝')
  assert.equal(gateCalls.length, 0, '拒绝发生在审批门之前，一次许可也没耗')
})

test('整批撤回：撤回落审计可重建，且不影响其他批次', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const [c, d] = addPair(store, '偏好英文界面')
  const first = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-1'))
  const second = await core.autoTidy({ ids: [c.id, d.id], text: '偏好英文界面' }, writeCtx('s-2'))

  await core.restoreBatch({ batchId: first.batchId }, writeCtx('s-rollback'))

  const rows = store.auditByBatch(first.batchId)
  const summary = rows.filter((row) => row.action === 'restore-batch')
  assert.equal(summary.length, 1, '撤回另落一行摘要')
  assert.ok(String(summary[0].outcome).startsWith('allowed-once'), '摘要记放行结果')
  assert.equal(summary[0].sessionId, 's-rollback')
  assert.ok(String(summary[0].text).includes(first.batchId), '摘要写明撤回了哪一批')
  assert.deepEqual(rows.filter((row) => row.action === 'restore').map((row) => row.entryId).sort(), [a.id, b.id].sort(), '恢复行逐条记 id')
  assert.deepEqual(rows.filter((row) => row.action === 'restore-batch-demote').map((row) => row.entryId), [first.entry?.id], '产出降级行记 id')
  assert.ok(rows.filter((row) => row.action === 'restore-batch-demote').every((row) => row.text === null), '降级行 text 恒为 null')
  assert.equal(core.batchReport(first.batchId)?.rolledBack, true, '批次报告标出已撤回')
  assert.deepEqual(core.batchReport(first.batchId)?.sourceIds, [a.id, b.id], '「本批合了哪些」仍是原始源 id 清单（不含产出条目）')

  // ② 批次边界：另一批自己的条目状态与在场情况零影响（全局可见集当然会变——本批源条目回场了）
  assert.deepEqual(
    visibleIds(store),
    [a.id, b.id, /** @type {string} */ (second.entry?.id)].sort(),
    '本批源条目回场、另一批产出仍在场；两批的降级条目都不在可见集',
  )
  assert.equal(core.batchReport(second.batchId)?.rolledBack, false, '另一批次未被撤回')
  assert.equal(store.entryById(c.id)?.status, 'superseded', '另一批次的源条目仍在降级态')
  assert.equal(store.entryById(d.id)?.status, 'superseded', '另一批次的源条目仍在降级态')
  assert.equal(store.entryById(second.entry?.id ?? '')?.status, 'active', '另一批次的产出条目仍在场')
})

test('整批撤回：审批不放行 → 结构化拒绝、库零写入（只留拒绝留痕）', async (t) => {
  const { store, core, gateCalls, setGate, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-deny'))
  const visibleBefore = visibleIds(store)
  const entriesBefore = countRows(store, 'entries')
  const gateBefore = gateCalls.length
  setGate('rejected')

  await assert.rejects(() => core.restoreBatch({ batchId }, writeCtx('s-deny')), codeIs(ERROR_CODES.WRITE_DENIED), '审批拒绝 → WRITE_DENIED')
  assert.equal(countRows(store, 'entries'), entriesBefore, '零新增条目')
  assert.deepEqual(visibleIds(store), visibleBefore, '可见集不变')
  assert.equal(store.entryById(a.id)?.status, 'superseded', '源条目未被恢复')
  assert.equal(store.entryById(/** @type {string} */ (entry?.id))?.status, 'active', '产出条目仍在场')
  assert.equal(gateCalls.length, gateBefore + 1, '只打扰了一次审批门')
  assert.equal(gateCalls.at(-1)?.action, 'restore-batch', '审批载荷带动作名')
  const denied = store.auditList(50).filter((row) => row.action === 'restore-batch-denied')
  assert.equal(denied.length, 1, '拒绝留一行留痕（不是写入）')
  assert.ok(String(denied[0].text).includes('rollback batch'), '拒绝行记下被拒的审批载荷（用户看到的就是它）')
})

test('整批撤回：会话开关关闭时先于审批门拦下——零落盘', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-off'))
  store.sessionSetEnabled(OFF, false)
  const visibleBefore = visibleIds(store)
  const gateBefore = gateCalls.length

  await assert.rejects(
    () => core.restoreBatch({ batchId }, writeCtx(OFF)),
    (error) => { assert.equal(error.code, ERROR_CODES.SESSION_MEMORY_OFF); return true },
    '会话关了记忆 → SESSION_MEMORY_OFF',
  )
  assert.equal(gateCalls.length, gateBefore, '拦截先于审批门')
  assert.deepEqual(visibleIds(store), visibleBefore, '零落盘：可见集不动')
})

test('整批撤回命令面：/memory restore --batch=<id> 走同一道门；缺批次号报用法', async (t) => {
  const mounted = mount()
  t.after(() => mounted.teardown())
  const { service } = mounted
  const agent = makeAgent(makeSession({ id: 's-cmd' }))
  const a = service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })
  const beforeIds = visibleIds(service.store)
  const { batchId } = await service.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, { agent })
  // 另一批（用于「重复旗标」与「批次边界」两处对照）
  const e = service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好英文界面' })
  const f = service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好英文界面。' })
  const other = await service.autoTidy({ ids: [e.id, f.id], text: '偏好英文界面' }, { agent })
  const beforeIds2 = visibleIds(service.store)

  const mixed = await handleMemoryCommand(mounted.mock.ctx, service, { rawInput: `restore --batch=${batchId} ${a.id}`, agent })
  assert.equal(mixed.kind, 'error', '批次号与位置 id 混用 → 报用法（不静默忽略）')
  assert.deepEqual(visibleIds(service.store), beforeIds2, '报用法时库零变更')

  const dup = await handleMemoryCommand(mounted.mock.ctx, service, { rawInput: `restore --batch=${batchId} --batch=${other.batchId}`, agent })
  assert.equal(dup.kind, 'error', '重复 --batch → 报用法（不静默只撤第一批）')
  assert.deepEqual(visibleIds(service.store), beforeIds2, '重复旗标时两批都未被撤回（零变更）')

  const rolled = await handleMemoryCommand(mounted.mock.ctx, service, { rawInput: `restore --batch=${batchId}`, agent })
  assert.equal(rolled.kind, 'success', `命令成功（实际 ${rolled.kind}: ${rolled.text}）`)
  assert.ok(String(rolled.text).includes(batchId), '回执写明批次号')
  assert.deepEqual(visibleIds(service.store), [...beforeIds, /** @type {string} */ (other.entry?.id)].sort(), '撤回后可见集 = 整理前 ＋ 另一批产物')

  const usage = await handleMemoryCommand(mounted.mock.ctx, service, { rawInput: 'restore --batch', agent })
  assert.equal(usage.kind, 'error', '缺批次号 → 报用法')
  assert.ok(String(usage.text).includes('--batch'), '用法提示提到 --batch')
})

// ── 红队复核（独立 subagent）撬出的五条，逐条钉成回归 ─────────────────────────

test('整批撤回：源条目被后一批重新吃掉 → 响亮拒绝，不做假成功', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const first = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-later'))
  // 模拟真实路径的后态：a 被后一批重新吃掉，supersedeEntries 会把它的批次号覆写成后一批
  // （此处直接落到那一后态，避免与「已降级条目不能再降级」的既有校验打架）。
  store.db.prepare('UPDATE entries SET batch_id = ? WHERE id = ?').run('batch-later', a.id)
  const before = snapshotOf(store)

  await assert.rejects(
    () => core.restoreBatch({ batchId: first.batchId }, writeCtx('s-later')),
    (error) => { assert.equal(error.code, ERROR_CODES.INVALID_INPUT); assert.ok(String(error.message).includes('now belongs to batch')); return true },
    '源条目换了批次号 → 响亮拒绝（不报假成功）',
  )
  assert.deepEqual(snapshotOf(store), before, '零变更')
})

test('整批撤回：审计行被裁剪 → 专用错误说明「不可整批重建」，逐 id 退路仍在', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-prune'))
  store.db.prepare('DELETE FROM audit WHERE batch_id = ?').run(batchId) // 模拟 auditRetentionDays 裁剪
  const before = snapshotOf(store)

  await assert.rejects(
    () => core.restoreBatch({ batchId }, writeCtx('s-prune')),
    (error) => { assert.equal(error.code, ERROR_CODES.INVALID_INPUT); assert.ok(String(error.message).includes('auditRetentionDays')); return true },
    '审计被裁剪 → 专用错误（不是含糊的「查无此批」）',
  )
  assert.deepEqual(snapshotOf(store), before, '零变更')

  const recovered = await core.restore({ ids: [a.id, b.id] }, writeCtx('s-prune'))
  assert.equal(recovered.restored.length, 2, '逐 id 救回仍可用（退路存在）')
})

test('整批撤回：审批窗口内产物被改写 → 响亮拒绝、零落盘（approve-what-you-see）', async (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const made = await new MemoryProtocolCore({ store, budgets: BUDGETS, writePolicy: 'ask', gate: async () => 'allowed-once', emit: () => {} })
    .autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-race'))
  const productId = /** @type {string} */ (made.entry?.id)
  const auditBefore = countRows(store, 'audit')

  // 审批门里做一次改写：模拟审批期间别人 replace 了产物（version 自增、正文变了）
  const racing = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    gate: async () => {
      store.db.prepare('UPDATE entries SET version = version + 1, text = ? WHERE id = ?').run('偏好中文回复（审批期间被改）', productId)
      return 'allowed-once'
    },
    emit: () => {},
  })
  await assert.rejects(
    () => racing.restoreBatch({ batchId: made.batchId }, writeCtx('s-race')),
    (error) => { assert.equal(error.code, ERROR_CODES.INVALID_INPUT); assert.ok(String(error.message).includes('waited for approval')); return true },
    '审批期间被改写 → 响亮拒绝（不静默吞掉编辑）',
  )
  assert.equal(countRows(store, 'audit'), auditBefore, '零审计新增（撤回行一条没落）')
  assert.deepEqual(statusesOf(store, [a.id, b.id, productId]), { [a.id]: 'superseded', [b.id]: 'superseded', [productId]: 'active' }, '两侧状态原样')
})

test('整批撤回：Provider 层逐元素校验 producedIds / sourceIds（垃圾形状零变更）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-shape'))
  const before = snapshotOf(store)
  const good = { batchId, producedIds: [/** @type {string} */ (entry?.id)], sourceIds: [a.id, b.id] }

  for (const [label, patch] of [
    ['重复产物 id', { producedIds: [entry?.id, entry?.id] }],
    ['空串元素', { producedIds: [''] }],
    ['非数组', { producedIds: 'nope' }],
    ['超 20 条源 id', { sourceIds: Array.from({ length: 21 }, (_, i) => `x${i}`) }],
    ['源清单为空', { sourceIds: [] }],
    ['产物与源重叠', { sourceIds: [entry?.id, b.id] }],
  ]) {
    assert.throws(() => store.rollbackBatch({ ...good, ...patch }), codeIs(ERROR_CODES.INVALID_INPUT), `${label} → 结构化拒绝`)
  }
  assert.deepEqual(snapshotOf(store), before, '垃圾形状零变更')
})

test('整批撤回：源条目先被救回、再被后一批吃掉 → 撤回仍响亮拒绝（真实路径，不经 SQL 构造）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const first = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-real'))
  await core.restore({ ids: [a.id] }, writeCtx('s-real')) // a 回到 active，仍顶着第一批的批次号
  const [c] = addPair(store, '偏好中文回复')               // 再补一条同文，凑一批把 a 重新吃掉
  const second = await core.autoTidy({ ids: [a.id, c.id], text: '偏好中文回复' }, writeCtx('s-real'))

  const before = snapshotOf(store)
  await assert.rejects(
    () => core.restoreBatch({ batchId: first.batchId }, writeCtx('s-real')),
    (error) => { assert.equal(error.code, ERROR_CODES.INVALID_INPUT); assert.ok(String(error.message).includes('now belongs to batch')); return true },
    '真实路径：源条目已被后一批吃掉 → 响亮拒绝',
  )
  assert.deepEqual(snapshotOf(store), before, '零变更')

  const later = await core.restoreBatch({ batchId: second.batchId }, writeCtx('s-real'))
  assert.equal(later.restored.length, 2, '后一批本身仍可正常撤回')
})

test('整批撤回：本会话看不见的批次不许由本会话撤回（与逐 id restore 同档）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const ownerKey = agentKeyOf('preset-x')
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复', agentKey: ownerKey })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。', agentKey: ownerKey })
  const owner = { agent: { session: { id: 's-owner', header: { cwd: '/w', agentPreset: 'preset-x' } } } }
  const stranger = { agent: { session: { id: 's-stranger', header: { cwd: '/w' } } } }
  const made = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, owner)
  const productId = /** @type {string} */ (made.entry?.id)

  await assert.rejects(() => core.restoreBatch({ batchId: made.batchId }, stranger), codeIs(ERROR_CODES.INVALID_INPUT), '跨 agent 撤回 → 响亮拒绝')
  await assert.rejects(() => core.restore({ ids: [a.id, b.id] }, stranger), codeIs(ERROR_CODES.INVALID_INPUT), '逐 id restore 在同入参下同样拒绝（两面孔径一致）')
  assert.equal(store.entryById(productId)?.status, 'active', '被拒后产物仍在场')
  const rolled = await core.restoreBatch({ batchId: made.batchId }, owner)
  assert.equal(rolled.restored.length, 2, '本体会话可以正常撤回')
})

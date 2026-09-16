// test/auto-tidy.test.mjs — 自动整理落写面（F8 把握分级的内核出口）。
//
// 本动作的全部价值在一条上：**判定不可由调用方声明**。核心自己按库里的真实条目重跑分级，
// 只有 `auto` 才落写；调用方只能提议「这几个 id ＋ 这段合并文本」。用例沿三条线钉：
// ① 分级守门——非 auto 一律结构化拒绝、零落盘、零审批打扰，且同一批 id 换文本能改变判定；
// ② 复用红线——审批门、会话开关、桶内不跨、id 列表上限，全部在核心内部生效；
// ③ 落写形状——降级留痕、merged 标、继承源桶、审计 text 恒 null、收尾一行 consolidation。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTO_TIDY_SOURCE, MERGED_TAG, MemoryProtocolCore } from '../lib/protocol.mjs'
import { openMemoryStore } from '../lib/store.mjs'
import { ERROR_CODES } from '../lib/constants.mjs'
import { SessionMemoryOffError } from '../lib/errors.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const OFF = 's-auto-off'

/** 真 store ＋ 协议核心（gate 记录调用，用来证明拦截发生在审批之前）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-auto-tidy-'))
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

/** 审计行（按 seq 顺序；列名与 store 的表一致）。 */
const auditRows = (/** @type {{db: {prepare: (sql: string) => {all: () => unknown[]}}}} */ store) =>
  /** @type {Array<{action: string, entry_id: string | null, text: string | null, outcome: string, source: string}>} */ (
    store.db.prepare('SELECT action, entry_id, text, outcome, source FROM audit ORDER BY seq').all()
  )

const isInvalidInput = (/** @type {unknown} */ error) => /** @type {{code?: string}} */ (error)?.code === ERROR_CODES.INVALID_INPUT

test('自动整理：auto 批次落写——降级留痕 ＋ merged 标 ＋ 继承源桶 ＋ 审计形状', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-auto')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复。' }, write)
  const other = await core.add({ track: 'agent', scope: 'user-global', text: '别的桶：测试先于实现' }, write)
  gateCalls.length = 0

  const result = await core.autoTidy({ ids: [a.entry.id, b.entry.id], text: '偏好中文回复' }, write)

  assert.equal(result.grade.verdict, 'auto', '分级判为 auto 才走到落写')
  assert.deepEqual(result.grade.failed, [], '四根硬杠全过')
  assert.equal(result.grade.similarity, 1)
  assert.equal(result.superseded.length, 2)
  assert.equal(result.entry?.status, 'active')
  assert.deepEqual(result.entry?.tags, [MERGED_TAG], '整理产出的条目恒带 merged 标')
  assert.equal(result.entry?.track, 'user', '合并条目继承源桶')
  assert.equal(result.entry?.scope, 'user-global')
  assert.equal(result.entry?.source, AUTO_TIDY_SOURCE, '来源锚死 auto-tidy（粒度键有着力点）')

  assert.equal(store.entryById(a.entry.id)?.status, 'superseded', '降级不删：旧条目仍在库')
  assert.equal(store.entryById(a.entry.id)?.text, '偏好中文回复', '正文原样留痕')
  assert.equal(store.entryById(b.entry.id)?.status, 'superseded')
  assert.equal(store.entryById(other.entry.id)?.status, 'active', '别的桶一条未动')

  assert.equal(gateCalls.length, 1, '一次审批整批')
  const payload = /** @type {{action: string, track: string, scope: string, text: string, source?: string}} */ (gateCalls[0])
  assert.equal(payload.track, 'user')
  assert.equal(payload.source, AUTO_TIDY_SOURCE, '审批载荷带来源：粒度键 source:auto-tidy 在此着力')
  assert.ok(payload.text.includes('偏好中文回复'), 'approve-what-you-see：载荷带被降级条目的原文')

  const rows = auditRows(store)
  const dropRows = rows.filter((row) => row.action === 'supersede')
  assert.equal(dropRows.length, 2)
  for (const row of dropRows) {
    assert.equal(row.text, null, '降级审计只记 id：text 恒为 null')
    assert.equal(row.source, 'dsh-memento', '降级行记的是被降级条目自己的出处，不是动作来源')
  }
  const addRow = rows.find((row) => row.action === 'supersede-add')
  assert.equal(addRow?.text, '偏好中文回复', '新条目照常记正文')
  assert.equal(addRow?.source, AUTO_TIDY_SOURCE, '新条目的出处锚死 auto-tidy')
  assert.equal(rows.filter((row) => row.action === 'consolidation').length, 1, '收尾一行变更摘要')
})

test('自动整理：分级守门是真的在跑——同一批 id，文本不够覆盖即拒，补全才放行', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-gate-grade')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const ids = [a.entry.id, b.entry.id]
  gateCalls.length = 0

  // 覆盖不足（coverage 0.2 < review 线）→ 连 review 都算不上，直接拒
  await assert.rejects(() => core.autoTidy({ ids, text: '偏好' }, write, ), isInvalidInput)
  // 覆盖中间带（coverage 0.6）→ review：字面全同也不自动合
  await assert.rejects(
    () => core.autoTidy({ ids, text: '偏好中文' }, write),
    (error) => isInvalidInput(error) && /grades as review/.test(/** @type {Error} */ (error).message),
  )
  assert.equal(gateCalls.length, 0, '两次拒绝都发生在审批门之前')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '零降级')
  assert.deepEqual(auditRows(store).filter((row) => row.action === 'supersede'), [], '零审计写入')

  // 同一批 id 与文本补齐覆盖 → auto 放行（证明拒绝的原因是分级，而非形状）
  const ok = await core.autoTidy({ ids, text: '偏好中文回复' }, write)
  assert.equal(ok.grade.verdict, 'auto')
  assert.equal(gateCalls.length, 1)
})

test('自动整理：分级不可由调用方声明——字面像但判不了的两条一律拒', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-grade-refuse')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '用户偏好中文回复' }, write)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '用户偏好英文界面' }, write)
  const c = await core.add({ track: 'user', scope: 'user-global', text: '偏好用中文回复' }, write)
  const d = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复。' }, write)
  gateCalls.length = 0

  // 形似实异 → skip
  await assert.rejects(
    () => core.autoTidy({ ids: [a.entry.id, b.entry.id], text: '用户偏好中文回复与英文界面' }, write),
    (error) => isInvalidInput(error) && /grades as skip/.test(/** @type {Error} */ (error).message),
  )
  // 字面部分重合 → review（交给人判，不自动合）
  await assert.rejects(
    () => core.autoTidy({ ids: [c.entry.id, d.entry.id], text: '偏好中文回复' }, write),
    (error) => isInvalidInput(error) && /grades as review/.test(/** @type {Error} */ (error).message),
  )
  assert.equal(gateCalls.length, 0, '拒绝不打扰审批')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0)
})

test('自动整理：跨桶／超条数／形状非法一律结构化拒绝，库与审计零写入', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-shape')
  const userGlobal = await core.add({ track: 'user', scope: 'user-global', text: '用户偏好条目' }, write)
  const agentGlobal = await core.add({ track: 'agent', scope: 'user-global', text: '环境事实条目' }, write)
  const same = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const twin = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  gateCalls.length = 0

  await assert.rejects(
    () => core.autoTidy({ ids: [userGlobal.entry.id, agentGlobal.entry.id], text: '跨轨合并' }, write),
    (error) => isInvalidInput(error) && /one bucket/.test(/** @type {Error} */ (error).message),
  )
  const many = Array.from({ length: 21 }, () => same.entry.id)
  await assert.rejects(() => core.autoTidy({ ids: many, text: '偏好中文回复' }, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy({ ids: [], text: '偏好中文回复' }, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy({ ids: [same.entry.id, same.entry.id], text: '偏好中文回复' }, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy({ ids: 'not-an-array', text: '偏好中文回复' }, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy({ ids: [same.entry.id, twin.entry.id], text: '' }, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy({ ids: [same.entry.id, twin.entry.id] }, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy(null, write), isInvalidInput)
  await assert.rejects(() => core.autoTidy({ ids: ['00000000-0000-4000-8000-000000000000', same.entry.id], text: '偏好中文回复' }, write), isInvalidInput)

  assert.equal(gateCalls.length, 0, '形状与桶校验在打扰用户之前完成')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '零降级')
  assert.deepEqual(auditRows(store).filter((row) => row.action.startsWith('supersede') || row.action.startsWith('auto-tidy')), [], '零审计写入')
})

test('自动整理：一批一事务——中途目标失效则整批回滚，不留半成品', async (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '第一条' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '第二条' })
  // 先把 b 降级，制造「批次走到第二个 id 时目标已非 active」
  store.supersedeEntries({ ids: [b.id] })

  assert.throws(
    () => store.supersedeEntries({ ids: [a.id, b.id], text: '不该落地的合并条目' }),
    (error) => error.code === ERROR_CODES.INVALID_INPUT,
  )
  assert.equal(store.entryById(a.id)?.status, 'active', '整批回滚：第一个目标仍 active')
  assert.equal(store.listEntries().length, 1, '合并条目未落盘')
  assert.equal(store.allEntries().length, 2, '条数不变（降级那条仍在库）')
})

test('自动整理：审批不放行 → 结构化拒绝、零落盘、留一条拒绝审计', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-auto-tidy-denied-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const core = new MemoryProtocolCore({ store, budgets: BUDGETS, writePolicy: 'ask', gate: async () => 'rejected', emit: () => {} })
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })

  await assert.rejects(
    () => core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-denied')),
    (error) => error.code === ERROR_CODES.WRITE_DENIED,
  )
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '拒绝 → 零降级')
  assert.equal(store.listEntries().length, 2)
  const denied = auditRows(store).find((row) => row.action === 'supersede-denied')
  assert.ok(denied, '拒绝要留痕')
  assert.equal(denied.outcome.includes('rejected'), true)
})

test('自动整理：会话开关关闭时在核心内部同门拦下——零落盘、先于审批门', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  store.sessionSetEnabled(OFF, false)
  gateCalls.length = 0

  await assert.rejects(
    () => core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx(OFF)),
    (error) => {
      assert.ok(error instanceof SessionMemoryOffError)
      assert.equal(error.code, ERROR_CODES.SESSION_MEMORY_OFF)
      return true
    },
  )
  assert.equal(gateCalls.length, 0, '拦截在审批门之前')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '零降级')
  const offRow = auditRows(store).find((row) => row.outcome === 'session-off' && row.action === 'auto-tidy')
  assert.ok(offRow, '被拒的自动整理留一行 session-off 审计')
  assert.equal(offRow.text, null, '连被拒的正文也不留')
})

test('自动整理：分级函数与协议核心之间无循环依赖（整理标记已下沉常量表）', () => {
  const protocol = readFileSync(new URL('../lib/protocol.mjs', import.meta.url), 'utf8')
  const consolidate = readFileSync(new URL('../lib/consolidate.mjs', import.meta.url), 'utf8')
  assert.ok(protocol.includes("from './consolidate.mjs'"), 'protocol 取用分级函数')
  assert.equal(consolidate.includes("from './protocol.mjs'"), false, 'consolidate 不得反向 import protocol，否则成环')
  assert.ok(consolidate.includes('MERGED_TAG'), 'consolidate 仍取用整理标记（改为自常量表取用）')
  assert.ok(protocol.includes('export { MERGED_TAG }'), 'protocol 对外仍 re-export 同一绑定（导出面不变）')
})

test('自动整理：桶校验的每个调用点都显式带上动作名（防漏改文案）', () => {
  const source = readFileSync(new URL('../lib/protocol.mjs', import.meta.url), 'utf8')
  const count = (/** @type {RegExp} */ pattern) => [...source.matchAll(pattern)].length
  assert.equal(count(/assertSameBucket\(targets\)/gu), 1, '整理面用缺省动作名 supersede')
  assert.equal(count(/assertSameBucket\(targets, 'auto-tidy'\)/gu), 1, '自动整理带上自己的动作名')
  assert.equal(count(/assertSameBucket\(targets, 'arbitrate'\)/gu), 1, '裁决也带上自己的动作名')
})

test('自动整理：来源由动作自己钉死——调用方传别的 source 不作数（粒度键可信）', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })

  // 调用方试图冒充默认来源：动作应当一律按 AUTO_TIDY_SOURCE 记账
  const result = await core.autoTidy(
    /** @type {any} */ ({ ids: [a.id, b.id], text: '偏好中文回复', source: 'dsh-memento' }),
    writeCtx('s-source'),
  )
  assert.equal(/** @type {{source?: string}} */ (gateCalls[0]).source, AUTO_TIDY_SOURCE, '审批载荷带的是动作自己的来源')
  assert.equal(result.entry?.source, AUTO_TIDY_SOURCE, '新条目的来源不被覆盖')
  const addRow = auditRows(store).find((row) => row.action === 'supersede-add')
  assert.equal(addRow?.source, AUTO_TIDY_SOURCE, '审计也记动作自己的来源')
})

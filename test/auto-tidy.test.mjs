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
  assert.equal(payload.source, AUTO_TIDY_SOURCE, '审批载荷带来源：粒度键 source:tidy-auto 在此着力')
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

test('自动整理：账目与条目同事务——审计写在库层被拒则整批不成，零残留', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })
  const beforeAudit = auditRows(store).length
  // 库层真实阻断审计写（不是打桩）：条目插入成功、账目插入失败，事务必须整体回滚。
  // 若账目还留在事务外，这里会是「条目落库、账本缺行」——红队二轮那条缺陷的形状。
  store.db.exec("CREATE TRIGGER probe_block_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'probe: audit blocked'); END")

  await assert.rejects(() => core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-atomic')))
  store.db.exec('DROP TRIGGER probe_block_audit')

  assert.equal(store.entryById(a.id)?.status, 'active', '账目写失败 → 降级随整批回滚')
  assert.equal(store.entryById(b.id)?.status, 'active', '两条都回到在场状态')
  assert.equal(store.listEntries().length, 2, '不落合并条目')
  assert.equal(auditRows(store).length, beforeAudit, '账本不多不少')
})

test('自动整理：收尾摘要行在批次事务内——批次面凭它重建，不留待补偿的尾巴', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })

  const result = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-summary'))
  const report = core.batchReport(result.batchId)
  // 摘要行（consolidation）与条目、批次号同一个提交：批次一落地就自带可重建的账目，
  // 不存在「落了条目、摘要还没写」的中间态，也就不需要事后补偿那一整套。
  assert.equal(report?.sourceIds.length, 2, '降级行带被降级条目 id')
  assert.equal(report?.producedIds.length, 1, '产出行带产出条目 id')
  assert.equal(report?.entries.length, 3, '批次两侧条目都带批次号')
  assert.equal(auditRows(store).filter((row) => row.action === 'consolidation').length, 1, '摘要行恰好一行')
})

test('自动整理：产出行缺失就没有「账目」可言——批次面不靠猜', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })
  const result = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-ids'))

  // 产出条目的 id 由协议层提前铸出、随事务交给 Provider：账目里它必须与库中那条一致。
  const producedId = /** @type {string} */ (result.entry?.id)
  const addRow = auditRows(store).find((row) => row.action === 'supersede-add')
  assert.equal(addRow?.entry_id, producedId, '产出行记的正是落库那条的 id')
  assert.equal(store.entryById(producedId)?.status, 'active')
  assert.equal(store.entryById(producedId)?.batchId, result.batchId, '产出条目带本批批次号')
})

test('自动整理：整批落成后派发会话事件（与撤回路径同档，不早于提交）', async (t) => {
  const { core, cleanup } = tempCore()
  t.after(cleanup)
  const events = []
  core.emit = (/** @type {unknown} */ _session, /** @type {string} */ type) => { events.push(type) }
  const write = writeCtx('s-events')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复。' }, write)
  events.length = 0

  await core.autoTidy({ ids: [a.entry.id, b.entry.id], text: '偏好中文回复' }, write)
  assert.deepEqual(events.slice().sort(), ['memory/added', 'memory/removed', 'memory/removed'].sort(), '两条降级 + 一条产出都要播报')

  // 被拒的批次不播报（事件只跟成功的落写走）
  events.length = 0
  await assert.rejects(() => core.autoTidy({ ids: [a.entry.id, b.entry.id], text: '偏好中文回复' }, write))
  assert.deepEqual(events, [], '零落盘即零事件')
})

test('自动整理：库层 id 校验——畸形 id 与重复 id 都结构化拒绝，不静默落库', (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  const good = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  for (const bad of ['not-a-uuid', '', 42, null]) {
    assert.throws(
      () => store.insertEntry(/** @type {any} */ ({ track: 'user', scope: 'user-global', text: 'x', id: bad })),
      (/** @type {any} */ error) => error.code === ERROR_CODES.INVALID_INPUT,
      `畸形 id ${JSON.stringify(bad)} 必须结构化拒绝`,
    )
  }
  assert.throws(
    () => store.insertEntry({ track: 'user', scope: 'user-global', text: '撞车', id: good.id }),
    (/** @type {any} */ error) => error.code === ERROR_CODES.INVALID_INPUT && /already exists/u.test(error.message),
    '重复 id 报结构化错误而不是裸 UNIQUE',
  )
  // 大写写法归一成小写：否则同一 UUID 能再占一行（entries.id 是二进制比较的主键）。
  const upper = good.id.toUpperCase()
  assert.throws(
    () => store.insertEntry({ track: 'user', scope: 'user-global', text: '撞车（大写）', id: upper }),
    (/** @type {any} */ error) => error.code === ERROR_CODES.INVALID_INPUT && /already exists/u.test(error.message),
    '同一 UUID 的大写形式不得另占一行',
  )
})

test('自动整理：协议层提前铸出的 id 就是落库那条——账目与条目同事务的前提成真', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })
  /** @type {Array<{id?: string}>} */
  const seen = []
  const real = store.supersedeEntries.bind(store)
  store.supersedeEntries = (/** @type {any} */ input) => {
    seen.push(input)
    return real(input)
  }

  const result = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-mint'))
  store.supersedeEntries = real

  // 这一条钉的是**结构前提**：协议层必须把 id 送到插入口。键名写错（entryId / id）或中途
  // 掉环，落库的就是 Provider 另铸的 UUID，而「摘要行与条目同事务」就退化成空话——
  // 账目虽仍自洽（都取实际条目），结构却不再成立。
  const passedId = seen[0]?.id
  assert.equal(typeof passedId, 'string', '协议层确实把 id 传了下来')
  assert.equal(passedId, result.entry?.id, '传下去的 id 就是落库那条（不是 Provider 另铸的）')
  assert.equal(store.entryById(/** @type {string} */ (passedId))?.status, 'active')
  assert.equal(auditRows(store).find((row) => row.action === 'supersede-add')?.entry_id, result.entry?.id, '产出行记的也是它')
})

test('自动整理：待整理标记的收边也在批次事务内——阻断它即整批不成', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })
  const marker = store.tidyRequestAdd().request
  const before = { entries: store.allEntries().length, audit: auditRows(store).length }

  // 标记是队列里的一条权威状态：它若留在事务外，就会出现「整批成了、标记没结」，
  // 下一轮再消费一次（组级复核第 1 条）。库层阻断标记的 UPDATE，整批必须一起不成。
  store.db.exec("CREATE TRIGGER probe_block_marker BEFORE UPDATE ON tidy_requests BEGIN SELECT RAISE(ABORT, 'probe: marker blocked'); END")
  await assert.rejects(() => core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-marker')))
  store.db.exec('DROP TRIGGER probe_block_marker')

  assert.equal(store.allEntries().length, before.entries, '条目零残留')
  assert.equal(auditRows(store).length, before.audit, '账本零残留')
  assert.equal(store.entryById(a.id)?.status, 'active', '降级随整批回滚')
  assert.equal(store.tidyRequestPending()?.id, marker.id, '标记仍是 pending——没被半途消费')
})

test('自动整理：拒绝行的审计文案记**生效**策略，不是全局那个', async (t) => {
  // 全局 ask、来源键把自动整理封死。审计里必须写 writePolicy off——若拿全局 ask 充数，
  // 账目就分不清「策略 off 拒的」与「ask 无人应答」（红队组级裁决实跑撞出的）。
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-policy-label-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const core = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    writePolicies: { 'source:tidy-auto': 'off' },
    gate: async () => 'rejected',
    emit: () => {},
  })
  const write = writeCtx('s-policy-label')
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })

  await assert.rejects(() => core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, write))
  const denied = auditRows(store).find((row) => String(row.action).endsWith('-denied'))
  assert.ok(denied, '被拒的写要留痕')
  assert.ok(String(denied.outcome).includes('writePolicy off'), `拒绝行记生效策略（实测：${denied.outcome}）`)
  assert.equal(String(denied.outcome).includes('writePolicy ask'), false, '不得拿全局策略充数')
  assert.equal(store.listEntries().length, 2, '拒绝即零落盘')
})

test('自动整理：落写停在一次 store 调用内（事务边界只有一个入口）', () => {
  const source = readFileSync(new URL('../lib/protocol.mjs', import.meta.url), 'utf8')
  // 落写路径不再有「事务外补账 + 补偿」：批次账目随条目一次性交给 Provider。
  assert.equal([...source.matchAll(/this\.store\.supersedeEntries\(/gu)].length, 2, 'supersede 与批次回滚各一处调用')
  assert.equal([...source.matchAll(/#compensate/gu)].length, 0, '补偿机制已删：账与条目同事务后它无用武之地')
  assert.equal([...source.matchAll(/audit: \{/gu)].length, 2, '两处落写都把账目随事务交给 Provider')
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
  // 产出行按正文定位（正文是这条用例的判别式）；entry_id 的精确对应由「协议层提前铸出的
  // id 就是落库那条」一例钉住——id 现在落库前已知，账目里能写死。
  const addRow = auditRows(store).find((row) => row.action === 'supersede-add' && row.text === '偏好中文回复')
  assert.equal(addRow?.source, AUTO_TIDY_SOURCE, '审计也记动作自己的来源')
  assert.equal(
    core.batchReport(result.batchId)?.producedIds.length,
    1,
    '产出条目的 id 由批次面还原（产出行不靠 entry_id 也能追到条目）',
  )
})

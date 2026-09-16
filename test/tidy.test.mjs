// test/tidy.test.mjs — F6 整理机（方案 docs/F6F7施工方案.md §1）＋ F7 可观测三数的接口面。
//
// 这个功能的全部价值在两条线上：**降级不删**（旧条目留痕、可回滚，绝不物理删）与
// **不越界**（桶内不跨、只动会话可见集、审计 text 恒为 null 只记 id）。用例沿这两条线
// 逐层钉：store.supersedeEntries → 协议 supersede（审批门 / 开关 / 桶 / 可见集）→
// memory 工具 action=tidy|supersede → /memory tidy|stats → turn-stopping → 预热段末行。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MERGED_TAG, MemoryProtocolCore } from '../lib/protocol.mjs'
import { openMemoryStore } from '../lib/store.mjs'
import { ERROR_CODES } from '../lib/constants.mjs'
import { workspaceKeyOf } from '../lib/workspace.mjs'
import { apply, handleMemoryCommand, DEFAULT_BUDGETS, SessionMemoryOffError } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent, makeExec } from './helpers/mock-ctx.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const LINE_CHARS = 2000
const OFF = 's-tidy-off'

/** 真 store（临时库）。 */
function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-tidy-store-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, cleanup }
}

/** 真 store + 协议核心（gate 记录调用，用来证明拦截发生在审批之前）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-tidy-core-'))
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

// ── store 层：降级不删 ─────────────────────────────────────────────────────

test('F6 store：supersedeEntries 批量降级 ＋ 落合并条目；在场集缩水但数据仍在库里', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文注释' })
  const other = store.insertEntry({ track: 'agent', scope: 'workspace', text: '项目约定：测试先于实现' })

  const result = store.supersedeEntries({ ids: [a.id, b.id], text: '偏好：中文回复与注释', tags: [MERGED_TAG], source: 'consolidation' })
  assert.equal(result.superseded.length, 2)
  assert.equal(result.entry?.text, '偏好：中文回复与注释')
  assert.equal(result.entry?.status, 'active', '合并条目是新的在场条目')
  assert.deepEqual(result.entry?.tags, [MERGED_TAG])

  assert.deepEqual(store.listEntries().map((entry) => entry.id).sort(), [other.id, /** @type {string} */ (result.entry?.id)].sort(), '在场集只剩合并条目与另一桶那条')
  assert.equal(store.allEntries().length, 4, '四条都还在库里（降级不删）')
  assert.deepEqual(store.allEntries().filter((entry) => entry.status === 'superseded').map((entry) => entry.id).sort(), [a.id, b.id].sort())
  assert.equal(store.entryById(a.id)?.status, 'superseded', '按 id 仍读得到降级条目（留痕可查）')
  assert.equal(store.entryById(a.id)?.text, '偏好中文回复', '正文原样保留')
  assert.equal(store.queryEntries({}).total, 2, '读路径不吐降级条目')
  assert.equal(store.matchCandidates('user', 'user-global', '偏好中文回复').length, 0, '写定位也不命中降级条目')
  assert.equal(store.usage('user', 'user-global'), '偏好：中文回复与注释'.length, '预警线只算在场条目')
})

test('F6 store：未知 id / 重复 id / 已降级目标一律响亮失败，且整批原子回滚', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '第一条' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '第二条' })

  assert.throws(() => store.supersedeEntries({ ids: [] }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.throws(() => store.supersedeEntries({ ids: 'not-an-array' }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.throws(() => store.supersedeEntries({ ids: [123] }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.throws(() => store.supersedeEntries({ ids: [a.id, a.id] }), (error) => error.code === ERROR_CODES.INVALID_INPUT, '重复 id 在入口就拒')
  assert.throws(
    () => store.supersedeEntries({ ids: ['00000000-0000-4000-8000-000000000000'] }),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && error.message.includes('no entry with id'),
    '未知 id 响亮失败',
  )

  // 第二个 id 已降级 → 整批回滚（第一条也不能降级）
  store.supersedeEntries({ ids: [b.id] })
  assert.throws(() => store.supersedeEntries({ ids: [a.id, b.id], text: '不该落地的合并条目' }), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  assert.equal(store.entryById(a.id)?.status, 'active', '回滚：第一条仍 active')
  assert.equal(store.listEntries().length, 1, '回滚：合并条目不落盘')
  assert.equal(store.allEntries().length, 2, '条数不变')
})

test('F6 store：纯降级（无 text）不落新条目；entryById 形状校验', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '只降级，不合并' })
  const result = store.supersedeEntries({ ids: [a.id] })
  assert.equal(result.entry, null, '无 text → 不落新条目')
  assert.equal(result.superseded.length, 1)

  assert.equal(store.entryById('00000000-0000-4000-8000-000000000000'), null, '未知 id 返回 null')
  assert.throws(() => store.entryById(''), (error) => error.code === ERROR_CODES.INVALID_INPUT)
})

test('F6 store：桶内不跨在 Provider 层同样成立（纵深防御，不靠协议层单点）', (t) => {
  const { store, cleanup } = tempStore()
  t.after(cleanup)
  const one = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复', agentKey: 'agent-one' })
  const two = store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。', agentKey: 'agent-two' })
  const before = store.allEntries().length

  assert.throws(
    () => store.supersedeEntries({ ids: [one.id, two.id], text: '偏好中文回复' }),
    (/** @type {any} */ error) => error.code === ERROR_CODES.INVALID_INPUT && /stay inside one bucket/u.test(error.message),
    '直调 Provider 跨 agentKey 合并必须被拒',
  )
  assert.equal(store.allEntries().length, before, '拒绝即零变更')

  // 跨 scope（一条 workspace、一条 user-global）同样拦下
  const global = store.insertEntry({ track: 'user', scope: 'user-global', text: '另一条' })
  const scoped = store.insertEntry({ track: 'user', scope: 'workspace', text: '再一条', workspaceKey: '/w' })
  assert.throws(
    () => store.supersedeEntries({ ids: [scoped.id, global.id], text: '另一条' }),
    (/** @type {any} */ error) => error.code === ERROR_CODES.INVALID_INPUT && /stay inside one bucket/u.test(error.message),
    '跨 scope 合并同样被拒',
  )

  // 同桶仍然放行（防线不是拦路虎）
  const three = store.insertEntry({ track: 'user', scope: 'user-global', text: '同桶甲', agentKey: 'agent-one' })
  const four = store.insertEntry({ track: 'user', scope: 'user-global', text: '同桶甲。', agentKey: 'agent-one' })
  const merged = store.supersedeEntries({ ids: [three.id, four.id], text: '同桶甲' })
  assert.equal(merged.superseded.length, 2, '同桶合并照常')
  assert.equal(merged.entry?.agentKey, 'agent-one', '产出条目继承源桶')
})

// ── 协议层：审批门 / 开关 / 桶边界 / 可见集 ────────────────────────────────

test('F6 协议：supersede 走审批门，载荷带 id 与原文；审计 text 恒为 null 只记 id，收尾留一行 consolidation', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-tidy')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '偏好中文注释' }, write)
  gateCalls.length = 0

  const result = await core.supersede({ ids: [a.entry.id, b.entry.id], text: '偏好：中文回复与注释', source: 'consolidation' }, write)
  assert.equal(result.superseded.length, 2)
  assert.deepEqual(result.entry?.tags, [MERGED_TAG], '整理产出的条目恒带 merged 标')
  assert.equal(result.entry?.source, 'consolidation', 'source 锚死 consolidation（粒度键有着力点）')

  assert.equal(gateCalls.length, 1, '一次审批整批')
  const payload = /** @type {{action: string, track: string, scope: string, text: string}} */ (gateCalls[0])
  assert.equal(payload.action, 'supersede')
  assert.equal(payload.track, 'user', '单桶批次用桶的 track/scope（粒度策略键能命中）')
  assert.ok(payload.text.includes('偏好中文回复'), 'approve-what-you-see：载荷带被降级条目的原文')
  assert.ok(payload.text.includes('merged text: 偏好：中文回复与注释'))

  const rows = /** @type {Array<{action: string, entry_id: string | null, text: string | null}>} */ (store.db.prepare('SELECT action, entry_id, text FROM audit ORDER BY seq').all())
  const supersedeRows = rows.filter((row) => row.action === 'supersede')
  assert.equal(supersedeRows.length, 2)
  for (const row of supersedeRows) {
    assert.equal(row.text, null, '降级审计只记 id：text 恒为 null')
    assert.ok([a.entry.id, b.entry.id].includes(/** @type {string} */ (row.entry_id)))
  }
  const addRow = rows.find((row) => row.action === 'supersede-add')
  assert.equal(addRow?.text, '偏好：中文回复与注释', '新条目照常记正文（它是正常写入）')
  const summary = rows.filter((row) => row.action === 'consolidation')
  assert.equal(summary.length, 1, '收尾一行变更摘要（/memory audit 可查）')
  assert.ok(/** @type {string} */ (summary[0].text).includes('superseded 2'))
})

test('F5×F6：会话关闭时 supersede 与其他写方法同门拦截——零落盘、先于审批门', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const on = writeCtx('s-on')
  const a = await core.add({ track: 'user', scope: 'user-global', text: '先正常写两条' }, on)
  const b = await core.add({ track: 'user', scope: 'user-global', text: '再写第二条' }, on)
  store.sessionSetEnabled(OFF, false)
  gateCalls.length = 0

  await assert.rejects(
    () => core.supersede({ ids: [a.entry.id, b.entry.id], text: '不该发生' }, writeCtx(OFF)),
    (error) => {
      assert.ok(error instanceof SessionMemoryOffError)
      assert.equal(error.code, ERROR_CODES.SESSION_MEMORY_OFF)
      return true
    },
  )
  assert.equal(gateCalls.length, 0, '拦截在审批门之前——用户根本不会被这个写打扰')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '零降级')
  assert.equal(store.listEntries().length, 2, '零落盘')
  const offRow = /** @type {{text: string | null}} */ (store.db.prepare("SELECT text FROM audit WHERE outcome = 'session-off' AND action = 'supersede'").get())
  assert.equal(offRow.text, null, '被拒的降级一个字都不留')
})

test('F6 协议：审批被拒 → 落 supersede-denied 审计行且零落盘', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-tidy-denied-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const core = new MemoryProtocolCore({ store, budgets: BUDGETS, writePolicy: 'ask', gate: async () => 'rejected', emit: () => {} })
  const write = writeCtx('s-denied')
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '第一条' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '第二条' })

  await assert.rejects(() => core.supersede({ ids: [a.id, b.id], text: '不批就不写' }, write), /not approved/)
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, '拒绝 → 零降级')
  assert.equal(store.listEntries().length, 2)
  const denied = /** @type {{action: string}} */ (store.db.prepare("SELECT action FROM audit WHERE action = 'supersede-denied'").get())
  assert.ok(denied, '拒绝要留痕（turn 外 gate 路径的唯一证据链）')
})

test('F6 协议：桶内不跨——跨 track/scope/agent/工作区一律响亮失败，且不动库', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-bucket', '/w')
  const userGlobal = await core.add({ track: 'user', scope: 'user-global', text: '用户偏好条目' }, write)
  const agentGlobal = await core.add({ track: 'agent', scope: 'user-global', text: '环境事实条目' }, write)
  const otherWorkspace = await core.add({ track: 'agent', scope: 'workspace', text: '别的工作区条目' }, writeCtx('s-other', '/other'))
  const mine = await core.add({ track: 'agent', scope: 'workspace', text: '本工作区条目' }, write)

  gateCalls.length = 0
  // 自己工作区 + 别人工作区：先被「会话可见集」拦（跨工作区的条目本会话根本看不见）
  await assert.rejects(
    () => core.supersede({ ids: [mine.entry.id, otherWorkspace.entry.id], text: '跨工作区合并' }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /visible set/.test(error.message),
  )
  // 跨 track：两条都在会话可见集内，仍然不许放一桶（桶内不跨，规格 3.5.8）
  await assert.rejects(
    () => core.supersede({ ids: [userGlobal.entry.id, agentGlobal.entry.id], text: '跨轨合并' }, write),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /one bucket/.test(error.message),
  )
  assert.equal(gateCalls.length, 0, '桶校验在打扰用户之前完成')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 0)
})

test('F6 协议：整理只动会话可见集——跨 agent / 跨工作区的 id 被拒', async (t) => {
  const { core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  // 别的工作区（cwd 不同）写一条；本会话看不到它
  const foreign = await core.add({ track: 'agent', scope: 'workspace', text: '别的工作区的事实' }, writeCtx('s-foreign', '/elsewhere'))
  await core.add({ track: 'agent', scope: 'workspace', text: '本工作区的事实' }, writeCtx('s-mine', '/w'))
  gateCalls.length = 0
  await assert.rejects(
    () => core.supersede({ ids: [foreign.entry.id], text: '看不见的条目不该被本会话整理' }, writeCtx('s-mine', '/w')),
    (error) => error.code === ERROR_CODES.INVALID_INPUT && /visible set/.test(error.message),
  )
  assert.equal(gateCalls.length, 0)
})

test('F6 协议：ids 上限 20、NUL 文本、非对象入参一律拒绝；merged 标恒补进 tags', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx('s-caps')
  const ids = []
  for (let index = 0; index < 21; index += 1) {
    const added = await core.add({ track: 'user', scope: 'user-global', text: `第 ${index} 条候选` }, write)
    ids.push(added.entry.id)
  }
  await assert.rejects(() => core.supersede({ ids }, { ...write }), (error) => error.code === ERROR_CODES.INVALID_INPUT, '超过 20 条要分批')
  await assert.rejects(() => core.supersede({ ids: ids.slice(0, 2), text: '带\u0000的文本' }, write), (error) => error.code === ERROR_CODES.INVALID_INPUT)
  // @ts-expect-error 故意传非对象
  await assert.rejects(() => core.supersede(null, write), (error) => error.code === ERROR_CODES.INVALID_INPUT)

  const result = await core.supersede({ ids: ids.slice(0, 2), text: '合并后的条目', tags: ['observation'] }, write)
  assert.deepEqual(result.entry?.tags, ['observation', MERGED_TAG], 'merged 标恒在（与调用方标签并存）')
  assert.equal(store.allEntries().filter((entry) => entry.status === 'superseded').length, 2)
})

// ── 集成挂载：工具面 / 命令面 / 触发检测 / 预热段 / 路由 ──────────────────

/** 集成挂载：临时库 + 全放行审批 + 命令与路由捕获。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-tidy-'))
  const mock = createMockCtx()
  /** @type {object[]} */
  const approvals = []
  mock.ctx.approval = {
    request: async (/** @type {object} */ req) => { approvals.push(req); return 'allowed-once' },
    overrideOf: () => undefined,
    config: { policy: 'ask' },
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
    writePolicy: opts.writePolicy ?? 'auto',
    writePolicies: opts.writePolicies ?? {},
    snapshotOrder: -50,
    maxEntriesPerQuery: 20,
    commandListLimit: 50,
    commandAuditLimit: 10,
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

/** 预热段文本（systemPrompt.section 的 text 回调产物）。 */
function warmupText(mock, session) {
  const section = mock.sections.find((/** @type {{name: string}} */ candidate) => candidate.name === 'yammory_system:memory')
  assert.ok(section, '预热段已注册')
  return section.text({ agent: makeAgent(session) })
}

const command = (mounted, rawInput, session) => handleMemoryCommand(
  mounted.mock.ctx,
  mounted.service,
  { rawInput, agent: makeAgent(session ?? makeSession()) },
  { observe: { days: 14, sessions: 8, perSession: 12, messageChars: 400, totalChars: 12000 }, language: 'zh' },
)

test('F6 工具面：action=tidy 只读出计划（积压 ＋ 分桶候选 ＋ 相似线索），action=supersede 落写', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-tool' })
  const write = { agent: makeAgent(session) }
  const first = await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, write)
  const second = await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, write)
  await service.add({ track: 'agent', scope: 'workspace', text: '项目约定：测试先于实现' }, write)
  const tool = memoryTool(mock)
  const exec = makeExec({ agent: makeAgent(session) })

  const plan = await tool.execute({ action: 'tidy' }, exec)
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'tidy')
  assert.equal(plan.candidates, 3)
  assert.equal(plan.backlog.count, 3)
  assert.equal(plan.backlog.due, false)
  assert.ok(plan.plan.includes('整理计划'), '计划文本随结果回带')
  assert.ok(plan.plan.includes('user/user-global'), '按桶分组')
  assert.ok(plan.plan.includes('可能同一件事'), '桶内相似线索')
  assert.equal(service.store.allEntries().filter((entry) => entry.status === 'superseded').length, 0, 'tidy 只读，零写入')
  assert.equal(service.store.auditList().filter((row) => row.action === 'tidy-due').length, 0, 'tidy 本身不落审计')

  const merged = await tool.execute({ action: 'supersede', ids: [first.entry.id, second.entry.id], text: '用户偏好：回复中文。' }, exec)
  assert.equal(merged.ok, true)
  assert.deepEqual(merged.superseded.map((entry) => entry.id).sort(), [first.entry.id, second.entry.id].sort())
  assert.deepEqual(merged.entry.tags, [MERGED_TAG])
  assert.equal(service.store.listEntries().length, 2, '在场集：合并条目 ＋ 另一桶那条')
  assert.equal(service.store.allEntries().length, 4, '降级的两条仍在库里')
})

test('F8 工具面：action=auto-tidy 走内核分级落写；非 auto 档一律拒绝、零落盘', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-auto-tool' })
  const write = { agent: makeAgent(session) }
  const first = await service.add({ track: 'user', scope: 'user-global', text: '偏好中文回复' }, write)
  const second = await service.add({ track: 'user', scope: 'user-global', text: '偏好中文回复。' }, write)
  const tool = memoryTool(mock)
  const exec = makeExec({ agent: makeAgent(session) })

  // ① 够确定的一批：工具面落写，回执带批次号、逐杠明细与产出条目
  const written = await tool.execute({ action: 'auto-tidy', ids: [first.entry.id, second.entry.id], text: '偏好中文回复' }, exec)
  assert.equal(written.ok, true, `工具面能落写（实测：${JSON.stringify(written.error ?? null)}）`)
  assert.equal(written.grade.verdict, 'auto')
  assert.equal(typeof written.batchId, 'string')
  assert.deepEqual(written.superseded.map((entry) => entry.id).sort(), [first.entry.id, second.entry.id].sort())
  assert.equal(service.store.listEntries().length, 1, '在场集只剩产出条目')
  assert.deepEqual(service.store.auditByBatch(written.batchId).map((row) => row.action), ['supersede', 'supersede', 'supersede-add', 'consolidation'], '整批账目同事务落地')

  // ② 缺 text：结构化拒绝（分级守门要求「提议的合并文本」）
  const noText = await tool.execute({ action: 'auto-tidy', ids: [/** @type {string} */ (written.entry?.id)] }, exec)
  assert.equal(noText.ok, false)
  assert.equal(noText.error.code, 'INVALID_INPUT')

  // ③ 把握不足的一批：内核重跑硬杠判 review → 拒绝且零落盘
  const third = await service.add({ track: 'agent', scope: 'user-global', text: '环境事实：Node 24 常驻' }, write)
  const fourth = await service.add({ track: 'agent', scope: 'user-global', text: '环境事实：Node 24' }, write)
  const before = service.store.allEntries().length
  const refused = await tool.execute({ action: 'auto-tidy', ids: [third.entry.id, fourth.entry.id], text: '环境事实：Node 24 常驻' }, exec)
  assert.equal(refused.ok, false, '非 auto 档必须拒绝')
  assert.equal(refused.error.code, 'INVALID_INPUT')
  assert.ok(String(refused.error.message).includes('grades as'), `拒绝文案带分级依据（实测：${refused.error.message}）`)
  assert.equal(service.store.allEntries().length, before, '拒绝即零落盘')
})

test('F6 工具面：tidy 计划只含会话可见集（别的工作区 / agent 的条目不在里面）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-visible', cwd: 'C:\\work\\mine' })
  await service.add({ track: 'agent', scope: 'workspace', text: '本工作区条目' }, { agent: makeAgent(session) })
  await service.add({ track: 'agent', scope: 'workspace', text: '别的工作区条目' }, { agent: makeAgent(makeSession({ id: 's-elsewhere', cwd: 'C:\\work\\elsewhere' })) })
  const plan = await memoryTool(mock).execute({ action: 'tidy' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(plan.candidates, 1, '只看到自己工作区那条')
  assert.ok(plan.plan.includes('本工作区条目'))
  assert.equal(plan.plan.includes('别的工作区条目'), false)
})

test('F5×F6 工具面：会话关闭时 tidy 与 supersede 都被拒（结构化 ok:false，零落盘）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: OFF })
  const write = { agent: makeAgent(session) }
  const a = await service.add({ track: 'user', scope: 'user-global', text: '第一条' }, write)
  const b = await service.add({ track: 'user', scope: 'user-global', text: '第二条' }, write)
  service.store.sessionSetEnabled(OFF, false)
  const tool = memoryTool(mock)
  const exec = makeExec({ agent: makeAgent(session) })

  const tidy = await tool.execute({ action: 'tidy' }, exec)
  assert.equal(tidy.ok, false)
  assert.equal(tidy.error.code, ERROR_CODES.SESSION_MEMORY_OFF)
  const supersede = await tool.execute({ action: 'supersede', ids: [a.entry.id, b.entry.id], text: '不该发生' }, exec)
  assert.equal(supersede.ok, false)
  assert.equal(supersede.error.code, ERROR_CODES.SESSION_MEMORY_OFF)
  assert.equal(service.store.listEntries().length, 2, '零降级、零落盘')
})

test('F6 命令面：/memory tidy 打印计划；--days 生效；非法标志报用法；缺 sessionId 仍可用', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service } = mounted
  const session = makeSession({ id: 's-cmd' })
  await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, { agent: makeAgent(session) })

  const ok = await command(mounted, 'tidy', session)
  assert.equal(ok.kind, 'success')
  assert.ok(ok.text.includes('整理计划'), '表头')
  assert.ok(ok.text.includes('积压：'), '积压账目')
  assert.ok(ok.text.includes('候选'), '候选数')

  const days = await command(mounted, 'tidy --days=30', session)
  assert.equal(days.kind, 'success')
  assert.ok(days.text.includes('热度窗口 30 天'))

  const bad = await command(mounted, 'tidy --bogus', session)
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('tidy 用法'))

  // 缺 sessionId：只读命令照常可用（可见集退化为共享层）
  const noSession = await handleMemoryCommand(mounted.mock.ctx, service, { rawInput: 'tidy', agent: null }, undefined)
  assert.equal(noSession.kind, 'success')
  assert.ok(noSession.text.includes('整理计划'))

  // 会话关闭 → 与 query 同档拒绝
  service.store.sessionSetEnabled(OFF, false)
  const off = await command(mounted, 'tidy', makeSession({ id: OFF }))
  assert.equal(off.kind, 'error')
  assert.ok(off.text.includes('session'))
})

test('F7 命令面：/memory stats 打印三数 ＋ 成功率留白；/memory 用法与未知动词都带新动词', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service } = mounted
  const session = makeSession({ id: 's-stats' })
  await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, { agent: makeAgent(session) })
  await service.query({}, { sessionId: 's-stats', session })

  const stats = await command(mounted, 'stats', session)
  assert.equal(stats.kind, 'success')
  assert.ok(stats.text.includes('① 重复率'))
  assert.ok(stats.text.includes('② 召回命中率'))
  assert.ok(stats.text.includes('③ 注入量'))
  assert.ok(stats.text.includes('成功率：需反馈通道，待定义'), '成功率的诚实留白')
  assert.equal(stats.text.includes('成功率：0'), false, '不得拿别的数冒充')

  const empty = await command(mounted, 'stats', makeSession({ id: 's-empty' }))
  assert.ok(empty.text.includes('无样本'), '空库形态：没有样本就说没有样本')

  const usage = await command(mounted, '', session)
  assert.ok(usage.text.includes('tidy'), '用法行带 tidy')
  assert.ok(usage.text.includes('stats'), '用法行带 stats')
  const unknown = await command(mounted, 'nonsense', session)
  assert.equal(unknown.kind, 'error')
  assert.ok(unknown.text.includes('tidy') && unknown.text.includes('stats'))
})

test('F6 触发检测：agent/turn-stopping 只读算积压，过线落一行提示并按间隔节流；关灯不碰', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-turn' })
  const write = { agent: makeAgent(session) }
  const emit = () => mock.ctx.emit('agent/turn-stopping', { agent: makeAgent(session), turn: 1, signal: new AbortController().signal })
  const dueRows = () => service.store.auditList(50).filter((row) => row.action === 'tidy-due')

  emit()
  assert.equal(dueRows().length, 0, '未过线 → 不提示')
  assert.equal(service.store.listEntries().length, 0, '只读检查不写记忆')

  await service.add({ track: 'user', scope: 'user-global', text: 'x'.repeat(LINE_CHARS + 10) }, write)
  emit()
  assert.equal(dueRows().length, 1, '过字符线 → 一行提示')
  assert.equal(dueRows()[0].outcome, 'over-line')
  assert.equal(dueRows()[0].entryId, null)
  assert.ok(String(dueRows()[0].text).includes('chars since the last consolidation'))
  emit()
  assert.equal(dueRows().length, 1, '同一进程内节流，不每轮都刷')

  // 会话关闭 → 连提示也不给
  service.store.sessionSetEnabled(OFF, false)
  mock.ctx.emit('agent/turn-stopping', { agent: makeAgent(makeSession({ id: OFF })), turn: 2, signal: new AbortController().signal })
  assert.equal(dueRows().length, 1, '关掉的会话不碰记忆机制（提示也算）')

  // 只读检查绝不让一轮失败：库关掉后再 emit 也不抛
  service.store.close()
  assert.doesNotThrow(() => emit())
})

test('F6 预热段：过开工线时末行追加整理提示，并随快照落审计；未过线则一字不加', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const quiet = makeSession({ id: 's-quiet' })
  await service.add({ track: 'user', scope: 'user-global', text: '常驻画像：偏好先给结论' }, { agent: makeAgent(quiet) })
  const before = warmupText(mock, quiet)
  assert.equal(before.includes('记忆该整理了'), false, '未过线不提示')

  const noisy = makeSession({ id: 's-noisy' })
  await service.add({ track: 'user', scope: 'user-global', text: 'y'.repeat(LINE_CHARS + 10) }, { agent: makeAgent(noisy) })
  const after = warmupText(mock, noisy)
  assert.ok(after.includes('记忆该整理了'), '过线 → 预热段末行给提示')
  assert.ok(after.includes('/memory tidy'))
  const snapshot = service.store.auditList(20).find((row) => row.action === 'snapshot' && String(row.text).includes('记忆该整理了'))
  assert.ok(snapshot, '提示随冻结文本进 snapshot 审计行（模型可见 ⟺ 落盘）')
})

test('F7 供数：零命中也落 recalled 行（工具路径与协议 query 路径同口径）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-recall' })
  await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, { agent: makeAgent(session) })
  const recall = mock.tools.find((/** @type {{name: string}} */ candidate) => candidate.name === 'memory_recall')
  assert.ok(recall, 'memory_recall 已注册')
  const outcomes = () => service.store.auditList(50).filter((row) => row.action === 'recalled').map((row) => row.outcome)

  await recall.execute({ query: '用户偏好' }, makeExec({ agent: makeAgent(session) }))
  assert.deepEqual(outcomes(), ['ok'], '有命中 → ok')
  await recall.execute({ query: '完全不存在的词元组合' }, makeExec({ agent: makeAgent(session) }))
  assert.deepEqual(outcomes(), ['empty', 'ok'], '零命中 → 补一行 empty（最近在前）')

  const tool = memoryTool(mock)
  await tool.execute({ action: 'query', text: '完全没有的东西' }, makeExec({ agent: makeAgent(session) }))
  assert.deepEqual(outcomes(), ['empty', 'empty', 'ok'], '协议 query 路径同口径')
})

test('F7 数据面：GET /api/memento/stats 返回三数与渲染行（走同一条 connection.fetch 栅栏）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const route = mounted.routes.find((/** @type {{path: string}} */ candidate) => candidate.path === '/api/memento/stats')
  assert.ok(route, '/api/memento/stats 已注册')
  await mounted.service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, { agent: makeAgent(makeSession()) })
  await mounted.service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复一律使用中文' }, { agent: makeAgent(makeSession()) })
  const response = await route.fetch(new Request('http://localhost/api/memento/stats'))
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.stats.successRate, null, '成功率留在数据面上也是 null')
  assert.equal(data.stats.repetition.ratio, 1, '两条逐字相同 → 重复率 100%')
  assert.ok(Array.isArray(data.lines) && data.lines.length >= 4, '渲染行随响应回带')
  assert.equal(data.language, 'zh')
})

test('F6 边界：整理产出的条目带 merged 标，下次计划见到就跳过（收益判据可机械判）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-merged' })
  const write = { agent: makeAgent(session) }
  const a = await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复使用中文' }, write)
  const b = await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复使用中文' }, write)
  await service.add({ track: 'agent', scope: 'workspace', text: '环境事实：Windows 开发' }, write)
  const tool = memoryTool(mock)
  const exec = makeExec({ agent: makeAgent(session) })
  await tool.execute({ action: 'supersede', ids: [a.entry.id, b.entry.id], text: '用户偏好：回复使用中文。' }, exec)

  const plan = await tool.execute({ action: 'tidy' }, exec)
  assert.ok(plan.plan.includes('已整理 1 条'), 'merged 标让下轮直接跳过')
  assert.equal(plan.candidates, 1, '只剩那条没整理过的')
  assert.equal(plan.backlog.count, 0, '整理收尾后积压归零（consolidation 行是时间锚）')
  assert.equal(workspaceKeyOf('C:\\work\\proj').length > 0, true)
})

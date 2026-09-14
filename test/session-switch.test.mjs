// test/session-switch.test.mjs — F5 会话级记忆开关（方案 docs/F5会话开关方案.md）。
//
// 这个功能的全部价值在于「不可绕过」：关掉记忆的会话，写入、召回、观察一律停。
// 因此用例沿着拦截链逐层钉：store 三方法 → 协议层六个写方法（同审批门位置，先于
// gate）→ 预热段 → memory_recall / memory.query → memory_observe 扫描与选区 →
// /memory session 命令 → /api/memento/session 路由。
// 开关状态本身绝不进会话日志（memory/* 事件未注册，append 会让该会话下次加载被拒），
// 审计行只记动作与 outcome、text 恒为 null——这条也有用例钉住。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryStore } from '../lib/store.mjs'
import { MemoryProtocolCore } from '../lib/protocol.mjs'
import { SCHEMA_VERSION, ERROR_CODES } from '../lib/constants.mjs'
import { apply, handleMemoryCommand, SessionMemoryOffError, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent, makeExec } from './helpers/mock-ctx.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const OFF = 's-off'
const ON = 's-on'

/** 合成一条 user/message 事件（观察通道只认真人发言）。 */
function message(text, seq = 0, time = Date.now()) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' } }
}

/**
 * 假 sessionQuery：按过滤条件下推（cwd 精确 / id / created-at 下界），与观察测试同一套形状。
 * @param {Array<{id: string, cwd: string, createdAt: number, events?: unknown[]}>} sessions - 候选会话。
 */
function fakeSessionQuery(sessions) {
  return {
    async filterSessions(/** @type {any[]} */ filters) {
      const cwd = filters.find((filter) => filter.kind === 'cwd')
      const id = filters.find((filter) => filter.kind === 'id')
      const from = filters.find((filter) => filter.kind === 'created-at')?.from ?? 0
      return sessions
        .filter((s) => cwd === undefined || cwd.values.includes(s.cwd))
        .filter((s) => id === undefined || id.values.includes(s.id))
        .filter((s) => s.createdAt >= from)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({ header: { id: s.id, createdAt: s.createdAt } }))
    },
    async readSession(/** @type {string} */ id) {
      const found = sessions.find((s) => s.id === id)
      if (found === undefined) throw new Error(`session ${id} unreadable`)
      return { session: { createdAt: found.createdAt }, events: found.events ?? [] }
    },
    async readTitleSnapshots(/** @type {string[]} */ ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: `title-of-${sessionId}` } } }))
    },
  }
}

// ── store 层：无行即开、关即删行、选区清单 ──────────────────────────────────

test('F5 store：无行即开；关闭后读为关；重开即删行（默认开是唯一缺省语义）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-switch-store-'))
  const dbPath = path.join(dir, 'memory.db')
  const store = openMemoryStore(dbPath)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  assert.equal(store.sessionEnabled(OFF), true, '没有行 = 开')
  assert.deepEqual(store.disabledSessionIds(), [])

  assert.equal(store.sessionSetEnabled(OFF, false), false)
  assert.equal(store.sessionEnabled(OFF), false, '关闭后读为关')
  assert.deepEqual(store.disabledSessionIds(), [OFF])
  const row = store.db.prepare('SELECT enabled FROM session_switch WHERE session_id = ?').get(OFF)
  assert.equal(Number(row.enabled), 0, '只写「关」行（enabled=0）')

  assert.equal(store.sessionSetEnabled(OFF, true), true)
  assert.equal(store.sessionEnabled(OFF), true, '重开后读为开')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM session_switch').get().n, 0, '重开即删行，不留 1 行')
  assert.deepEqual(store.disabledSessionIds(), [])
})

test('F5 store：空/非字符串 sessionId 一律视作默认开（拿不到 id 不把用户静音）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-switch-store-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  for (const bad of [undefined, null, '', 0, {}, [], true]) {
    assert.equal(store.sessionEnabled(bad), true, `${String(bad)} → 开（不抛）`)
    assert.equal(store.sessionSetEnabled(bad, false), true, `${String(bad)} → 不落行、返回缺省值`)
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM session_switch').get().n, 0, '非法 id 一个行都不落')
  assert.deepEqual(store.disabledSessionIds(), [])
})

test('F5 迁移：v5 库升到 v6 建出 session_switch 表，旧数据原样保留', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-switch-migrate-'))
  const dbPath = path.join(dir, 'memory.db')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // 手工造一个 v5 形状的库（v4 列 + v5 的 facet/level/status + profile 表）。
  const v5 = new DatabaseSync(dbPath)
  v5.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, track TEXT NOT NULL, scope TEXT NOT NULL,
      workspace_key TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, source TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_id TEXT,
      agent_key TEXT NOT NULL DEFAULT '', last_recalled INTEGER, recall_count INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
      facet TEXT, level INTEGER, status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL,
      track TEXT, scope TEXT, entry_id TEXT, text TEXT, outcome TEXT, source TEXT, session_id TEXT);
    CREATE INDEX audit_ts ON audit (ts);
    CREATE TABLE proposals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, track TEXT NOT NULL, scope TEXT NOT NULL,
      workspace_key TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
      created_at INTEGER NOT NULL, decided_at INTEGER, agent_key TEXT NOT NULL DEFAULT '', UNIQUE (session_id, kind));
    CREATE TABLE profile (domain TEXT PRIMARY KEY, level INTEGER NOT NULL, tier TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '5');
  `)
  v5.prepare(`INSERT INTO entries (id, track, scope, workspace_key, text, source, created_at, updated_at, session_id)
    VALUES ('e-v5', 'user', 'user-global', '', 'v5 遗留条目', 'dsh-memento', 1, 1, 's-v5')`).run()
  v5.prepare("INSERT INTO profile (domain, level, tier, updated_at) VALUES ('数学', 5, '本科', 1)").run()
  v5.close()

  const store = openMemoryStore(dbPath)
  assert.equal(Number(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value), SCHEMA_VERSION, '迁移后 = 当前 SCHEMA_VERSION')
  assert.equal(SCHEMA_VERSION, 7, 'F5 把 schema 推到 v6；收边（tidy_requests）推到 v7')
  assert.equal(store.listEntries()[0].text, 'v5 遗留条目', '旧条目原样保留')
  assert.equal(store.profileGet('数学')?.tier, '本科', 'profile 表原样保留')
  assert.equal(store.sessionEnabled('s-v5'), true, '新表就绪：无行即开')
  store.sessionSetEnabled('s-v5', false)
  assert.equal(store.sessionEnabled('s-v5'), false, '新表可写可读')
  store.close()
})

// ── 协议层：六个写方法同审批门位置拦截 ──────────────────────────────────────

/** 真 store + 协议核心（gate 只记录是否被调用，用来证明拦截发生在审批之前）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-switch-core-'))
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

const writeCtx = (sessionId) => ({ agent: { session: { id: sessionId, header: { cwd: '/w' } } } })

test('F5 协议：会话关闭时六个写方法全部响亮拒绝，零落盘，且先于审批门', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  store.sessionSetEnabled(OFF, false)
  const write = writeCtx(OFF)

  const attempts = [
    () => core.add({ track: 'user', scope: 'user-global', text: '不该落盘 A' }, write),
    () => core.replace({ track: 'user', scope: 'user-global', match: 'x', text: '不该落盘 B' }, write),
    () => core.remove({ track: 'user', scope: 'user-global', match: 'x' }, write),
    () => core.consolidate({ track: 'user', scope: 'user-global', matches: ['x'], text: '不该落盘 C' }, write),
    () => core.seed([{ track: 'user', scope: 'user-global', text: '不该落盘 D' }], write),
    () => core.setProfile({ domain: '数学', level: 7 }, write),
  ]
  for (const attempt of attempts) {
    await assert.rejects(attempt, (error) => {
      assert.ok(error instanceof SessionMemoryOffError, '拒绝类型是 SessionMemoryOffError')
      assert.equal(error.code, ERROR_CODES.SESSION_MEMORY_OFF)
      assert.equal(error.details.sessionId, OFF)
      return true
    })
  }

  assert.equal(store.listEntries().length, 0, '零落盘')
  assert.equal(store.profileList().length, 0, '画像也没动')
  assert.equal(gateCalls.length, 0, '拦截在审批门之前——用户根本不会被这个写打扰')

  const rows = /** @type {Array<{action: string, outcome: string, text: string | null, session_id: string | null}>} */ (store.db.prepare("SELECT action, outcome, text, session_id FROM audit WHERE outcome = 'session-off' ORDER BY seq").all())
  assert.deepEqual(rows.map((row) => row.action), ['write', 'write', 'remove', 'consolidate', 'seed', 'profile'], '六个写动作各留一行 session-off 审计')
  for (const row of rows) {
    assert.equal(row.text, null, '被拒的正文一个字都不留（text 恒为 null）')
    assert.equal(row.session_id, OFF, '会话归属照记')
  }
})

test('F5 协议：开关开着时写路径逐字不变（审批门照旧、正常落盘）', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const write = writeCtx(ON)
  const { entry } = await core.add({ track: 'user', scope: 'user-global', text: '正常条目' }, write)
  assert.equal(entry.text, '正常条目')
  assert.equal(store.listEntries().length, 1)
  assert.equal(gateCalls.length, 1, '开着时审批门照旧被走到')
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE outcome = 'session-off'").get().n, 0)

  // 关掉同一会话后立刻拒；重新打开后又能写（开关可逆，不是一次性的）
  store.sessionSetEnabled(ON, false)
  await assert.rejects(() => core.add({ track: 'user', scope: 'user-global', text: '关了之后的写' }, write), SessionMemoryOffError)
  assert.equal(store.listEntries().length, 1, '关了之后零新增')
  store.sessionSetEnabled(ON, true)
  await core.add({ track: 'user', scope: 'user-global', text: '重开之后的写' }, write)
  assert.equal(store.listEntries().length, 2)
})

// ── 集成挂载：预热段 / 工具面 / 命令面 / 路由 ────────────────────────────────

/** 集成挂载：临时库 + 全放行审批 + 命令与路由捕获。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-switch-'))
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
  mock.ctx.provide('commands', { register(def) { commands.push(def); return () => {} } })
  /** @type {object[]} */
  const routes = []
  mock.ctx.provide('connection', { fetch: { register(route) { routes.push(route); return async () => {} } } })
  apply(mock.ctx, {
    enabled: true,
    dbPath: path.join(dir, 'memory.db'),
    budgets: DEFAULT_BUDGETS,
    writePolicy: opts.writePolicy ?? 'auto',
    snapshotOrder: -50,
    maxEntriesPerQuery: 20,
    commandListLimit: 50,
    commandAuditLimit: 10,
    language: opts.language ?? 'en',
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

/** 预热段（systemPrompt.section）的 text 回调产物。 */
function warmupText(mock, session) {
  const section = mock.sections.find((/** @type {{name: string}} */ candidate) => candidate.name === 'yammory_system:memory')
  assert.ok(section, '预热段已注册')
  return section.text({ agent: makeAgent(session) })
}

function recallTool(mock) {
  const tool = mock.tools.find((/** @type {{name: string}} */ candidate) => candidate.name === 'memory_recall')
  assert.ok(tool, 'memory_recall 已注册')
  return tool
}

function memoryTool(mock) {
  const tool = mock.tools.find((/** @type {{name: string}} */ candidate) => candidate.name === 'memory')
  assert.ok(tool, 'memory 已注册')
  return tool
}

function observeTool(mock) {
  const tool = mock.tools.find((/** @type {{name: string}} */ candidate) => candidate.name === 'memory_observe')
  assert.ok(tool, 'memory_observe 已注册')
  return tool
}

function sessionRoute(routes) {
  const route = routes.find((/** @type {{path: string}} */ candidate) => candidate.path === '/api/memento/session')
  assert.ok(route, '/api/memento/session 路由已注册')
  return route
}

test('F5 预热段：开关关闭 → 空段且清冻结缓存、不落 snapshot 审计；开启 → 与既有行为逐字一致', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: OFF })
  await service.add({ track: 'user', scope: 'user-global', text: '常驻画像：偏好先给结论' }, { agent: makeAgent(session) })

  const before = warmupText(mock, session)
  assert.notEqual(before, '', '开着时预热段非空')
  assert.equal(before.includes('偏好先给结论'), true)
  const snapshotsBefore = mock.services.get('memory').store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'snapshot').length
  assert.equal(snapshotsBefore, 1, '首次渲染落一行 snapshot 审计')
  assert.equal(warmupText(mock, session), before, '会话内冻结：二次调用逐字一致')

  service.store.sessionSetEnabled(OFF, false)
  assert.equal(warmupText(mock, session), '', '关掉之后立刻返回空段（开关优先于会话内冻结）')
  const after = mock.services.get('memory').store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'snapshot').length
  assert.equal(after, snapshotsBefore, '关掉之后不落新的 snapshot 审计')

  service.store.sessionSetEnabled(OFF, true)
  const reopened = warmupText(mock, session)
  assert.notEqual(reopened, '', '重开后又开始注入')
  assert.equal(reopened.includes('偏好先给结论'), true, '内容与关掉前同一份')
})

test('F5 memory_recall：关了 → ok:false + SESSION_MEMORY_OFF，不检索、不 bumpRecall、不落 recalled', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: OFF })
  const exec = makeExec({ agent: makeAgent(session) })
  await service.add({ track: 'user', scope: 'user-global', text: '可被召回的记忆' }, { agent: makeAgent(session) })

  const before = await recallTool(mock).execute({ query: '可被召回' }, exec)
  assert.equal(before.ok, true)
  assert.equal(before.memory.entries.length, 1, '开着时召回得到条目')
  const recalledRows = () => service.store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'recalled').length
  const bumps = () => /** @type {{recallCount: number}} */ (service.store.listEntries()[0]).recallCount
  assert.equal(recalledRows(), 1, '开着时落一行 recalled 审计')
  assert.equal(bumps(), 1, '开着时命中召回计数')

  service.store.sessionSetEnabled(OFF, false)
  const after = await recallTool(mock).execute({ query: '可被召回' }, exec)
  assert.equal(after.ok, false, '关了之后召回被拒')
  assert.equal(after.error.code, 'SESSION_MEMORY_OFF')
  assert.equal(recalledRows(), 1, '被拒的召回落零行 recalled 审计')
  assert.equal(bumps(), 1, '被拒的召回不 bumpRecall')
})

test('F5 memory.query：关了 → 拒绝；管理面 /memory list 与 query 不受影响', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: OFF })
  const exec = makeExec({ agent: makeAgent(session) })
  const agent = makeAgent(session)
  await service.add({ track: 'user', scope: 'user-global', text: '管理面可见条目' }, { agent })

  const open = await memoryTool(mock).execute({ action: 'query', text: '管理面' }, exec)
  assert.equal(open.ok, true)
  assert.equal(open.total, 1)

  service.store.sessionSetEnabled(OFF, false)
  const closed = await memoryTool(mock).execute({ action: 'query', text: '管理面' }, exec)
  assert.equal(closed.ok, false, '模型面查库被拒（与 memory_recall 同档）')
  assert.equal(closed.error.code, 'SESSION_MEMORY_OFF')

  const listed = await handleMemoryCommand(mock.ctx, service, { rawInput: 'list', agent })
  assert.equal(listed.kind, 'success', '管理面 list 是用户动作，不受开关影响')
  assert.equal(listed.text.includes('管理面可见条目'), true)
  const queried = await handleMemoryCommand(mock.ctx, service, { rawInput: 'query 管理面', agent })
  assert.equal(queried.kind, 'error', '/memory query 属会话内读，同档拒绝')
  assert.equal(queried.text.includes('memory switched off'), true, '拒绝文案说清原因')
  const budgets = await handleMemoryCommand(mock.ctx, service, { rawInput: 'budgets', agent })
  assert.equal(budgets.kind, 'success', 'budgets 只读报表不受影响')
})

test('F5 memory_observe：关了 → scan 拒绝；选区先滤掉关闭的历史会话并计入 skippedOff', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const now = Date.now()
  mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'mine', cwd: 'D:\\proj', createdAt: now - 3600000, events: [message('本项目约定：提交前跑门链', 0, now - 3600000)] },
    { id: 'other', cwd: 'D:\\proj', createdAt: now - 1800000, events: [message('另一个已关闭会话的发言', 0, now - 1800000)] },
  ]))

  const mine = makeSession({ id: 'mine', cwd: 'D:\\proj' })
  const opened = await observeTool(mock).execute({ action: 'scan', days: 7 }, makeExec({ agent: makeAgent(mine) }))
  assert.equal(opened.ok, true)
  assert.equal(opened.scanned.skippedOff, 0, '都没关时跳过数为 0')
  assert.equal(opened.slice.includes('另一个已关闭会话的发言'), true, '开着时两个会话都进选区')

  service.store.sessionSetEnabled('other', false)
  const filtered = await observeTool(mock).execute({ action: 'scan', days: 7 }, makeExec({ agent: makeAgent(mine) }))
  assert.equal(filtered.ok, true, '当前会话开着，扫描照常')
  assert.equal(filtered.slice.includes('另一个已关闭会话的发言'), false, '关闭的会话一个字都不进切片')
  assert.equal(filtered.scanned.skippedOff, 1, '被滤掉的条数进账单')
  assert.equal(filtered.scanned.sessions, 1, '候选会话数只剩开着的那个')

  service.store.sessionSetEnabled('mine', false)
  const refused = await observeTool(mock).execute({ action: 'scan', days: 7 }, makeExec({ agent: makeAgent(mine) }))
  assert.equal(refused.ok, false, '当前会话关了 → 观察也不碰')
  assert.equal(refused.error.code, 'SESSION_MEMORY_OFF')

  const committed = await observeTool(mock).execute({
    action: 'commit',
    entries: [{ face: '人格特质', text: '关了记忆还想写观察', evidence: '无' }],
  }, makeExec({ agent: makeAgent(mine) }))
  assert.equal(committed.ok, false, 'commit 走 seed，被协议层同一开关拦下')
  assert.equal(committed.error.code, 'SESSION_MEMORY_OFF')
  assert.equal(service.store.listEntries().filter((/** @type {{tags: string[]}} */ entry) => entry.tags.includes('observation')).length, 0, '零观察条目落盘')
})

test('F5 memory_observe：scan 返回的 scanned 字段全部在 output schema 里声明（真机校验器 additionalProperties:false 否则丢掉整份返回）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock } = mounted
  const now = Date.now()
  mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'mine', cwd: 'D:\\proj', createdAt: now - 60000, events: [message('我在说话', 0, now - 60000)] },
  ]))
  const tool = observeTool(mock)
  const declared = Object.keys(tool.output.schema.properties.scanned.properties)
  assert.ok(declared.includes('skippedOff'), 'scanned.skippedOff 必须在 output schema 里声明')
  const mine = makeSession({ id: 'mine', cwd: 'D:\\proj' })
  const value = await tool.execute({ action: 'scan', days: 7 }, makeExec({ agent: makeAgent(mine) }))
  for (const key of Object.keys(value.scanned)) {
    assert.ok(declared.includes(key), `scanned.${key} 未在 output schema 里声明，真机会被校验器丢弃`)
  }
})

test('F5 命令：status / off / on 三态输出与审计行，缺 id 或非法参数响亮报错', async (t) => {
  const mounted = mount({ language: 'en' })
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: '0f8c1a2b-3d4e-5f60-7a8b-9c0d1e2f3a4b' })
  const agent = makeAgent(session)

  const status = await handleMemoryCommand(mock.ctx, service, { rawInput: 'session', agent })
  assert.equal(status.kind, 'success')
  assert.equal(status.text.includes('0f8c1a2b-3d4…'), true, '长 id 显示短码')
  assert.equal(status.text.includes('ON'), true, '默认开')

  const off = await handleMemoryCommand(mock.ctx, service, { rawInput: 'session off', agent })
  assert.equal(off.kind, 'success')
  assert.equal(service.store.sessionEnabled(session.id), false, '命令真的关掉了开关')
  assert.equal(off.text.includes('OFF'), true)

  const afterOff = await handleMemoryCommand(mock.ctx, service, { rawInput: 'session status', agent })
  assert.equal(afterOff.text.includes('OFF'), true, 'status 反映当前状态')

  const on = await handleMemoryCommand(mock.ctx, service, { rawInput: 'session on', agent })
  assert.equal(on.kind, 'success')
  assert.equal(service.store.sessionEnabled(session.id), true, '命令真的打开了开关')

  const switches = service.store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'session-switch')
  assert.deepEqual(switches.map((/** @type {{outcome: string}} */ row) => row.outcome), ['on', 'off'], '切换各留一行审计（auditList 倒序：最新在前）')
  for (const row of switches) {
    assert.equal(/** @type {{text: string | null}} */ (row).text, null, '开关审计行 text 恒为 null')
    assert.equal(/** @type {{sessionId: string | null}} */ (row).sessionId, session.id)
  }
  assert.equal(service.store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'session-switch').length, 2, 'status 不落审计')

  const missing = await handleMemoryCommand(mock.ctx, service, { rawInput: 'session off', agent: { session: null } })
  assert.equal(missing.kind, 'error', '拿不到 sessionId 响亮报错')
  const bad = await handleMemoryCommand(mock.ctx, service, { rawInput: 'session maybe', agent })
  assert.equal(bad.kind, 'error', '非法参数响亮报错')
  assert.equal(bad.text.includes('session usage'), true)
  const usage = await handleMemoryCommand(mock.ctx, service, { rawInput: 'nope', agent })
  assert.equal(usage.text.includes('session [on|off]'), true, '帮助文本列出 session 子命令')
})

test('F5 路由：GET 读状态、POST 只切换开关、非法输入 400、多余字段被拒', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service, routes } = mounted
  const route = sessionRoute(routes)
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'], '一条路由按 method 分派（注册表以 path 为键）')
  const sessionId = 's-route'
  const get = (query) => route.fetch(new Request(`http://localhost/api/memento/session${query}`))
  const post = (body) => route.fetch(new Request('http://localhost/api/memento/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  const read = await get(`?sessionId=${sessionId}`)
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), { sessionId, enabled: true, language: 'en' }, '默认开，且带 language 供客户端选文案')

  const off = await post({ sessionId, enabled: false })
  assert.equal(off.status, 200)
  assert.equal((await off.json()).enabled, false)
  assert.equal(service.store.sessionEnabled(sessionId), false, 'POST 真的关了开关')

  const reread = await get(`?sessionId=${sessionId}`)
  assert.equal((await reread.json()).enabled, false, 'GET 与命令面同源')

  const switches = service.store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'session-switch')
  assert.equal(switches.length, 1, '面板切换留一行审计')
  assert.equal(/** @type {{text: string | null}} */ (switches[0]).text, null, '审计行 text 恒为 null')

  assert.equal((await get('')).status, 400, '缺 sessionId → 400')
  assert.equal((await get('?sessionId=')).status, 400, '空 sessionId → 400')
  assert.equal((await get(`?sessionId=${'x'.repeat(201)}`)).status, 400, '超长 sessionId → 400')

  const extra = await post({ sessionId, enabled: true, text: '夹带的记忆内容' })
  assert.equal(extra.status, 400, 'POST 只接受 {sessionId, enabled}，多余字段一律拒')
  const missingField = await post({ sessionId })
  assert.equal(missingField.status, 400, '缺 enabled → 400')
  const badId = await post({ sessionId: '', enabled: true })
  assert.equal(badId.status, 400, '空 sessionId → 400')
  const longId = await post({ sessionId: 'x'.repeat(201), enabled: true })
  assert.equal(longId.status, 400, '超长 sessionId → 400')
  const notJson = await route.fetch(new Request('http://localhost/api/memento/session', { method: 'POST', body: 'not json' }))
  assert.equal(notJson.status, 400, '非 JSON 体 → 400')
  assert.equal(service.store.sessionEnabled(''), true, '被拒的请求不改任何状态')
})

// test/redteam2.test.mjs — 红队第二轮（0914-18 战报）6 条修复的回归测试。
//
// 六条的病灶统一是「静默不一致」：库、审计、会话可见集三处说法对不上。这个文件把每条的
// 可复现路径钉住，防止重开：
//   高 1  supersede 的合并条目继承源桶（写方会话的 preset 收不走共享记忆）
//   高 2  arbitrate 的保留者在审批后复检（不写与库况相反的「kept X」审计）
//   中 1  facet 可写是登记在案的设计边界：改它必须是显式 replace ＋ 审批 ＋ 审计
//   中 2  /api/memento/session 的 enabled 严格布尔（非布尔 400，不落库、不回显）
//   中 3  会话开关路由的 id 存在性校验（DSH 无可校验的会话归属，落退化档）
//   中 4  export → import 往返保住 tags / facet / level；旧文档照常可导入

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openMemoryStore } from '../lib/store.mjs'
import { MemoryProtocolCore } from '../lib/protocol.mjs'
import { OBSERVATION_SOURCE, DEFAULT_SOURCE, EXPORT_SCHEMA } from '../lib/constants.mjs'
import { workspaceKeyOf } from '../lib/workspace.mjs'
import { apply, handleMemoryCommand, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent } from './helpers/mock-ctx.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const CWD = 'C:\\work\\proj'
const WS = workspaceKeyOf(CWD)

/** 不带 preset 的写方会话（多数用例用不到 preset，共享层即它的层）。 */
const SHARED_WRITE = { agent: { session: { id: 's-red2', header: { cwd: CWD } } } }

/**
 * 独立临时库 + 协议核心。
 * @param {{gate?: (payload: object) => Promise<string>}} [opts] - 自定义审批传输（缺省全放行）。
 */
function tempCore(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-redteam2-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  /** @type {object[]} */
  const gateCalls = []
  const core = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    gate: opts.gate ?? (async (/** @type {object} */ payload) => { gateCalls.push(payload); return 'allowed-once' }),
    emit: () => {},
  })
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, core, gateCalls, cleanup }
}

// ── 高 1：合并条目继承源桶 ──────────────────────────────────────────────────

test('红队②高1：带 preset 的会话合并共享条目，产出仍落共享桶（不再静默收进 agent 专属）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '共享条目甲', agentKey: '' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '共享条目乙', agentKey: '' })
  // 写方会话带 preset：可见集允许它看见共享条目（#assertVisible 放行），但落桶必须看源桶。
  const write = { agent: { session: { id: 's-coder', header: { cwd: CWD, agentPreset: 'coder' } } } }

  const result = await core.supersede({ ids: [a.id, b.id], text: '合并后的共享条目' }, write)

  assert.ok(result.entry, '产出合并条目')
  assert.equal(result.entry.agentKey, '', '合并条目留在共享桶（修复前落 coder）')
  assert.equal(result.entry.workspaceKey, '', '工作区键同样继承源桶')
  assert.equal(store.entryById(result.entry.id).agentKey, '', '库里那行也是共享桶')
  assert.deepEqual(
    result.superseded.map((entry) => entry.id).sort(),
    [a.id, b.id].sort(),
    '源条目照旧降级',
  )
  assert.equal(store.entryById(a.id).status, 'superseded')
  // 另一个 agent 的会话仍能看见合并条目（共享层的意义就在这里）
  assert.equal(store.queryEntries({ track: 'user', scope: 'user-global', agentKey: 'reviewer' }).total, 1, '共享层对别的 agent 可见')
})

test('红队②高1：workspace 层的合并条目继承源工作区键（不随写方会话漂移）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'agent', scope: 'workspace', text: '项目约定甲', workspaceKey: WS, agentKey: '' })
  const b = store.insertEntry({ track: 'agent', scope: 'workspace', text: '项目约定乙', workspaceKey: WS, agentKey: '' })
  const write = { agent: { session: { id: 's-coder', header: { cwd: CWD, agentPreset: 'coder' } } } }

  const result = await core.supersede({ ids: [a.id, b.id], text: '合并后的项目约定' }, write)

  assert.equal(result.entry.workspaceKey, WS, '工作区键取自源桶')
  assert.equal(result.entry.agentKey, '', 'agent 键取自源桶')
})

test('红队②高1：显式 input.agentKey / workspaceKey 仍以显式为准（既有覆盖能力不变）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const a = store.insertEntry({ track: 'user', scope: 'user-global', text: '共享条目甲', agentKey: '' })
  const b = store.insertEntry({ track: 'user', scope: 'user-global', text: '共享条目乙', agentKey: '' })

  const result = await core.supersede({ ids: [a.id, b.id], text: '显式落桶', agentKey: 'coder' }, SHARED_WRITE)

  assert.equal(result.entry.agentKey, 'coder', '显式给定即显式生效')
})

// ── 高 2：保留者审批后复检 ──────────────────────────────────────────────────

test('红队②高2：审批窗口里 champion 被降级 → arbitrate 响亮失败、零落盘、无「kept」假审计', async (t) => {
  /** @type {string} */
  let championId = ''
  const { store, core, cleanup } = tempCore({
    gate: async (payload) => {
      // 模拟并发：审批还没返回，观察条目已经被别处降级了。
      if (payload.action === 'arbitrate') store.supersedeEntries({ ids: [championId] })
      return 'allowed-once'
    },
  })
  t.after(cleanup)
  // 能力类按表听观察（ARBITRATION_BY_FACET['能力与技能'] = observation），观察组只有一条 = champion。
  const obs = store.insertEntry({ track: 'user', scope: 'user-global', text: '观察：他写代码还比较吃力', source: OBSERVATION_SOURCE, facet: '能力与技能' })
  const self = store.insertEntry({ track: 'user', scope: 'user-global', text: '自陈：我编程是专家', source: DEFAULT_SOURCE, facet: '能力与技能' })
  championId = obs.id

  await assert.rejects(
    () => core.arbitrate({ ids: [obs.id, self.id] }, SHARED_WRITE),
    (error) => {
      assert.equal(error.code, 'INVALID_INPUT')
      assert.ok(error.message.includes(obs.id), '报错指明是哪一条保留者失效')
      return true
    },
  )

  assert.equal(store.entryById(self.id).status, 'active', '零落盘：本该被降级的自陈条目一条没动')
  assert.equal(store.entryById(obs.id).status, 'superseded', '审批期间的并发降级保持原样（不被本次动作改写）')
  assert.equal(store.auditList().filter((row) => row.action === 'arbitrate').length, 0, '没有「kept X」假审计')
})

test('红队②高2：审批期间无人动手时，arbitrate 照常成功（复检不是拦路虎）', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const obs = store.insertEntry({ track: 'user', scope: 'user-global', text: '观察：他最近能独立写小工具', source: OBSERVATION_SOURCE, facet: '能力与技能' })
  const self = store.insertEntry({ track: 'user', scope: 'user-global', text: '自陈：我编程一般', source: DEFAULT_SOURCE, facet: '能力与技能' })

  const result = await core.arbitrate({ ids: [obs.id, self.id] }, SHARED_WRITE)

  assert.equal(result.direction, 'observation')
  assert.deepEqual(result.kept.map((entry) => entry.id), [obs.id])
  assert.deepEqual(result.demoted.map((entry) => entry.id), [self.id])
  assert.equal(store.entryById(obs.id).status, 'active')
  assert.equal(gateCalls.length, 1, '一次审批')
  const arbitrateRows = store.auditList().filter((row) => row.action === 'arbitrate')
  assert.equal(arbitrateRows.length, 2, '降级行 + 收尾裁决摘要行')
  assert.ok(
    arbitrateRows.some((row) => typeof row.text === 'string' && row.text.includes(`kept ${obs.id}`)),
    '收尾摘要写清保留谁',
  )
})

// ── 中 1：facet 是显式可写字段（设计边界，不是静默越权） ────────────────────
//
// 方向表管的是**裁决动作**的不变量；facet 仍是普通可写字段。于是「把能力类改成意愿类
// 再裁决」这条路是通的——它必须经过一次显式 replace ＋ 一次审批 ＋ 一条审计。这条用例
// 把这个事实钉住（登记在 ARCHITECTURE.md 与 docs/记忆机制v2规格.md），而不是背书它。

test('红队②中1：facet 改写是显式路径——replace 落审计后，裁决方向按新面走', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const obs = store.insertEntry({ track: 'user', scope: 'user-global', text: '观察：他背代码背得很快', source: OBSERVATION_SOURCE, facet: '能力与技能' })
  const self = store.insertEntry({ track: 'user', scope: 'user-global', text: '自陈：我并不想走算法岗', source: DEFAULT_SOURCE, facet: '能力与技能' })

  // 第一步：显式把两条的面都改成「价值与意愿」（裁决要求两组同面，故两条各一次 replace）。
  // 每一步都是写路径：一次审批、一条审计、版本自增——这就是「显式路径」的全部含义。
  await core.replace({ track: 'user', scope: 'user-global', match: '他背代码背得很快', text: '观察：他背代码背得很快', facet: '价值与意愿' }, SHARED_WRITE)
  await core.replace({ track: 'user', scope: 'user-global', match: '我并不想走算法岗', text: '自陈：我并不想走算法岗', facet: '价值与意愿' }, SHARED_WRITE)
  assert.equal(store.entryById(obs.id).facet, '价值与意愿', '面已改写')
  assert.equal(gateCalls.filter((payload) => payload.action === 'replace').length, 2, '每次改写各经一次审批')
  assert.equal(store.auditList().filter((row) => row.action === 'replace').length, 2, '每次改写各留一条审计')

  // 第二步：此时按「价值与意愿」裁决 —— 表说听自陈，方向与改面前的「能力与技能」相反。
  const result = await core.arbitrate({ ids: [obs.id, self.id] }, SHARED_WRITE)
  assert.equal(result.direction, 'self-report', '方向由当前 facet 决定（显式路径，非静默越权）')
  assert.deepEqual(result.kept.map((entry) => entry.id), [self.id], '改面后听的是自陈组')
})

// ── 中 2 / 中 3：面板会话开关路由 ───────────────────────────────────────────

/**
 * 假 sessionQuery：只实现 id 过滤（存在性校验用），并把收到的 filters 记下来。
 * @param {string[]} known - 已知会话 id。
 */
function fakeSessionQuery(known) {
  /** @type {object[][]} */
  const seen = []
  return {
    seen,
    async filterSessions(/** @type {object[]} */ filters) {
      seen.push(filters)
      const id = filters.find((/** @type {{kind: string}} */ filter) => filter.kind === 'id')
      const values = /** @type {{values: string[]}} */ (id).values
      return known.filter((sessionId) => values.includes(sessionId)).map((sessionId) => ({ header: { id: sessionId, createdAt: 1 } }))
    },
  }
}

/** 集成挂载：临时库 + 全放行审批 + 路由捕获（sessionQuery 由用例决定是否装配）。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-redteam2-web-'))
  const mock = createMockCtx()
  mock.ctx.approval = { request: async () => 'allowed-once', overrideOf: () => undefined, config: { policy: 'ask' } }
  /** @type {object[]} */
  const routes = []
  mock.ctx.provide('commands', { register() { return () => {} } })
  mock.ctx.provide('connection', { fetch: { register(route) { routes.push(route); return async () => {} } } })
  if (opts.sessionQuery !== undefined) mock.ctx.provide('sessionQuery', opts.sessionQuery)
  apply(mock.ctx, {
    enabled: true,
    dbPath: path.join(dir, 'memory.db'),
    budgets: DEFAULT_BUDGETS,
    writePolicy: 'auto',
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
  return { dir, mock, routes, service: mock.services.get('memory') }
}

function teardown(mounted) {
  mounted.mock.dispose()
  rmSync(mounted.dir, { recursive: true, force: true })
}

/** /api/memento/session 路由（注册表以 path 为键）。 */
function sessionRoute(routes) {
  const route = routes.find((/** @type {{path: string}} */ candidate) => candidate.path === '/api/memento/session')
  assert.ok(route, '会话开关路由已注册')
  return route
}

const postSwitch = (route, body) => route.fetch(new Request('http://localhost/api/memento/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

const switchRows = (service) => service.store.auditList().filter((/** @type {{action: string}} */ row) => row.action === 'session-switch')

test('红队②中2：enabled 非布尔一律 400，不落库、不回显；布尔照常', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const route = sessionRoute(mounted.routes)
  const sessionId = 's-strict'

  for (const bad of ['true', 'false', 0, 1, null, {}, [], 0.5]) {
    const response = await postSwitch(route, { sessionId, enabled: bad })
    assert.equal(response.status, 400, `enabled=${JSON.stringify(bad)} 应 400（修复前被静默当成 false）`)
    assert.ok((await response.json()).error.includes('boolean'), '报错指明要布尔')
  }
  assert.equal(mounted.service.store.sessionEnabled(sessionId), true, '被拒的请求一个字段都没落库')
  assert.equal(switchRows(mounted.service).length, 0, '被拒的请求不落审计')

  const off = await postSwitch(route, { sessionId, enabled: false })
  assert.equal(off.status, 200)
  assert.deepEqual(await off.json(), { sessionId, enabled: false, language: 'zh' })
  assert.equal(mounted.service.store.sessionEnabled(sessionId), false, '真布尔照常生效')

  const on = await postSwitch(route, { sessionId, enabled: true })
  assert.equal(on.status, 200)
  assert.equal((await on.json()).enabled, true)
})

test('红队②中3（退化档）：sessionId 必须指向真实会话——查不到 400、零落库，审计来源写实为 panel', async (t) => {
  const sessionQuery = fakeSessionQuery(['s-known'])
  const mounted = mount({ sessionQuery })
  t.after(() => teardown(mounted))
  const route = sessionRoute(mounted.routes)

  const ghost = await postSwitch(route, { sessionId: 's-ghost', enabled: false })
  assert.equal(ghost.status, 400, '凭空造的 id 一律拒（挡掉「造 id 关灯」）')
  assert.ok((await ghost.json()).error.includes('unknown session'))
  assert.equal(mounted.service.store.sessionEnabled('s-ghost'), true, '被拒的 id 没有落库')
  assert.equal(switchRows(mounted.service).length, 0, '被拒的请求不落审计')
  assert.deepEqual(sessionQuery.seen[0], [{ kind: 'id', values: ['s-ghost'] }], '存在性校验查的就是 session-query 的 id 过滤')

  const known = await postSwitch(route, { sessionId: 's-known', enabled: false })
  assert.equal(known.status, 200, '真实会话照常可切换')
  assert.equal(mounted.service.store.sessionEnabled('s-known'), false)
  const rows = switchRows(mounted.service)
  assert.equal(rows.length, 1)
  assert.equal(/** @type {{source: string}} */ (rows[0]).source, 'panel', '审计来源写实为 panel（与命令面区分）')
  assert.equal(/** @type {{text: string | null}} */ (rows[0]).text, null, '开关审计行 text 恒为 null')
})

test('红队②中3（失败要大声）：存在性查询故障 → 500，不静默放行、零落库', async (t) => {
  const mounted = mount({ sessionQuery: { async filterSessions() { throw new Error('corpus unreadable') } } })
  t.after(() => teardown(mounted))
  const route = sessionRoute(mounted.routes)

  const response = await postSwitch(route, { sessionId: 's-known', enabled: false })

  assert.equal(response.status, 500, '查不动就响亮失败（不假装校验过，也不默认放行）')
  assert.ok((await response.json()).error.includes('corpus unreadable'), '错误里带原始病因')
  assert.equal(mounted.service.store.sessionEnabled('s-known'), true, '故障路径零落库')
  assert.equal(switchRows(mounted.service).length, 0, '故障路径零审计')
})

test('红队②中3（登记边界）：sessionQuery 未装配时如实放行——这是「无从校验」，不是「校验通过」', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const route = sessionRoute(mounted.routes)

  const response = await postSwitch(route, { sessionId: 's-any', enabled: false })

  assert.equal(response.status, 200, '不硬造机制：无从校验时面板保持可用（ARCHITECTURE.md 已登记这一档）')
  assert.equal(mounted.service.store.sessionEnabled('s-any'), false)
  assert.equal(/** @type {{source: string}} */ (switchRows(mounted.service)[0]).source, 'panel')
})

// ── 中 4：export / import 保真 ──────────────────────────────────────────────

test('红队②中4：export → import 往返保住 tags/facet/level；旧文档（缺字段）照常可导入', async (t) => {
  const source = mount()
  t.after(() => teardown(source))
  const session = makeSession({ id: 's-exp2', cwd: CWD })
  await source.service.add(
    { track: 'user', scope: 'user-global', text: '带坐标的条目', tags: ['计算机与编程', 'questionnaire'], facet: '能力与技能', level: 7 },
    { agent: makeAgent(session) },
  )
  await source.service.add({ track: 'user', scope: 'user-global', text: '没坐标的条目' }, { agent: makeAgent(session) })

  const exported = await handleMemoryCommand(source.mock.ctx, source.service, { agent: makeAgent(session), rawInput: 'export' })
  assert.equal(exported.kind, 'success')
  const payload = JSON.parse(exported.text)
  const withCoords = payload.entries.find((/** @type {{text: string}} */ entry) => entry.text === '带坐标的条目')
  assert.equal(withCoords.facet, '能力与技能', '导出投影带 facet')
  assert.equal(withCoords.level, 7, '导出投影带 level')
  assert.deepEqual(withCoords.tags, ['计算机与编程', 'questionnaire'], '导出投影带 tags')
  const withoutCoords = payload.entries.find((/** @type {{text: string}} */ entry) => entry.text === '没坐标的条目')
  assert.equal(withoutCoords.facet, null, '无坐标条目导出为 null（不是缺字段）')
  assert.equal(withoutCoords.level, null)

  const target = mount()
  t.after(() => teardown(target))
  const file = path.join(target.dir, 'memory-export.json')
  writeFileSync(file, exported.text, 'utf8')
  const viaFile = await handleMemoryCommand(target.mock.ctx, target.service, {
    agent: makeAgent(makeSession({ id: 's-imp2', cwd: CWD })),
    rawInput: `import ${file}`,
  })
  assert.equal(viaFile.kind, 'success')
  const roundTripped = target.service.query({ track: 'user', scope: 'user-global' }).entries.find((/** @type {{text: string}} */ entry) => entry.text === '带坐标的条目')
  assert.ok(roundTripped)
  assert.equal(roundTripped.facet, '能力与技能', '往返后 facet 相等')
  assert.equal(roundTripped.level, 7, '往返后 level 相等')
  assert.deepEqual(roundTripped.tags, ['计算机与编程', 'questionnaire'], '往返后 tags 相等')
  const bare = target.service.query({ track: 'user', scope: 'user-global' }).entries.find((/** @type {{text: string}} */ entry) => entry.text === '没坐标的条目')
  assert.equal(bare.facet, null, '无坐标条目往返后仍无坐标')
  assert.equal(bare.level, null)

  // 旧导出文档（三个字段都不存在）照常可导入：字段缺省 = 无标签 / 无坐标。
  const legacy = JSON.stringify({
    plugin: 'dsh-memento',
    schema: EXPORT_SCHEMA,
    entries: [{ track: 'user', scope: 'user-global', text: '旧文档条目' }],
  })
  const legacyResult = await handleMemoryCommand(target.mock.ctx, target.service, {
    agent: makeAgent(makeSession({ id: 's-imp3', cwd: CWD })),
    rawInput: `import ${legacy}`,
  })
  assert.equal(legacyResult.kind, 'success', '旧文档照常可导入')
  const legacyEntry = target.service.query({ track: 'user', scope: 'user-global' }).entries.find((/** @type {{text: string}} */ entry) => entry.text === '旧文档条目')
  assert.deepEqual(legacyEntry.tags, [], '缺 tags = 空标签')
  assert.equal(legacyEntry.facet, null)
  assert.equal(legacyEntry.level, null)
})

test('红队②中4：导入载荷里的非法 tags/facet/level 响亮拒绝，整批零落盘', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const invocation = { agent: makeAgent(makeSession({ id: 's-bad', cwd: CWD })) }
  const doc = (/** @type {object} */ entry) => JSON.stringify({
    plugin: 'dsh-memento',
    schema: EXPORT_SCHEMA,
    entries: [{ track: 'user', scope: 'user-global', text: '合法条目' }, entry],
  })

  const cases = [
    { track: 'user', scope: 'user-global', text: '坏 facet', facet: '不存在的面' },
    { track: 'user', scope: 'user-global', text: '坏 level', level: 0 },
    { track: 'user', scope: 'user-global', text: '坏 level 小数', level: 3.5 },
    { track: 'user', scope: 'user-global', text: '坏 tags', tags: 'not-an-array' },
    { track: 'user', scope: 'user-global', text: '坏 tags 元素', tags: ['ok', 123] },
  ]
  for (const entry of cases) {
    const result = await handleMemoryCommand(mounted.mock.ctx, mounted.service, { ...invocation, rawInput: `import ${doc(entry)}` })
    assert.equal(result.kind, 'error', `${entry.text} 应响亮失败`)
    assert.ok(result.text.includes('INVALID_INPUT'), `报错带结构化 code：${result.text}`)
  }
  assert.equal(mounted.service.query({}).total, 0, '所有失败路径零落盘（同批的合法条目也不写）')
})

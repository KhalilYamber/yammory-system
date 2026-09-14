// test/tidy-request.test.mjs — 收边（面板两处 ＋ 门牌）的 §1/§2：可观测三数的面板数据面
// 与「整理全库」排队式按钮。方案 docs/收边方案.md。
//
// 这个功能的价值全在「界线」上，用例沿界线逐层钉：
// store 三方法（登记幂等 / 清除转 done / 行留痕）→ schema v6→v7 迁移 →
// 协议层登记（过审批门、会话开关同档、拒绝落 denied 审计、表里零行）→
// supersede 跑完清标记（cleared 审计 + 无标记时不落）→ 预热段末行提示（en/zh、空块也带）→
// 路由（GET/POST、严格 body、经 connection.fetch 注册）→ 面板按钮面（fake DOM：三数行照抄
// 响应 lines、点击 POST 登记并就地回显）。
//
// 界线本身也有用例：标记表里永远不出现条目正文（text 恒为 null），面板点一下不调模型、
// 不动任何条目——整理仍由模型在会话内显式跑（审计红线）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryStore } from '../lib/store.mjs'
import { SCHEMA_VERSION } from '../lib/constants.mjs'
import { apply, SessionMemoryOffError, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent } from './helpers/mock-ctx.mjs'
import { mountClient } from './client-harness.mjs'

/** 临时库目录 + 记忆库路径（单个 after 钩子里先关库再删目录：Windows 上开着文件删不掉）。 */
function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-tidy-request-'))
  return { dir, dbPath: path.join(dir, 'memory.db') }
}

/** 打开临时库并在用例结束时关闭 + 清目录。 */
function openTempStore(t) {
  const { dir, dbPath } = tempStore()
  const store = openMemoryStore(dbPath)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}

// ── store 层：登记幂等、清除转 done、无标记为 null ───────────────────────────

test('收边 store：无标记为 null；登记幂等（不堆行）；清除转 done 且行留痕', (t) => {
  const store = openTempStore(t)

  assert.equal(store.tidyRequestPending(), null, '新库没有待整理标记')
  assert.deepEqual(store.tidyRequestList(), [])

  const first = store.tidyRequestAdd()
  assert.equal(first.created, true, '首次登记 created=true')
  assert.equal(first.request.status, 'pending')
  assert.equal(typeof first.request.id, 'string')
  assert.equal(Number.isInteger(first.request.createdAt), true)

  const again = store.tidyRequestAdd()
  assert.equal(again.created, false, '重复登记不新建')
  assert.equal(again.request.id, first.request.id, '返回同一条标记')
  assert.equal(store.tidyRequestList().length, 1, '表里只有一行（幂等）')

  const pending = store.tidyRequestPending()
  assert.deepEqual(pending, first.request, 'pending 读回同一条')

  const cleared = store.tidyRequestClear()
  assert.equal(cleared.status, 'done')
  assert.equal(cleared.id, first.request.id)
  assert.equal(store.tidyRequestPending(), null, '清除后没有 pending')
  assert.equal(store.tidyRequestList().length, 1, '清除只改状态，行留痕（不物理删）')
  assert.equal(store.tidyRequestClear(), null, '无 pending 时清除返回 null')
})

test('收边迁移：v6 库升到 v7 建出 tidy_requests 表，旧数据原样保留', (t) => {
  const { dir, dbPath } = tempStore()
  // 手工造一个 v6 形状的库（v5 列 + profile + session_switch）。
  const v6 = new DatabaseSync(dbPath)
  v6.exec(`
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
    CREATE TABLE session_switch (session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO entries (id, track, scope, workspace_key, text, source, created_at, updated_at)
      VALUES ('e-1', 'user', 'user-global', '', '旧库里的条目', 'dsh-memento', 1, 1);
    INSERT INTO meta (key, value) VALUES ('schema_version', '6');
  `)
  v6.close()

  const store = openMemoryStore(dbPath)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal(SCHEMA_VERSION, 7, '本版本 schema 为 v7')
  const version = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value
  assert.equal(String(version), '7', '迁移后回填 v7')
  assert.equal(store.listEntries().length, 1, '旧条目原样保留')
  assert.equal(store.tidyRequestPending(), null, '新表就位且为空')
  assert.equal(store.tidyRequestAdd().created, true, 'v6 升上来的库可以直接登记')
})

// ── 集成挂载：预热段 / 协议面 / 路由 ─────────────────────────────────────────

/** 集成挂载：临时库 + 全放行审批 + 路由捕获（与 session-switch 测试同一套形状）。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-tidy-request-'))
  const mock = createMockCtx()
  /** @type {object[]} */
  const approvals = []
  mock.ctx.approval = {
    request: async (/** @type {object} */ req) => { approvals.push(req); return opts.approvalOutcome ?? 'allowed-once' },
    overrideOf: () => undefined,
    config: { policy: 'ask' },
  }
  mock.ctx.provide('commands', { register() { return () => {} } })
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
  return { dir, mock, approvals, routes, service: mock.services.get('memory') }
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

/** 某动作的审计行（auditList 倒序：最新在前）。 */
function auditRows(service, action) {
  return service.store.auditList(200).filter((/** @type {{action: string}} */ row) => row.action === action)
}

// ── 协议层：登记过审批门、会话开关同档、拒绝不落标记 ─────────────────────────

test('收边协议：requestTidy 登记一条 pending ＋ 一行 registered 审计（text 恒为 null）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service, approvals } = mounted
  const session = makeSession({ id: 's-tidy' })
  const agent = makeAgent(session)

  const result = await service.requestTidy({ source: 'panel' }, { agent })
  assert.equal(result.created, true)
  assert.equal(result.request.status, 'pending')
  assert.equal(service.store.tidyRequestPending().id, result.request.id)
  assert.equal(approvals.length, 1, '登记走审批门（不是静默写）')
  assert.equal(approvals[0].reason.startsWith('[yammory_system] tidy-request library/all [source:panel]'), true, '审批载荷说明这是全库动作')
  assert.equal(approvals[0].toolName, 'memory')

  const rows = auditRows(service, 'tidy-request')
  assert.equal(rows.length, 1)
  assert.equal(String(rows[0].outcome).startsWith('registered'), true, `outcome 记 registered（实际 ${rows[0].outcome}）`)
  assert.equal(rows[0].text, null, '标记审计不记正文（没有正文可记）')
  assert.equal(rows[0].source, 'panel')
  assert.equal(rows[0].sessionId, session.id)

  const again = await service.requestTidy({ source: 'panel' }, { agent })
  assert.equal(again.created, false, '重复登记不新建')
  assert.equal(service.store.tidyRequestList().length, 1, '表里仍只有一行')
  assert.equal(String(auditRows(service, 'tidy-request')[0].outcome).startsWith('already-pending'), true, '第二次登记如实记 already-pending')
})

test('收边协议：审批不放行 → 结构化拒绝、表里零行、落 tidy-request-denied 审计', async (t) => {
  const mounted = mount({ approvalOutcome: 'rejected' })
  t.after(() => teardown(mounted))
  const { service } = mounted
  const agent = makeAgent(makeSession({ id: 's-tidy' }))

  await assert.rejects(() => service.requestTidy({ source: 'panel' }, { agent }), (error) => {
    assert.equal(error.code, 'WRITE_DENIED')
    return true
  })
  assert.equal(service.store.tidyRequestPending(), null, '被拒时不落标记')
  assert.equal(service.store.tidyRequestList().length, 0, '表里一行都没有')
  const denied = auditRows(service, 'tidy-request-denied')
  assert.equal(denied.length, 1, '拒绝留痕（审批门的唯一证据链）')
  assert.equal(denied[0].entryId, null)
})

test('收边协议：会话关了记忆 → 与写路径同档拒绝（SESSION_MEMORY_OFF），零标记零审计载荷', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service } = mounted
  const session = makeSession({ id: 's-off' })
  service.store.sessionSetEnabled(session.id, false)

  await assert.rejects(() => service.requestTidy({ source: 'panel' }, { agent: makeAgent(session) }), (error) => {
    assert.equal(error instanceof SessionMemoryOffError, true)
    assert.equal(error.code, 'SESSION_MEMORY_OFF')
    return true
  })
  assert.equal(service.store.tidyRequestPending(), null)
  const rows = auditRows(service, 'tidy-request')
  assert.equal(rows.length, 1, '只落拒绝那一行')
  assert.equal(rows[0].outcome, 'session-off')
  assert.equal(rows[0].text, null, '关掉的会话连正文都不留')
})

test('收边协议：模型跑完 tidy（supersede）清掉标记 ＋ 落一行 cleared 审计；无标记时不落', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service } = mounted
  const session = makeSession({ id: 's-tidy' })
  const agent = makeAgent(session)
  const a = await service.add({ track: 'user', scope: 'user-global', text: '偏好先给结论' }, { agent })
  const b = await service.add({ track: 'user', scope: 'user-global', text: '喜欢先看结论再展开' }, { agent })

  await service.requestTidy({ source: 'panel' }, { agent })
  assert.notEqual(service.store.tidyRequestPending(), null, '登记后有待整理标记')

  const tidy = await service.supersede({ ids: [a.entry.id, b.entry.id], text: '偏好先给结论' }, { agent })
  assert.equal(tidy.tidyRequestCleared, true, '本次整理结掉了用户点过的那条标记')
  assert.equal(service.store.tidyRequestPending(), null, '标记不再 pending')
  assert.equal(service.store.tidyRequestList()[0].status, 'done', '标记行留痕为 done')
  const cleared = auditRows(service, 'tidy-request').filter((/** @type {{outcome: string}} */ row) => String(row.outcome).startsWith('cleared'))
  assert.equal(cleared.length, 1, '清标记留一行审计')
  assert.equal(cleared[0].text, null)

  const again = await service.supersede({ ids: [tidy.entry.id], text: '偏好先给结论（合并）' }, { agent })
  assert.equal(again.tidyRequestCleared, false, '没有待整理标记时不落 cleared 行')
  assert.equal(auditRows(service, 'tidy-request').filter((/** @type {{outcome: string}} */ row) => String(row.outcome).startsWith('cleared')).length, 1)
})

// ── 预热段：末行提示（只提示，绝不自动跑） ──────────────────────────────────

test('收边预热段：有待整理标记 → 末行提示模型跑全库 tidy；清掉后下一会话不再出现', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const session = makeSession({ id: 's-warm' })
  const agent = makeAgent(session)
  await service.add({ track: 'user', scope: 'user-global', text: '常驻画像：偏好先给结论' }, { agent })

  const before = warmupText(mock, session)
  assert.equal(before.includes('whole-library tidy'), false, '没有标记时不提示')

  await service.requestTidy({ source: 'panel' }, { agent })
  const after = warmupText(mock, makeSession({ id: 's-next' }))
  assert.equal(after.includes('The user asked for a whole-library tidy from the panel.'), true, '新会话预热段带上排队提示')
  assert.equal(after.trimEnd().endsWith('the entry-merge judgement is yours.'), true, '提示落在末行（与一行目录同处）')
  assert.equal(after.includes('常驻画像：偏好先给结论'), true, '既有内容一字不动')

  service.store.tidyRequestClear()
  const cleared = warmupText(mock, makeSession({ id: 's-third' }))
  assert.equal(cleared.includes('whole-library tidy'), false, '清掉标记后提示消失')
})

test('收边预热段：中文文案；标记存在时空块也照常带提示并落 snapshot 审计', async (t) => {
  const mounted = mount({ language: 'zh' })
  t.after(() => teardown(mounted))
  const { mock, service } = mounted
  const agent = makeAgent(makeSession({ id: 's-warm' }))
  await service.requestTidy({ source: 'panel' }, { agent })

  // 库里没有条目与画像：预热段本来会是空串，但用户点过的动作必须被模型看见。
  const session = makeSession({ id: 's-empty' })
  const text = warmupText(mock, session)
  assert.equal(text, '用户点过全库整理，请跑一次 memory tidy（全库）：先看计划（`memory action=tidy` 或 `/memory tidy`），再用 `memory action=supersede` 把讲同一件事的合并。这是排队式请求，不会自动执行——哪几条讲同一件事由您判断。', '空块也带提示，且文案为中文')
  const snapshots = auditRows(service, 'snapshot')
  assert.equal(snapshots.length, 1, '提示进了注入文本 → 照常落 snapshot 审计（模型可见 ⟺ 落盘）')
  assert.equal(snapshots[0].text, text, '审计行与该会话拿到的文本逐字一致')
})

// ── 路由：GET/POST，严格 body，经 connection.fetch 注册 ─────────────────────

test('收边路由：GET 读标记、POST 登记、多余字段与坏 body 一律 400', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service, routes } = mounted
  const route = routes.find((/** @type {{path: string}} */ candidate) => candidate.path === '/api/memento/tidy-request')
  assert.ok(route, '路由已注册（且经 connection.fetch 注册表——mock 只提供这一个注册面）')
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'])
  const get = () => route.fetch(new Request('http://localhost/api/memento/tidy-request'))
  const post = (body) => route.fetch(new Request('http://localhost/api/memento/tidy-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))

  const empty = await get()
  assert.equal(empty.status, 200)
  assert.deepEqual(await empty.json(), { pending: null, language: 'en' }, '没有标记时 pending 为 null，并带 language')

  const created = await post('{}')
  assert.equal(created.status, 200)
  const createdBody = await created.json()
  assert.equal(createdBody.created, true)
  assert.equal(createdBody.pending.status, 'pending')
  assert.equal(createdBody.language, 'en')

  const again = await (await post('{}')).json()
  assert.equal(again.created, false, '再点一次不堆行')
  assert.equal(service.store.tidyRequestList().length, 1)

  assert.equal((await post('{"unexpected":1}')).status, 400, '按钮不带参数：多余字段被拒')
  assert.equal((await post('not json')).status, 400, '坏 body 响亮报错')
  assert.equal((await post('[]')).status, 400, '数组不是合法 body')

  const pending = await (await get()).json()
  assert.equal(pending.pending.id, createdBody.pending.id, 'GET 反射登记结果')
})

test('收边路由：审批不放行时 POST 失败（不留标记、不留假成功），GET 仍可读', async (t) => {
  const mounted = mount({ writePolicy: 'off' })
  t.after(() => teardown(mounted))
  const { service, routes } = mounted
  const route = routes.find((/** @type {{path: string}} */ candidate) => candidate.path === '/api/memento/tidy-request')
  const response = await route.fetch(new Request('http://localhost/api/memento/tidy-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  assert.equal(response.status, 500, '被拒就是被拒，不假装成功')
  const body = await response.json()
  assert.equal(typeof body.error, 'string')
  assert.equal(service.store.tidyRequestPending(), null)
})

test('收边路由：面板来源没有会话 → 审计行 sessionId 为 null（不编造归属）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const { service, routes } = mounted
  const route = routes.find((/** @type {{path: string}} */ candidate) => candidate.path === '/api/memento/tidy-request')
  await route.fetch(new Request('http://localhost/api/memento/tidy-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  const rows = auditRows(service, 'tidy-request')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, null, '面板动作不属于任何会话')
  assert.equal(rows[0].source, 'panel')
  assert.equal(rows[0].text, null)
})

// ── 面板按钮面（测试桩）：三数行 ＋ 点击登记并就地回显 ───────────────────────
//
// 客户端半侧已迁到 React ＋ 官方控件库（docs/前端优化方案.md），仓库不带 React
// （它是宿主浏览器平台的种子模块），因此这里用 test/client-harness.mjs 的迷你
// React／渲染器／官方控件占位件把它跑起来：断言口径从「innerHTML 里找字符串」
// 改成「在渲染出来的元素树上找节点」，界线本身（只读、只登记、不调模型）不变。

/** 在假 DOM 子树里按 class 找第一个节点。 */
function findByClass(/** @type {any} */ node, /** @type {string} */ className) {
  for (const child of node.children ?? []) {
    if (typeof child.className === 'string' && child.className.split(' ').includes(className)) return child
    const nested = findByClass(child, className)
    if (nested !== null) return nested
  }
  return null
}

test('收边面板：三数行照抄 stats 响应的 lines；「整理全库」按钮 POST 登记并就地回显', async (t) => {
  /** @type {Array<{url: string, method: string}>} */
  const calls = []
  const responses = {
    'GET /api/memento/entries?limit=1': { panel: { enabled: true }, language: 'zh' },
    'GET /api/memento/entries?limit=200': {
      language: 'zh',
      entries: [{ id: 'e1', track: 'user', scope: 'user-global', text: '常驻画像：偏好先给结论', source: 'dsh-memento', agentKey: '', createdAt: Date.now() }],
      total: 1,
      truncated: false,
      budgets: [{ track: 'user', scope: 'user-global', used: 12, limit: 2000 }],
    },
    'GET /api/memento/audit?limit=20': { rows: [] },
    'GET /api/memento/proposals': { proposals: [] },
    'GET /api/memento/stats': {
      lines: ['可观测三数（只读、零模型、不落审计）：', '① 重复率：0.00%', '② 召回命中率：无样本', '③ 注入量：还没有 snapshot 审计行。', '成功率：需反馈通道，待定义——本行刻意不报别的数。'],
      language: 'zh',
    },
    'GET /api/memento/tidy-request': { pending: null, language: 'zh' },
  }
  let registrations = 0
  const app = await mountClient(async (/** @type {string} */ key) => {
    const [method, url] = key.split(' ')
    calls.push({ url, method })
    // 登记端点的幂等语义照实现来：第二次 POST 返回 created=false，面板应回显「已在队列里」。
    if (key === 'POST /api/memento/tidy-request') {
      registrations += 1
      const pending = { id: 'req-1', createdAt: Date.now(), status: 'pending' }
      return { ok: true, status: 200, json: async () => ({ pending, created: registrations === 1, language: 'zh' }) }
    }
    const payload = responses[key]
    assert.ok(payload, `未预置响应：${key}`)
    return { ok: true, status: 200, json: async () => payload }
  })
  t.after(() => app.restore())

  // ① 半侧契约：按插件名注册唯一 factory；官方模块都是经种子表 require 拿到的。
  assert.equal(app.plugin.name, 'yammory_system-client')
  assert.equal(app.dom.window.plugin.id, 'yammory_system', 'client 半侧按插件名注册唯一 factory')
  assert.deepEqual(
    app.slots.injected,
    ['conversation.session.header.actions', 'shell.overlay', 'settings.section'],
    '开关钮在会话标题栏、抽屉挂官方通栏浮层、设置页仍是一级项',
  )
  assert.equal(app.slots.registered[1].name, 'shell.overlay')
  assert.equal(app.slots.registered[1].id, 'yammory-system-drawer')

  // ② 第一步（样式对齐）：自造 CSS 里不再有硬编码色值，浮起感走官方 elevation 令牌。
  const css = app.dom.styleText.join('\n')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, '面板样式不含硬编码色值')
  assert.equal(/rgba?\(/.test(css), false, '面板样式不含硬编码 rgba')
  assert.equal(css.includes('var(--dsw-elevation-prominent)'), true, '入口按钮的浮起感走官方 elevation 令牌')

  // ③ 入口按钮（官方 Button，id 不变）开抽屉。
  const open = app.dom.document.getElementById('mem-open')
  assert.ok(open, '悬浮入口按钮已渲染')
  assert.equal(open.attributes['data-test'], 'ui-button', '入口按钮换成官方 Button')
  assert.equal(open.textContent, '🧠 记忆')
  open.click()
  await app.render()

  const drawer = app.dom.document.getElementById('mem-drawer')
  assert.ok(drawer, '点击后抽屉已渲染（React 根挂在官方浮层容器里）')
  assert.equal(calls.some((call) => call.url === '/api/memento/entries?limit=200'), true, '打开抽屉取一轮条目')
  assert.equal(calls.some((call) => call.url === '/api/memento/stats'), true, '面板纯读三数路由')

  // ④ 三数行照抄响应里的 lines（不再拼 innerHTML，改为渲染出的文本）。
  assert.equal(drawer.textContent.includes('① 重复率：0.00%'), true, '三数行照抄响应里的 lines')
  assert.equal(drawer.textContent.includes('③ 注入量'), true)
  assert.equal(drawer.textContent.includes('user/user-global'), true, '预算条照抄预算方名')
  assert.equal(drawer.textContent.includes('12 / 2000'), true, '预算条照抄预算数')
  assert.equal(findByClass(drawer, 'mem-count').textContent, '共 1 条', '过滤计数行按可见/总数出数')

  // ⑤「整理全库」按钮：点一下只登记一条标记，就地回显。
  const tidyBtn = app.dom.document.getElementById('ui-button')
  assert.ok(tidyBtn, '「整理全库」按钮已渲染')
  assert.equal(tidyBtn.textContent, '整理全库')
  assert.equal(
    findByClass(drawer, 'mem-tidy-note').textContent,
    '只登记一条待整理标记：下次会话会请模型跑整理——这里不会合并任何条目。',
    '未登记时说明排队语义',
  )

  tidyBtn.click()
  await app.render()
  const posts = calls.filter((call) => call.method === 'POST')
  assert.equal(posts.length, 1, '点一下只发一次登记')
  assert.equal(posts[0].url, '/api/memento/tidy-request')
  assert.equal(findByClass(drawer, 'mem-tidy-note').textContent, '已登记。下次会话会请模型整理全库。', '就地回显登记结果')
  assert.equal(tidyBtn.disabled, false, '登记完成后按钮恢复可用')

  tidyBtn.click()
  await app.render()
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2, '再点一次会再发一次（幂等由服务端保证）')
  assert.equal(findByClass(drawer, 'mem-tidy-note').textContent, '已在队列里了，不重复登记。', '第二次登记如实回显「已排队」')
})


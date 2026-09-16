// test/panel-batches.test.mjs — 面板留痕与一键撤回（F8 批次面）。
//
// 三条验收线：
// ① 假 DOM 三钉：渲染组数、展开明细、点撤回发出正确请求（batchId 进 body）；
// ② 栅栏路由：GET/POST 都注册在 connection.fetch 注册表上（mock 只提供这一个注册面），
//    撤回经同一道栅栏；面板对记忆内容仍只读——写只有这一个按钮，且走 turn 外审批门；
// ③ 空壳不出现：没有批次记录时整块不渲染。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent } from './helpers/mock-ctx.mjs'
import { mountClient } from './client-harness.mjs'

/** 集成挂载：临时库 ＋ 全放行审批 ＋ 路由捕获（与既有面板用例同一套形状；语言取 zh 便于断言文案）。 */
function mount() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-panel-batches-'))
  const mock = createMockCtx()
  mock.ctx.approval = { request: async () => 'allowed-once', overrideOf: () => undefined, config: { policy: 'ask' } }
  mock.ctx.provide('commands', { register() { return () => {} } })
  /** @type {object[]} */
  const routes = []
  mock.ctx.provide('connection', { fetch: { register(/** @type {object} */ route) { routes.push(route); return async () => {} } } })
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
  return { mock, routes, service: mock.services.get('memory'), teardown }
}

/** 造一批自动整理（两条纯标点差异的同桶条目 → gradeMerge 判 auto）。 */
async function makeBatch(/** @type {any} */ service, /** @type {any} */ agent, /** @type {string} */ text) {
  const a = service.store.insertEntry({ track: 'user', scope: 'user-global', text })
  const b = service.store.insertEntry({ track: 'user', scope: 'user-global', text: `${text}。` })
  return service.autoTidy({ ids: [a.id, b.id], text }, { agent })
}

const batchRoute = (/** @type {object[]} */ routes) => /** @type {any} */ (routes.find((candidate) => /** @type {{path?: string}} */ (candidate).path === '/api/memento/batches'))
const getBatches = (/** @type {any} */ route) => route.fetch(new Request('http://localhost/api/memento/batches'))
const postBatch = (/** @type {any} */ route, /** @type {string} */ body) => route.fetch(new Request('http://localhost/api/memento/batches', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
}))
const visibleIds = (/** @type {any} */ store) => store.listEntries().map((/** @type {{id: string}} */ entry) => entry.id).sort()

/** 假 DOM 里按类名找第一个节点（与既有面板用例同一手法）。 */
function findByClass(/** @type {any} */ node, /** @type {string} */ className) {
  for (const child of node.children ?? []) {
    if (typeof child.className === 'string' && child.className.split(' ').includes(className)) return child
    const nested = findByClass(child, className)
    if (nested !== null) return nested
  }
  return null
}
/** 假 DOM 里按类名数节点个数（渲染组数用）。 */
function countByClass(/** @type {any} */ node, /** @type {string} */ className) {
  let count = 0
  for (const child of node.children ?? []) {
    if (typeof child.className === 'string' && child.className.split(' ').includes(className)) count += 1
    count += countByClass(child, className)
  }
  return count
}

// ── 路由面：与其它面板路由同一道栅栏 ────────────────────────────────────────

test('批次路由：没有记录时 batches 为空、summary 为 null（面板据此不渲染）', async (t) => {
  const mounted = mount()
  t.after(() => mounted.teardown())
  const route = batchRoute(mounted.routes)
  assert.ok(route, '路由已注册（经 connection.fetch 注册表——mock 只提供这一个注册面）')
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'], 'GET 读、POST 撤回合并为一条路由')
  assert.equal(route.requestBody, 'buffered', '与其它面板路由同一身体模式')

  const body = await (await getBatches(route)).json()
  assert.deepEqual(body.batches, [], '无记录时批次清单为空')
  assert.equal(body.summary, null, 'summary 为 null：面板据此整块不渲染')
})

test('批次路由：GET 渲染摘要/明细/按钮文案；POST 撤回并复原可见集', async (t) => {
  const mounted = mount()
  t.after(() => mounted.teardown())
  const { service, routes } = mounted
  const agent = makeAgent(makeSession({ id: 's-panel' }))
  const a = service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复' })
  const b = service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好中文回复。' })
  const before = visibleIds(service.store)
  const made = await service.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, { agent })

  const listed = await (await getBatches(batchRoute(routes))).json()
  assert.equal(listed.summary, '本次自动整理 1 组', '摘要由服务端用 lib/strings.mjs 渲染')
  assert.equal(listed.expandLabel, '展开明细')
  assert.equal(listed.batches.length, 1)
  const row = listed.batches[0]
  assert.equal(row.batchId, made.batchId)
  assert.equal(row.rolledBack, false)
  assert.equal(row.rollbackLabel, '撤回这一批')
  assert.equal(row.rolledBackLabel, '已撤回')
  assert.deepEqual(row.details.map((/** @type {string} */ line) => line.split(' ')[0]), ['源', '源', '产出'], '明细：两条源、一条产出，角色取自审计还原（不按当前状态猜）')
  assert.ok(row.details.some((/** @type {string} */ line) => line.includes('偏好中文回复')))

  const rolled = await postBatch(batchRoute(routes), JSON.stringify({ batchId: made.batchId }))
  assert.equal(rolled.status, 200)
  const rolledBody = await rolled.json()
  assert.equal(rolledBody.restored, 2)
  assert.equal(rolledBody.demoted, 1)
  assert.ok(String(rolledBody.note).includes('已撤回'), '回执文案与命令面同源')
  assert.deepEqual(visibleIds(service.store), before, '撤回后可见集与整理前逐 id 一致')

  const after = await (await getBatches(batchRoute(routes))).json()
  assert.equal(after.batches[0].rolledBack, true, '再列时标出已撤回')
  assert.equal(after.summary, '本次自动整理 1 组', '已撤回的批次仍在留痕里（看得见历史）')
})

test('批次路由：坏 body 与未知批次响亮拒绝，库零变更', async (t) => {
  const mounted = mount()
  t.after(() => mounted.teardown())
  const { service, routes } = mounted
  const agent = makeAgent(makeSession({ id: 's-panel-bad' }))
  const made = await makeBatch(service, agent, '偏好中文回复')
  const before = visibleIds(service.store)

  assert.equal((await postBatch(batchRoute(routes), '{}')).status, 400, '缺 batchId → 400')
  assert.equal((await postBatch(batchRoute(routes), '{"batchId":123}')).status, 400, '非字符串 → 400')
  assert.equal((await postBatch(batchRoute(routes), '{"batchId":""}')).status, 400, '空串 → 400')
  assert.equal((await postBatch(batchRoute(routes), `{"batchId":"${made.batchId}","extra":1}`)).status, 400, '多余字段 → 400')
  assert.equal((await postBatch(batchRoute(routes), 'not json')).status, 400, '坏 body → 400')

  const unknown = await postBatch(batchRoute(routes), '{"batchId":"00000000-0000-4000-8000-000000000000"}')
  assert.equal(unknown.status, 500, '未知批次：领域错误如实上抛（面板显示错误原文）')
  assert.ok(String((await unknown.json()).error).includes('no batch'))
  assert.deepEqual(visibleIds(service.store), before, '一路拒绝下来库零变更')
})

// ── 假 DOM：三钉 ──────────────────────────────────────────────────────────

/** 面板骨架的响应表（含批次面；与既有面板用例同一套）。 */
function panelResponses(/** @type {object} */ batchesPayload) {
  return {
    'GET /api/memento/entries?limit=1': { panel: { enabled: true }, language: 'zh' },
    'GET /api/memento/entries?limit=200': { language: 'zh', entries: [], total: 0, truncated: false, budgets: [] },
    'GET /api/memento/audit?limit=20': { rows: [] },
    'GET /api/memento/proposals': { proposals: [] },
    'GET /api/memento/stats': { lines: ['可观测三数（只读、零模型、不落审计）：'], language: 'zh' },
    'GET /api/memento/tidy-request': { pending: null, language: 'zh' },
    'GET /api/memento/batches': batchesPayload,
  }
}

const TWO_BATCHES = {
  language: 'zh',
  summary: '本次自动整理 2 组',
  expandLabel: '展开明细',
  collapseLabel: '收起明细',
  batches: [
    { batchId: 'b-1', at: 1, rolledBack: false, details: ['源 [s1] 偏好中文回复', '产出 [p1] 偏好中文回复'], rollbackLabel: '撤回这一批', rolledBackLabel: '已撤回' },
    { batchId: 'b-2', at: 2, rolledBack: true, details: ['源 [s2] 偏好英文界面', '产出 [p2] 偏好英文界面'], rollbackLabel: '撤回这一批', rolledBackLabel: '已撤回' },
  ],
}

/** 打开抽屉（点侧栏入口）。 */
async function openDrawer(/** @type {any} */ app) {
  app.renderSlot('sidebar.footer.action', { wide: true })
  const open = app.dom.document.getElementById('mem-entry')
  assert.ok(open, '侧栏入口已渲染')
  open.click()
  await app.render()
  const drawer = app.dom.document.getElementById('mem-drawer')
  assert.ok(drawer, '抽屉已渲染')
  return drawer
}

test('面板批次行：渲染组数、展开明细、点撤回发出正确请求', async (t) => {
  const responses = panelResponses(TWO_BATCHES)
  const app = await mountClient(async (/** @type {string} */ key) => {
    if (key === 'POST /api/memento/batches') {
      return { ok: true, status: 200, json: async () => ({ batchId: 'b-1', restored: 2, demoted: 1, note: '已撤回：恢复 2 条为在场状态，降级 1 条本批产出', language: 'zh' }) }
    }
    const payload = /** @type {any} */ (responses)[key]
    assert.ok(payload, `未预置响应：${key}`)
    return { ok: true, status: 200, json: async () => payload }
  })
  t.after(() => app.restore())
  const calls = app.calls

  const drawer = await openDrawer(app)
  const section = findByClass(drawer, 'mem-batches')
  assert.ok(section, '抽屉里有批次块')
  assert.ok(drawer.textContent.includes('本次自动整理 2 组'), '① 渲染组数：摘要行照抄路由渲染的文案')
  assert.equal(findByClass(drawer, 'mem-batch-details'), null, '未展开时明细不渲染')

  findByClass(drawer, 'mem-batch-toggle').click()
  await app.render()
  assert.equal(countByClass(drawer, 'mem-batch'), 2, '① 展开后按批次数渲染块')
  const details = findByClass(drawer, 'mem-batch-details')
  assert.ok(details, '② 展开明细')
  assert.ok(details.textContent.includes('源 [s1] 偏好中文回复'), '明细含源条目')
  assert.ok(details.textContent.includes('产出 [p1] 偏好中文回复'), '明细含产出条目')

  const rollbackBtn = findByClass(drawer, 'mem-batch-rollback')
  assert.equal(rollbackBtn.textContent, '撤回这一批', '未撤回的批次给撤回按钮')
  assert.equal(rollbackBtn.disabled, false)
  rollbackBtn.click()
  await app.render()

  const posts = calls.filter((call) => call.method === 'POST')
  assert.equal(posts.length, 1, '③ 点一下只发一次撤回')
  assert.equal(posts[0].url, '/api/memento/batches')
  assert.equal(posts[0].body, JSON.stringify({ batchId: 'b-1' }), '③ 请求体带的是这一批的批次号')
  assert.ok(findByClass(drawer, 'mem-batch-note').textContent.includes('已撤回'), '就地回显撤回结果')
  assert.equal(calls.filter((call) => call.url === '/api/memento/batches' && call.method === 'GET').length >= 2, true, '撤回后重新拉一次留痕')
})

// 空壳那一条住在 test/panel-batches-empty.test.mjs：假 DOM 桩同一进程只挂一次，
// 需要不同响应的用例得拆到独立文件（见 test/client-harness.mjs 的注释）。

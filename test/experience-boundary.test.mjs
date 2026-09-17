// test/experience-boundary.test.mjs — 两个世界的通道不变量。
//
// 分家判据（skills/yammory-experience）：这条知识该不该每一轮都在场。
// 落成代码事实的是观察通道这一侧——它只产「关于人」的条目，落 user/user-global：
// ① 条目组装函数把轨道与作用域写死，模型连传 track/scope 的参数都没有；
// ② raw 里塞 track='agent' 也不生效（只读白名单字段）。
// 反向那条（记忆内容误写进 agent 轨）由 memory 工具的 track 选择与审批门把关，
// 不在本文件的断言面。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeObservationEntries } from '../lib/observe.mjs'
import { OBSERVATION_SOURCE } from '../lib/constants.mjs'
import { apply, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx } from './helpers/mock-ctx.mjs'

const AT = Date.UTC(2026, 8, 17, 9, 30)

test('观察通道不变量：产出的条目恒落 user/user-global，且来源锚死 observation', () => {
  const entries = normalizeObservationEntries([
    { face: '思维方式与思辨', text: '被追问时会先复述约束再动手', evidence: '“先把方案读完再改代码”（09-13）', confidence: '高' },
    { face: '校正', facet: '能力与技能', text: '换新工具时会先要一份最小可跑样例', evidence: '“给我个能跑的最小例子”', confidence: '中' },
  ], AT, 'zh')

  assert.equal(entries.length, 2, '两条都过门')
  for (const entry of entries) {
    assert.equal(entry.track, 'user', '观察产的是关于人的模式，恒落 user 轨（经验那条世界它进不去）')
    assert.equal(entry.scope, 'user-global', '作用域同样写死：画像跨工作区')
    assert.equal(entry.source, OBSERVATION_SOURCE, '来源由工具锚死，不由模型传')
    assert.ok(Array.isArray(entry.tags) && entry.tags.includes('observation'), '观察标在 tags 里，面板与查询据此分开')
  }
})

test('观察通道不接受调用方指定轨道：raw 里塞 track/scope 不生效', () => {
  const [entry] = normalizeObservationEntries([
    { face: '人格特质', text: '任务被打断时会先确认边界再继续', evidence: '“先把边界说清楚”', track: 'agent', scope: 'workspace' },
  ], AT, 'zh')

  assert.equal(entry.track, 'user', '塞进来的 track 不是入参面的一部分，只被忽略')
  assert.equal(entry.scope, 'user-global', '同上：作用域同样不可由调用方指定')
})

/** 集成挂载（与既有面板用例同一套形状）：真 SQLite ＋ 路由捕获。 */
function mount() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-experience-'))
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

test('面板数据面：entries 路由随响应下发七面清单、知识领域清单与水位', async (t) => {
  const mounted = mount()
  t.after(() => mounted.teardown())
  mounted.service.store.insertEntry({ track: 'user', scope: 'user-global', text: '偏好结论先行', facet: '心智' })
  mounted.service.store.profileUpsert({ domain: '学习方法', level: 6 })

  const route = /** @type {any} */ (mounted.routes.find((candidate) => /** @type {{path?: string}} */ (candidate).path === '/api/memento/entries'))
  assert.ok(route, 'entries 路由已注册（经 connection.fetch 注册表）')
  const body = await (await route.fetch(new Request('http://localhost/api/memento/entries?limit=200'))).json()

  assert.deepEqual(body.facets, ['躯体', '心智', '价值与意愿', '能力与技能', '行为与习惯', '社会与处境', '经历与轨迹'], '七面清单随响应下发（单一出处仍是 lib/constants.mjs）')
  assert.equal(body.categories.length, 8, '八大类随响应下发')
  assert.equal(body.categories.flatMap(([, domains]) => domains).length, 31, '共 31 个子领域（知识水位块的骨架）')
  assert.equal(body.profile.length, 1, '已打分领域随响应下发')
  assert.equal(body.profile[0].tier, '本科', 'tier 由 level 推导，前端照抄')
  assert.equal(body.entries[0].facet, '心智', '条目自带面，客户端据此搭七面树')
})

// test/panel-worlds.test.mjs — 面板的两个世界：记忆＝七面结构树，经验＝话题树。
//
// 三条钉子：
// ① 打开抽屉先看「划分」：七面名与计数在，条目正文不在；
// ② 点分类节点才展开该面的条目；
// ③ 切「经验」页签只显示 agent 轨条目，按话题分桶、同样先折叠。
//
// 假 DOM 桩同一进程只挂一次、且一份响应表对应一次挂载（见 test/client-harness.mjs
// 405-410 行的注释），所以本例独占一个文件、一次挂载。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './client-harness.mjs'

const FACETS = ['躯体', '心智', '价值与意愿', '能力与技能', '行为与习惯', '社会与处境', '经历与轨迹']
const CATEGORIES = [['元能力', ['学习方法']], ['工程与技术', ['计算机与编程']]]
const PROFILE = [{ domain: '学习方法', level: 6, tier: '本科', updatedAt: 1700000000000 }]

const ENTRIES = [
  { id: 'u1', track: 'user', scope: 'user-global', text: '偏好结论先行', source: 'memory-tool', tags: [], facet: '心智', agentKey: '', createdAt: 1700000000000 },
  { id: 'u2', track: 'user', scope: 'user-global', text: '交出选择权前先给出排序标准', source: 'observation', tags: ['observation', '2026-09-17'], facet: null, agentKey: '', createdAt: 1700000001000 },
  { id: 'a1', track: 'agent', scope: 'user-global', text: 'WSL 里看 diff 要用 Windows 侧 git', source: 'memory-tool', tags: ['git', 'A-开发相关'], facet: null, agentKey: '', createdAt: 1700000002000 },
]

const RESPONSES = {
  'GET /api/memento/entries?limit=1': { panel: { enabled: true }, language: 'zh' },
  'GET /api/memento/entries?limit=200': { language: 'zh', entries: ENTRIES, total: ENTRIES.length, truncated: false, budgets: [], facets: FACETS, categories: CATEGORIES, profile: PROFILE },
  'GET /api/memento/audit?limit=20': { rows: [] },
  'GET /api/memento/proposals': { proposals: [] },
  'GET /api/memento/stats': { lines: [], language: 'zh' },
  'GET /api/memento/tidy-request': { pending: null, language: 'zh' },
  'GET /api/memento/batches': { batches: [], summary: null },
}

/** 假 DOM 里按类名收齐节点（与既有面板用例同一手法，只是要全部而不是第一个）。 */
function findAllByClass(/** @type {any} */ node, /** @type {string} */ className, /** @type {any[]} */ out = []) {
  for (const child of node.children ?? []) {
    if (typeof child.className === 'string' && child.className.split(' ').includes(className)) out.push(child)
    findAllByClass(child, className, out)
  }
  return out
}

/** 假 DOM 里按「类名 ＋ 可见文字」找节点（树节点靠标签区分）。 */
function findByClassAndText(/** @type {any} */ node, /** @type {string} */ className, /** @type {string} */ text) {
  for (const child of node.children ?? []) {
    if (typeof child.className === 'string' && child.className.split(' ').includes(className) && String(child.textContent).includes(text)) return child
    const nested = findByClassAndText(child, className, text)
    if (nested !== null) return nested
  }
  return null
}

test('面板两个世界：先看划分、点开见条目；经验侧按话题分桶', async (t) => {
  const app = await mountClient(async (/** @type {string} */ key) => {
    const payload = /** @type {any} */ (RESPONSES)[key]
    assert.ok(payload, `未预置响应：${key}`)
    return { ok: true, status: 200, json: async () => payload }
  })
  t.after(() => app.restore())

  app.renderSlot('sidebar.footer.action', { wide: true })
  const open = app.dom.document.getElementById('mem-entry')
  assert.ok(open, '侧栏入口已渲染')
  open.click()
  await app.render()
  const drawer = app.dom.document.getElementById('mem-drawer')
  assert.ok(drawer, '抽屉已渲染')

  // ① 页签按轨道分家，计数如实
  const tabs = findAllByClass(drawer, 'mem-tab')
  assert.equal(tabs.length, 2, '两个世界 = 两个页签')
  assert.ok(tabs[0].textContent.includes('记忆 (2)'), `记忆页签计 user 轨 2 条（实测：${tabs[0].textContent}）`)
  assert.ok(tabs[1].textContent.includes('经验 (1)'), `经验页签计 agent 轨 1 条（实测：${tabs[1].textContent}）`)

  // ② 默认只呈现「划分」：七个面名都在（空面也显示），正文一条都不渲染
  for (const facet of ['价值与意愿', '经历与轨迹']) assert.ok(drawer.textContent.includes(facet), `空面「${facet}」也显示（把架构摆上前端）`)
  assert.ok(drawer.textContent.includes('未分类'), '没打面的条目有兜底节点')
  assert.equal(drawer.textContent.includes('偏好结论先行'), false, '未点开分类时条目正文不渲染')
  assert.equal(drawer.textContent.includes('WSL 里看 diff'), false, '另一个世界的条目同样不渲染')

  // ③ 点「心智」分类节点才展开该面的条目
  const mind = findByClassAndText(drawer, 'mem-tree-toggle', '心智')
  assert.ok(mind, '找到「心智」节点')
  mind.click()
  await app.render()
  assert.ok(drawer.textContent.includes('偏好结论先行'), '展开后看到该面的条目')
  assert.equal(drawer.textContent.includes('交出选择权前先给出排序标准'), false, '别的分类仍折叠着')

  // ④ 切「经验」页签：只显示 agent 轨，按话题分桶
  findAllByClass(drawer, 'mem-tab')[1].click()
  await app.render()
  assert.equal(drawer.textContent.includes('偏好结论先行'), false, '记忆世界的条目不在经验页签里')
  assert.ok(drawer.textContent.includes('git'), '话题节点出现（tags 里第一个非保留标）')
  assert.equal(drawer.textContent.includes('WSL 里看 diff'), false, '未展开话题时正文不渲染')

  const topic = findByClassAndText(drawer, 'mem-tree-toggle', 'git')
  assert.ok(topic, '找到 git 话题节点')
  topic.click()
  await app.render()
  assert.ok(drawer.textContent.includes('WSL 里看 diff 要用 Windows 侧 git'), '展开话题后看到经验条目')

  // ⑤ 知识水位块：默认收起，展开后逐领域给 level/tier，未打分的标出来
  findAllByClass(drawer, 'mem-tab')[0].click()
  await app.render()
  assert.equal(drawer.textContent.includes('知识水位'), true, '水位块节点常驻可见（计数 = 已打分领域数）')
  assert.equal(drawer.textContent.includes('6/10'), false, '默认收起：不展开不渲染明细')
  const levels = findByClassAndText(drawer, 'mem-tree-toggle', '知识水位')
  assert.ok(levels, '找到知识水位节点')
  levels.click()
  await app.render()
  assert.ok(drawer.textContent.includes('6/10'), '展开后给已打分领域的 level')
  assert.ok(drawer.textContent.includes('计算机与编程') && drawer.textContent.includes('未打分'), '31 子领域全在，未打分的标出来')
})

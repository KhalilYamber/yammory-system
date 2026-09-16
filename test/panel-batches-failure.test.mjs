// test/panel-batches-failure.test.mjs — 面板批次行撤回失败的可见回执（F8 批次面第二锚：失败也要有回执）。
//
// 假 DOM 桩同一进程只挂一次（见 test/client-harness.mjs 注释），需要另一份响应表的用例
// 必须独占一个测试文件。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './client-harness.mjs'

/** 假 DOM 里按类名找第一个节点（与既有面板用例同一手法）。 */
function findByClass(/** @type {any} */ node, /** @type {string} */ className) {
  for (const child of node.children ?? []) {
    if (typeof child.className === 'string' && child.className.split(' ').includes(className)) return child
    const nested = findByClass(child, className)
    if (nested !== null) return nested
  }
  return null
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

const TWO_BATCHES = {
  language: 'zh',
  summary: '本次自动整理 2 组',
  expandLabel: '展开明细',
  collapseLabel: '收起明细',
  batches: [
    { batchId: 'b-1', at: 1, rolledBack: false, details: ['源 [s1] 偏好中文回复', '产出 [p1] 偏好中文回复'], rollbackLabel: '撤回这一批', rolledBackLabel: '已撤回' },
  ],
}

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

test('面板批次行：撤回失败时把错误原文就地回显（不只是成功路径有回执）', async (t) => {
  const responses = panelResponses(TWO_BATCHES)
  const app = await mountClient(async (/** @type {string} */ key) => {
    if (key === 'POST /api/memento/batches') {
      // 路由把领域错误如实上抛成 500 + error 原文；面板必须把它显示出来，而不是静默。
      return { ok: false, status: 500, json: async () => ({ error: 'batch "b-1" is already rolled back; nothing was changed' }) }
    }
    const payload = /** @type {any} */ (responses)[key]
    assert.ok(payload, `未预置响应：${key}`)
    return { ok: true, status: 200, json: async () => payload }
  })
  t.after(() => app.restore())
  const calls = app.calls

  const drawer = await openDrawer(app)
  findByClass(drawer, 'mem-batch-toggle').click()
  await app.render()
  findByClass(drawer, 'mem-batch-rollback').click()
  await app.render()

  const note = findByClass(drawer, 'mem-batch-note')
  assert.ok(note, '失败也要有可见回执')
  assert.ok(note.textContent.includes('already rolled back'), `错误原文照实回显（实测：${note.textContent}）`)
  // 本锚只问两件事：失败有可见回执、按钮恢复可用。至于失败后拉了几次留痕属内部行为，
  // 不写成断言（写成「恰好 1 次」会把实现细节当验收，改一次实现就红）。
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1, '点一下只发一次撤回')
  const busy = findByClass(drawer, 'mem-batch-rollback')
  assert.equal(busy.disabled, false, '失败后按钮恢复可用，可再试')
  findByClass(drawer, 'mem-batch-rollback').click()
  await app.render()
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2, '再点一次能再发（不是一次性的死按钮）')
})

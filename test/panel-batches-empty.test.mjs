// test/panel-batches-empty.test.mjs — 面板批次行的空壳面（F8 批次面第三条验收锚）。
//
// 「没有自动整理记录时那一行不出现，不显示空壳」单独一个文件：假 DOM 桩同一进程只挂一次
// （ESM 缓存 + 覆盖率计账的理由见 test/client-harness.mjs 的注释），所以需要另一份响应表
// 的用例必须独占一个测试文件。

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

test('面板批次行：没有记录时整块不出现（不留空壳）', async (t) => {
  const responses = {
    'GET /api/memento/entries?limit=1': { panel: { enabled: true }, language: 'zh' },
    'GET /api/memento/entries?limit=200': { language: 'zh', entries: [], total: 0, truncated: false, budgets: [] },
    'GET /api/memento/audit?limit=20': { rows: [] },
    'GET /api/memento/proposals': { proposals: [] },
    'GET /api/memento/stats': { lines: ['可观测三数（只读、零模型、不落审计）：'], language: 'zh' },
    'GET /api/memento/tidy-request': { pending: null, language: 'zh' },
    'GET /api/memento/batches': { language: 'zh', summary: null, expandLabel: '展开明细', collapseLabel: '收起明细', batches: [] },
  }
  const app = await mountClient(async (/** @type {string} */ key) => {
    const payload = /** @type {any} */ (responses)[key]
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

  assert.equal(findByClass(drawer, 'mem-batches'), null, '无记录：批次块不渲染')
  assert.equal(findByClass(drawer, 'mem-batch-toggle'), null, '无记录：展开按钮也不渲染')
  assert.equal(findByClass(drawer, 'mem-batch-rollback'), null, '无记录：撤回按钮也不渲染')
  assert.equal(drawer.textContent.includes('本次自动整理'), false, '无记录：不出现空壳文案')
})

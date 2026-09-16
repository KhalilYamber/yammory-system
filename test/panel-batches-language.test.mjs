// test/panel-batches-language.test.mjs — 面板批次行的语言面（F8 批次面第三锚：文案随 language 切换）。
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

const EN_BATCHES = {
  language: 'en',
  summary: 'Auto-tidy batches in view: 1',
  expandLabel: 'Show details',
  collapseLabel: 'Hide details',
  batches: [
    { batchId: 'b-9', at: 1, rolledBack: false, details: ['source [s9] prefers Chinese', 'produced [p9] prefers Chinese'], rollbackLabel: 'Roll back this batch', rolledBackLabel: 'Rolled back' },
  ],
}

test('面板批次行：language=en 时文案整块切英文（无中文硬编码残留）', async (t) => {
  const responses = panelResponses(EN_BATCHES)
  const app = await mountClient(async (/** @type {string} */ key) => {
    const payload = /** @type {any} */ (responses)[key]
    assert.ok(payload, `未预置响应：${key}`)
    return { ok: true, status: 200, json: async () => payload }
  })
  t.after(() => app.restore())

  const drawer = await openDrawer(app)
  assert.ok(drawer.textContent.includes('Auto-tidy batches in view: 1'), '摘要行切英文')
  findByClass(drawer, 'mem-batch-toggle').click()
  await app.render()
  // 只判**批次块自身**的文字：整个抽屉里还有别的面板（刷新提示、空列表、待整理提示），
  // 它们的响应在夹具里仍是中文，与批次面的语言无关。
  const after = findByClass(drawer, 'mem-batches').textContent
  assert.ok(after.includes('Roll back this batch'), '按钮文案切英文')
  assert.ok(after.includes('source [s9]') && after.includes('produced [p9]'), '明细行切英文')
  // 英文档里不得出现**汉字**（面板文案由 language 字段驱动，不硬编码）。注意：其余版面
  // （如空列表提示、写操作提示）的文案归语言无关的既有实现，不在本锚范围内，故只判汉字。
  const han = after.match(/[\u4e00-\u9fff]/gu) ?? []
  assert.deepEqual(han, [], `英文档批次文案不得含汉字（实测命中：${han.join('')}）`)
  // 批次面的四类文案本身必须是英文（逐项断言，避免只靠"没有汉字"这种否定判据）。
  for (const expected of ['Auto-tidy batches in view: 1', 'Roll back this batch', 'source [s9]', 'produced [p9]', 'Hide details']) {
    assert.ok(after.includes(expected), `英文档应含「${expected}」`)
  }
})

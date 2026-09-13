// test/snapshot.test.mjs — 冻结快照渲染单测：分组/排序/用量头/空态/可见性；
// S2 追加预热段（表达约束 + 常驻画像）与常驻半边过滤的断言。

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshot, renderWarmup, residentEntries, visibleEntries } from '../lib/snapshot.mjs'

const BUDGETS = {
  user: { userGlobal: 2000, workspace: 2000 },
  agent: { userGlobal: 4000, workspace: 4000 },
}

function entry(partial) {
  return {
    id: partial.id ?? 'id',
    track: partial.track,
    scope: partial.scope,
    workspaceKey: partial.workspaceKey ?? '',
    agentKey: partial.agentKey ?? '',
    text: partial.text,
    source: 'test',
    createdAt: partial.createdAt ?? 0,
    updatedAt: 0,
    sessionId: null,
  }
}

test('无条目时渲染空串（空段不进提示词，零 token 成本）', () => {
  assert.equal(renderSnapshot([], BUDGETS), '')
})

test('快照含冻结说明、每组用量头与条目文本', () => {
  const entries = [
    entry({ id: 'u1', track: 'user', scope: 'user-global', text: '偏好中文回复' }),
    entry({ id: 'a1', track: 'agent', scope: 'workspace', text: '测试先于实现', workspaceKey: '/w' }),
  ]
  const text = renderSnapshot(entries, BUDGETS)
  assert.ok(text.startsWith('[dsh-memento: frozen memory snapshot'), '应带冻结说明头')
  assert.ok(text.includes('User profile (global preferences, communication style, landmines) — 6/2000 chars used'), 'user-global 组应带用量头 6/2000')
  assert.ok(text.includes('Workspace facts, conventions, and lessons — 6/4000 chars used'), 'agent/workspace 组应带用量头 6/4000')
  assert.ok(text.includes('- 偏好中文回复'))
  assert.ok(text.includes('- 测试先于实现'))
})

test('同一组内按创建时间升序（旧事实在前）', () => {
  const entries = [
    entry({ id: 'b', track: 'user', scope: 'user-global', text: 'newer', createdAt: 2 }),
    entry({ id: 'a', track: 'user', scope: 'user-global', text: 'older', createdAt: 1 }),
  ]
  const text = renderSnapshot(entries, BUDGETS)
  assert.ok(text.indexOf('- older') < text.indexOf('- newer'))
})

test('language=zh 渲染中文冻结头、分组标题与用量后缀；未知语言回退 en', () => {
  const entries = [
    entry({ id: 'u1', track: 'user', scope: 'user-global', text: '偏好中文回复' }),
    entry({ id: 'a1', track: 'agent', scope: 'workspace', text: '测试先于实现', workspaceKey: '/w' }),
  ]
  const zh = renderSnapshot(entries, BUDGETS, [], 'zh')
  assert.ok(zh.startsWith('[dsh-memento：冻结记忆快照'), 'zh 冻结头')
  assert.ok(zh.includes('用户画像（全局偏好、沟通风格、雷区） — 6/2000 已用字符'), 'zh 分组标题 + 用量后缀')
  assert.ok(zh.includes('- 偏好中文回复'))
  const fallback = renderSnapshot(entries, BUDGETS, [], 'fr')
  assert.equal(fallback, renderSnapshot(entries, BUDGETS), '未知语言回退 en')
})

test('空组不渲染（不浪费 token）', () => {
  const entries = [entry({ id: 'a', track: 'user', scope: 'user-global', text: 'x' })]
  const text = renderSnapshot(entries, BUDGETS)
  assert.ok(!text.includes('User preferences for this workspace'))
  assert.ok(!text.includes('Workspace facts'))
})

test('visibleEntries：user-global 全见；workspace 只匹配 workspaceKey', () => {
  const entries = [
    entry({ id: 'g', track: 'user', scope: 'user-global', text: 'global' }),
    entry({ id: 'w1', track: 'agent', scope: 'workspace', text: 'mine', workspaceKey: '/w' }),
    entry({ id: 'w2', track: 'user', scope: 'workspace', text: 'other', workspaceKey: '/other' }),
  ]
  const visible = visibleEntries(entries, '/w')
  assert.deepEqual(visible.map((v) => v.id).sort(), ['g', 'w1'])
})

test('visibleEntries：agentKey 共享层全见，专属层只匹配会话 agentKey', () => {
  const entries = [
    entry({ id: 'shared', track: 'user', scope: 'user-global', text: 'shared', agentKey: '' }),
    entry({ id: 'mine', track: 'user', scope: 'user-global', text: 'mine', agentKey: 'preset-a' }),
    entry({ id: 'other', track: 'user', scope: 'user-global', text: 'other', agentKey: 'preset-b' }),
  ]
  assert.deepEqual(visibleEntries(entries, '/w', 'preset-a').map((v) => v.id).sort(), ['mine', 'shared'])
  assert.deepEqual(visibleEntries(entries, '/w', '').map((v) => v.id), ['shared'], '无 preset 的会话只见共享层')
})

// ---------------------------------------------------------------------------
// S2：预热段（表达约束 + 常驻画像）
// ---------------------------------------------------------------------------

test('S2：residentEntries 只取 user × user-global（复用既有 scope，不新增列）', () => {
  const entries = [
    entry({ id: 'keep1', track: 'user', scope: 'user-global', text: '全局偏好' }),
    entry({ id: 'keep2', track: 'user', scope: 'user-global', text: '雷区', agentKey: 'preset-a' }),
    entry({ id: 'drop1', track: 'user', scope: 'workspace', text: '工作区偏好', workspaceKey: '/w' }),
    entry({ id: 'drop2', track: 'agent', scope: 'user-global', text: '环境事实' }),
    entry({ id: 'drop3', track: 'agent', scope: 'workspace', text: '项目约定', workspaceKey: '/w' }),
  ]
  assert.deepEqual(residentEntries(entries).map((v) => v.id), ['keep1', 'keep2'])
})

test('S2：预热段 = 表达约束（必在场）+ 常驻画像（带用量头）', () => {
  const entries = [
    entry({ id: 'u1', track: 'user', scope: 'user-global', text: '偏好中文回复', createdAt: 1 }),
    entry({ id: 'u2', track: 'user', scope: 'user-global', text: '不吃香菜', createdAt: 2 }),
    entry({ id: 'a1', track: 'agent', scope: 'workspace', text: '项目A约定', workspaceKey: '/w' }),
  ]
  const text = renderWarmup(entries, [{ domain: '计算机与编程', level: 8 }, { domain: '生物与医学', level: 3 }], BUDGETS, 'zh')
  assert.ok(text.startsWith('[dsh-memento：预热块'), '预热段头')
  assert.ok(text.includes('【表达约束】'), '表达约束段在场')
  assert.ok(text.includes('计算机与编程 8/10（硕士）'))
  assert.ok(text.includes('生物与医学 3/10（科普）'))
  assert.ok(text.includes('常驻画像（跨工作区的偏好'), '常驻画像标题')
  assert.ok(text.includes('/2000 已用字符'), '常驻画像带用量头')
  assert.ok(text.indexOf('- 偏好中文回复') < text.indexOf('- 不吃香菜'), '组内按创建时间升序')
  assert.ok(!text.includes('项目A约定'), 'agent/workspace 不进预热段')
})

test('S2：空库 + 空 profile 渲染空串（空段不进提示词，零 token）', () => {
  assert.equal(renderWarmup([], [], BUDGETS), '')
})

test('S2：只有 profile 没有条目时仍出表达约束（约束是预热的必在场半边）', () => {
  const text = renderWarmup([], [{ domain: '数学', level: 5 }], BUDGETS, 'zh')
  assert.ok(text.includes('【表达约束】'))
  assert.ok(!text.includes('## '), '无条目则不渲染常驻画像小节')
})

test('S2：有常驻条目但没有 profile 时也出约束段（默认档兜底）', () => {
  const text = renderWarmup([entry({ id: 'u1', track: 'user', scope: 'user-global', text: '全局偏好' })], [], BUDGETS, 'zh')
  assert.ok(text.includes('【表达约束】'))
  assert.ok(text.includes('未列领域按本科档'))
  assert.ok(text.includes('- 全局偏好'))
})

test('S2：language=en 出英文预热头与约束头；非法语言回退 en', () => {
  const rows = [{ domain: '数学', level: 5 }]
  const en = renderWarmup([], rows, BUDGETS)
  assert.ok(en.startsWith('[dsh-memento: warm-up block'))
  assert.ok(en.includes('[Speaking constraints]'))
  assert.ok(!en.includes('Standing profile'), '无条目则不渲染常驻画像小节')
  assert.equal(renderWarmup([], rows, BUDGETS, 'fr'), en, '未知语言回退 en')
  const withEntry = renderWarmup([entry({ id: 'u1', track: 'user', scope: 'user-global', text: 'global pref' })], rows, BUDGETS)
  assert.ok(withEntry.includes('Standing profile (cross-workspace preferences'), '有常驻条目则出英文画像标题')
})

test('S2：待审批提案块保留在预热段（自动采集 → 模型可见 → 提示用户裁决）', () => {
  const proposals = [{ id: 'p1', track: 'agent', scope: 'workspace', text: '跨会话建议' }]
  const text = renderWarmup([], [], BUDGETS, 'zh', proposals)
  assert.ok(text.includes('待审批记忆提案'))
  assert.ok(text.includes('[p1] agent/workspace: 跨会话建议'))
})

test('S2：同一份输入两次渲染逐字一致（预热段可冻结、可进前缀缓存）', () => {
  const entries = [entry({ id: 'u1', track: 'user', scope: 'user-global', text: '全局偏好', createdAt: 1 })]
  const rows = [{ domain: '数学', level: 5 }, { domain: '计算机与编程', level: 8 }]
  assert.equal(renderWarmup(entries, rows, BUDGETS, 'zh'), renderWarmup(entries, rows, BUDGETS, 'zh'))
})

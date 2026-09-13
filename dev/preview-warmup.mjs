// dev/preview-warmup.mjs — 预热段渲染样例（本地工程面，永不提交）。
// 用假数据跑 renderWarmup，让主人一眼看到模型会收到什么。

import { renderWarmup } from '../lib/snapshot.mjs'

const BUDGETS = {
  user: { userGlobal: 2000, workspace: 2000 },
  agent: { userGlobal: 4000, workspace: 4000 },
}

const entry = (id, track, scope, text, createdAt, workspaceKey = '') => ({
  id, track, scope, workspaceKey, agentKey: '', text, createdAt,
})

const entries = [
  entry('u1', 'user', 'user-global', '偏好中文回复，术语按领域深浅处理', 1),
  entry('u2', 'user', 'user-global', '不要用破折号；少用「不是…而是…」句式', 2),
  entry('u3', 'user', 'user-global', '讨厌被奉承，直接指出问题', 3),
  entry('a1', 'agent', 'workspace', '本项目测试先于实现', 4, '/w'),
  entry('u4', 'user', 'workspace', '本仓库提交信息用中文', 5, '/w'),
]

const profile = [
  { domain: '计算机与编程', level: 8 },
  { domain: 'AI 与数据', level: 7 },
  { domain: '数学', level: 5 },
  { domain: '生物与医学', level: 3 },
]

console.log('========== 预热段 · zh ==========')
console.log(renderWarmup(entries, profile, BUDGETS, 'zh'))
console.log('')
console.log('========== 预热段 · en（同数据，仅语言不同）==========')
console.log(renderWarmup(entries.slice(0, 1), profile.slice(0, 2), BUDGETS, 'en'))
console.log('')
console.log('========== 边界：空库 + 空 profile ==========')
console.log(JSON.stringify(renderWarmup([], [], BUDGETS, 'zh')))
console.log('')
console.log('========== 边界：只有提案，没有条目与 profile ==========')
console.log(renderWarmup([], [], BUDGETS, 'zh', [{ id: 'p1', track: 'agent', scope: 'workspace', text: '跨会话建议' }]))

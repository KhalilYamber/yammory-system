// lib/budget.mjs — 预警线核算（零 DSH 依赖，纯函数）。
//
// 每轨每层不再是「硬字符预算」而是「软预警线」：user 轨默认 2000/层，agent 轨默认
// 4000/层（Config budgets 可覆盖）。写入**永不因容量被拒**；越线只在快照头 / 面板 /
// 审计里提示「该整理了」，不拦写、不截断、不自动压缩。计数单位是 JS 字符串
// 长度（UTF-16 code unit）：一个汉字计 1，与用户直觉一致且可预测。真正的收敛
// 回路是静默整理机（F6）；预警线只是「该动手了」的提示。

import { TRACKS, SCOPES } from './constants.mjs'

/**
 * (track, scope) 的当前字符用量。
 * @param {Array<{track: string, scope: string, text: string}>} entries - 该组条目。
 * @param {string} track - 轨道。
 * @param {string} scope - 作用域。
 * @returns {number} 文本长度之和。
 */
export function entryUsage(entries, track, scope) {
  let used = 0
  for (const entry of entries) {
    if (entry.track === track && entry.scope === scope) used += entry.text.length
  }
  return used
}

/**
 * 全量用量行：每个 track×scope 一行。
 * @param {Array<{track: string, scope: string, text: string}>} entries - 全部条目。
 * @returns {Array<{track: 'user'|'agent', scope: 'user-global'|'workspace', used: number}>} 按轨道/作用域顺序排列。
 */
export function usageRows(entries) {
  const rows = []
  for (const track of TRACKS) {
    for (const scope of SCOPES) {
      rows.push({ track, scope, used: entryUsage(entries, track, scope) })
    }
  }
  return rows
}

/**
 * 预警线核算：当前用量 + 增量 是否越线。
 * v2 起只报「是否越线」，不再阻断写入——没有「拒」的分支，调用方据 over 显示提示，
 * 写路径照常放行（“拆上限”的具体落点）。
 * @param {number} used - 当前用量。
 * @param {number} line - 预警线（沿用旧「硬上限」的值，默认未变）。
 * @param {number} addition - 本次新增字符数（可为负，表示 replace 后的净变化）。
 * @returns {{used: number, line: number, projected: number, over: boolean}} 纯结果。
 */
export function checkBudget(used, line, addition) {
  const projected = used + addition
  return { used, line, projected, over: projected > line }
}

/**
 * 完整预算报表：每行携带上限。
 * @param {Array<{track: string, scope: string, text: string}>} entries - 全部条目。
 * @param {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} budgets - 形状 {user: {userGlobal, workspace}, agent: {userGlobal, workspace}}。
 * @returns {Array<{track: 'user'|'agent', scope: 'user-global'|'workspace', used: number, limit: number}>}。
 */
export function budgetReport(entries, budgets) {
  const limits = budgetLimits(budgets)
  return usageRows(entries).map((row) => ({ ...row, limit: limits[row.track][row.scope] }))
}

/**
 * 把 Config.budgets 规范化为 {track: {scope: limit}} 双键表。
 * @param {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} budgets - Config.budgets（含 userGlobal/workspace 键）。
 * @returns {{user: {'user-global': number, workspace: number}, agent: {'user-global': number, workspace: number}}}。
 */
export function budgetLimits(budgets) {
  return {
    user: {
      'user-global': budgets.user.userGlobal,
      workspace: budgets.user.workspace,
    },
    agent: {
      'user-global': budgets.agent.userGlobal,
      workspace: budgets.agent.workspace,
    },
  }
}

/**
 * 校验 budgets 配置形状：所有上限必须是正整数；缺失/非法在加载期响亮失败。
 * @param {unknown} budgets - 原始配置。
 * @returns {{ok: true, limits: object} | {ok: false, message: string}}。
 */
export function validateBudgets(budgets) {
  if (budgets === null || typeof budgets !== 'object') {
    return { ok: false, message: 'budgets must be an object with user/agent tracks and userGlobal/workspace layers' }
  }
  /** @type {Record<string, object>} */
  const limits = {}
  for (const track of TRACKS) {
    const trackConfig = /** @type {{userGlobal?: unknown, workspace?: unknown} | null | undefined} */ (/** @type {Record<string, unknown>} */ (budgets)[track])
    if (trackConfig === null || typeof trackConfig !== 'object') {
      return { ok: false, message: `budgets.${track} must be an object` }
    }
    const layerLimits = /** @type {Record<string, number>} */ ({})
    for (const scope of SCOPES) {
      const key = scope === 'user-global' ? 'userGlobal' : scope
      const limit = /** @type {Record<string, unknown>} */ (trackConfig)[key]
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
        return { ok: false, message: `budgets.${track}.${key} must be a positive integer` }
      }
      layerLimits[scope] = limit
    }
    limits[/** @type {string} */ (track)] = layerLimits
  }
  return { ok: true, limits }
}

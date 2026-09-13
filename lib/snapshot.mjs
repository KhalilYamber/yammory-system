// lib/snapshot.mjs — 冻结快照渲染（零 DSH 依赖，纯函数）。
//
// 会话启动时冻结一整块记忆并经 systemPrompt 段注入（system-prompt/assemble
// 提供 agent，section order = Config.snapshotOrder，默认 -50：harness
// identity(-100) 之后、persona(0) 之前）。会话内记忆变更只落盘+落审计，不更新
// 已注入文本（冻结语义 = 前缀缓存稳定）。
//
// 两条渲染路：
// - renderWarmup：预热段 =【表达约束】+【常驻画像】，只取与话题无关、每次会话都
//   该在场的 user-global 条目。index.mjs 快照段走这条。
// - renderSnapshot：原全量渲染（四组 + 提案块），保留给面板/导出/既有调用方。
// 「按需」那半是既有的 memory_recall 工具 + retrieval seam，不经此文件。

import { TRACKS, SCOPES } from './constants.mjs'
import { budgetReport } from './budget.mjs'
import {
  GROUP_TITLES, SNAPSHOT_HEADER, PROPOSAL_HEADER,
  WARMUP_HEADER, WARMUP_PROFILE_TITLE, WARMUP_DIRECTORY, pick,
} from './strings.mjs'
import { renderConstraint } from './constraint.mjs'

/**
 * @typedef {object} SnapshotEntry - 快照渲染看到的条目面。
 * @property {string} id
 * @property {string} track
 * @property {string} scope
 * @property {string} workspaceKey
 * @property {string} agentKey
 * @property {string} text
 * @property {number} createdAt
 */

/**
 * 过滤某个会话可见的条目：agentKey 为 ''（共享层）或匹配会话 agentKey；scope
 * user-global 全见；workspace 只匹配该会话的 workspaceKey（会话 cwd 的规范化绝对值）。
 * @param {SnapshotEntry[]} entries - 全部条目。
 * @param {string} workspaceKey - 会话 cwd 的规范化绝对值。
 * @param {string} [agentKey] - 会话 agentPreset 的规范化键；'' = 共享层。
 * @returns {SnapshotEntry[]} 可见条目。
 */
export function visibleEntries(entries, workspaceKey, agentKey = '') {
  return entries.filter((entry) =>
    (entry.agentKey === '' || entry.agentKey === agentKey)
    && (entry.scope === 'user-global' || (entry.scope === 'workspace' && entry.workspaceKey === workspaceKey)))
}

/**
 * 把条目按 (track, scope) 分组并组内按创建时间排序。
 * @param {SnapshotEntry[]} entries - 可见条目。
 * @returns {Map<string, SnapshotEntry[]>} key = 'track/scope'，值按 createdAt,id 升序。
 */
export function groupEntries(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = `${entry.track}/${entry.scope}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  for (const list of groups.values()) {
    list.sort((/** @type {SnapshotEntry} */ a, /** @type {SnapshotEntry} */ b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  return groups
}

/**
 * @typedef {object} SnapshotProposal - 快照渲染看到的提案面。
 * @property {string} id
 * @property {string} track
 * @property {string} scope
 * @property {string} workspaceKey
 * @property {string} agentKey
 * @property {string} text
 */

/**
 * 过滤某个会话可见的提案：与条目可见性同一语义（agentKey 共享/匹配 +
 * scope 规则）。
 * @param {SnapshotProposal[]} proposals - 全部 pending 提案。
 * @param {string} workspaceKey - 会话 cwd 的规范化绝对值。
 * @param {string} [agentKey] - 会话 agentPreset 的规范化键；'' = 共享层。
 * @returns {SnapshotProposal[]} 可见提案。
 */
export function visibleProposals(proposals, workspaceKey, agentKey = '') {
  return proposals.filter((proposal) =>
    (proposal.agentKey === '' || proposal.agentKey === agentKey)
    && (proposal.scope === 'user-global' || (proposal.scope === 'workspace' && proposal.workspaceKey === workspaceKey)))
}

/**
 * 常驻画像条目：可见条目里属于「与话题无关、每次会话都该在场」的那部分。复用既有
 * scope 概念（不新增列）——user 轨 × user-global 即用户自己跨工作区的偏好、沟通
 * 风格与雷区；工作区相关（scope=workspace）与 agent 轨（环境事实/约定/教训）不进
 * 预热，改由 memory_recall 按需取。
 * @param {SnapshotEntry[]} entries - 会话可见条目（visibleEntries 的输出）。
 * @returns {SnapshotEntry[]} 常驻画像条目。
 */
export function residentEntries(entries) {
  return entries.filter((entry) => entry.track === 'user' && entry.scope === 'user-global')
}

/**
 * 渲染预热段：表达约束（必在场，按 profile 表）+ 常驻画像（user-global 条目，带用量头）
 * + 待审批提案块（有则追加；保留 memento 原「自动采集的提案要让模型看见、好提示用户裁决」
 * 这条链路）+ 末行「一行目录」（不进预热的那半边折成一个条数，S4b-6）。
 *
 * 无任何可渲染内容时返回空串——空段不进提示词（与 renderSnapshot 同纪律）。
 * @param {SnapshotEntry[]} entries - 会话可见条目（visibleEntries 的输出；内部自取常驻半边）。
 * @param {Array<{domain: string, level: number}>} [profileRows] - profile 表行（分领域知识水平）。
 * @param {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} [budgets] - Config.budgets。
 * @param {string} [language] - 'en' | 'zh'（默认 en）。
 * @param {SnapshotProposal[]} [proposals] - 会话可见 pending 提案。
 * @returns {string} 预热段文本。
 */
export function renderWarmup(entries, profileRows = [], budgets = undefined, language = 'en', proposals = []) {
  // F4 分级注入：常驻段（user × user-global）有软线——按创建序累加到该格预警线为止，
  // 超出的条目下沉进按需池（只进目录行计数，不进上下文）；预算缺省时不收窄。
  const line = budgets?.user?.userGlobal
  const sortedResident = [...residentEntries(entries)].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  /** @type {SnapshotEntry[]} */
  const resident = []
  let keptChars = 0
  for (const entry of sortedResident) {
    if (Number.isInteger(line) && /** @type {number} */ (line) > 0 && resident.length > 0 && keptChars + entry.text.length > /** @type {number} */ (line)) continue
    resident.push(entry)
    keptChars += entry.text.length
  }
  // 一行目录的条数：可见条目去掉常驻半边——即 workspace 层、agent 轨，以及越过软线而下沉的常驻条目。
  const onDemand = entries.length - resident.length
  if (resident.length === 0 && profileRows.length === 0 && proposals.length === 0 && onDemand === 0) return ''
  const header = /** @type {string} */ (pick(WARMUP_HEADER, language))
  const profileTitle = /** @type {string} */ (pick(WARMUP_PROFILE_TITLE, language))
  const proposalHeader = /** @type {string} */ (pick(PROPOSAL_HEADER, language))
  const usageSuffix = language === 'zh' ? '已用字符（预警线）' : 'chars used (warning line)'
  const sections = [renderConstraint(profileRows, language)].filter((section) => section.length > 0)
  if (resident.length > 0) {
    const report = budgetReport(resident, /** @type {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} */ (budgets))
    const row = report.find((candidate) => candidate.track === 'user' && candidate.scope === 'user-global')
    sections.push(`## ${profileTitle} — ${row.used}/${row.limit} ${usageSuffix}\n${resident.map((entry) => `- ${entry.text}`).join('\n')}`)
  }
  if (proposals.length > 0) {
    sections.push([
      `## ${proposalHeader}`,
      proposals.map((proposal) => `- [${proposal.id}] ${proposal.track}/${proposal.scope}: ${proposal.text}`).join('\n'),
    ].join('\n'))
  }
  if (onDemand > 0) {
    sections.push(/** @type {(n: number) => string} */ (pick(WARMUP_DIRECTORY, language))(onDemand))
  }
  return [header, ...sections].join('\n\n')
}

/**
 * 渲染冻结快照全文（含每分组用量头）。无任何条目时返回空串——空段不进提示词，
 * 空记忆零 token 成本。带 pending 提案时追加提案块（模型可见 ⟺ 随快照文本
 * 进入 request/header.system，S2 可重建）。
 * @param {SnapshotEntry[]} entries - 会话可见条目。
 * @param {{user: {userGlobal: number, workspace: number}, agent: {userGlobal: number, workspace: number}}} budgets - Config.budgets。
 * @param {SnapshotProposal[]} [proposals] - 会话可见 pending 提案。
 * @param {string} [language] - 'en' | 'zh'（默认 en）。
 * @returns {string} 快照文本。
 */
export function renderSnapshot(entries, budgets, proposals = [], language = 'en') {
  const groups = groupEntries(entries)
  const report = budgetReport(entries, budgets)
  const titles = /** @type {Record<string, string>} */ (pick(GROUP_TITLES, language))
  const header = /** @type {string} */ (pick(SNAPSHOT_HEADER, language))
  const proposalHeader = /** @type {string} */ (pick(PROPOSAL_HEADER, language))
  const usageSuffix = language === 'zh' ? '已用字符（预警线）' : 'chars used (warning line)'
  const sections = []
  for (const track of TRACKS) {
    for (const scope of SCOPES) {
      const key = `${track}/${scope}`
      const list = groups.get(key)
      if (list === undefined || list.length === 0) continue
      const row = report.find((candidate) => candidate.track === track && candidate.scope === scope)
      sections.push(`## ${titles[key]} — ${row.used}/${row.limit} ${usageSuffix}\n${list.map((entry) => `- ${entry.text}`).join('\n')}`)
    }
  }
  if (proposals.length > 0) {
    sections.push([
      `## ${proposalHeader}`,
      proposals.map((proposal) => `- [${proposal.id}] ${proposal.track}/${proposal.scope}: ${proposal.text}`).join('\n'),
    ].join('\n'))
  }
  if (sections.length === 0) return ''
  return [header, ...sections].join('\n\n')
}

// lib/strings.mjs — 模型可见/命令面文案（零 DSH 依赖，纯数据）。
//
// 语言词表：en 为源文（冻结现状），zh 为本次新写的对应译文。渲染函数用
// pick(strings, language) 选表；语言词汇本身在 index.mjs 的 Config.language
// （默认 en，非法值加载期响亮失败）。

/**
 * /memory 命令文案（en 源文 / zh 译文；service.language 选择）。
 * @typedef {object} CommandTextBundle
 * @property {string} usage
 * @property {string} memoryEmpty
 * @property {(total: number, shown: number) => string} entries
 * @property {(total: number) => string} entriesFull
 * @property {string} queryNeedsWord
 * @property {(text: string) => string} noMatch
 * @property {(total: number, shown: number) => string} matches
 * @property {(total: number) => string} matchesFull
 * @property {string} budgets
 * @property {string} proposalsNone
 * @property {(n: number, rows: string) => string} proposalsList
 * @property {string} proposalsUsage
 * @property {(id: string) => string} proposalNotPending
 * @property {(track: string, scope: string, text: string, used: number, limit: number) => string} proposalApproved
 * @property {(id: string) => string} proposalDismissed
 * @property {string} auditEmpty
 * @property {(n: number) => string} audit
 * @property {string} addNeedsText
 * @property {(track: string, scope: string, text: string, used: number, limit: number) => string} added
 * @property {string} removeNeedsSubstring
 * @property {(track: string, scope: string, text: string, used: number, limit: number) => string} removed
 * @property {string} consolidateUsage
 * @property {string} consolidateNeedsMatches
 * @property {string} consolidateNeedsText
 * @property {(track: string, scope: string, removed: number, text: string, used: number, limit: number) => string} consolidated
 * @property {string} exportUsage
 * @property {string} importUsage
 * @property {string} importBadJson
 * @property {(path: string, message: string) => string} importReadFailed
 * @property {(schema: string) => string} importBadSchema
 * @property {string} importNoEntries
 * @property {(max: number) => string} importTooMany
 * @property {string} importBadEntry
 * @property {(n: number) => string} imported
 * @property {string} adaptersEmpty
 * @property {(n: number, rows: string) => string} adaptersList
 * @property {string} adapterExportUsage
 * @property {string} adapterImportUsage
 * @property {string} adapterServiceMissing
 * @property {string} adapterBadFlag
 * @property {(id: string) => string} adapterUnknown
 * @property {(id: string, message: string) => string} adapterPayload
 * @property {(n: number, id: string) => string} adapterImported
 * @property {string} observeUsage
 * @property {string} observeUnavailable
 * @property {string} observeHint
 * @property {(message: string) => string} observeFailed
 * @property {string} sessionUsage
 * @property {string} sessionNoId
 * @property {(id: string, state: string, statusOnly: boolean) => string} sessionState
 * @property {string} sessionOn
 * @property {string} sessionOff
 * @property {string} sessionToggleHintOn
 * @property {string} sessionToggleHintOff
 * @property {string} sessionOffRead
 * @property {string} restoreNeedsIds
 * @property {(n: number, text: string, used: number, limit: number) => string} restored
 * @property {string} arbitrateNeedsIds
 * @property {(facet: string, kept: string, demoted: number, used: number, limit: number) => string} arbitratedKeep
 * @property {(facet: string, n: number, tag: string) => string} arbitratedCoexist
 * @property {(verb: string) => string} unknownVerb
 * @property {(message: string) => string} commandFailed
 */
export const COMMAND_TEXT = /** @type {{en: CommandTextBundle, zh: CommandTextBundle}} */ ({
  en: {
    usage: 'Usage: /memory list | query <word> | add <text> | remove <substring> | consolidate <substring...> => <new text> | restore <id...> | arbitrate <id...> | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <path> | observe [--days=N] | session [on|off]',
    memoryEmpty: 'Memory is empty.',
    entries: (total, shown) => `Memory entries (${total} total, showing first ${shown}):`,
    entriesFull: (total) => `Memory entries (${total}):`,
    queryNeedsWord: 'query needs a keyword: /memory query <word>',
    noMatch: (text) => `No entry contains "${text}".`,
    matches: (total, shown) => `Matches (${total} total, showing first ${shown}):`,
    matchesFull: (total) => `Matches (${total}):`,
    budgets: 'Warning-line usage:',
    proposalsNone: 'No pending memory proposals.',
    proposalsList: (n, rows) => `Pending proposals (${n}):\n${rows}\nApprove: /memory proposals approve <id>; dismiss: /memory proposals dismiss <id>`,
    proposalsUsage: 'proposals usage: /memory proposals | proposals approve <id> | proposals dismiss <id>',
    proposalNotPending: (id) => `proposal ${JSON.stringify(id)} is not a pending proposal (decided or missing)`,
    proposalApproved: (track, scope, text, used, limit) => `Proposal approved and written to memory (${track}/${scope}): ${text}\nLayer usage: ${used}/${limit}`,
    proposalDismissed: (id) => `Proposal ${id} dismissed.`,
    auditEmpty: 'Audit is empty.',
    audit: (n) => `Recent audit (${n} rows):`,
    addNeedsText: 'add needs text: /memory add [--track=user|agent] [--scope=user-global|workspace] <text>',
    added: (track, scope, text, used, limit) => `Added (${track}/${scope}): ${text}\nLayer usage: ${used}/${limit}`,
    removeNeedsSubstring: 'remove needs a unique substring: /memory remove [--track=user|agent] [--scope=user-global|workspace] <substring>',
    removed: (track, scope, text, used, limit) => `Removed (${track}/${scope}): ${text}\nLayer usage: ${used}/${limit}`,
    consolidateUsage: 'consolidate usage: /memory consolidate [--track=user|agent] [--scope=user-global|workspace] <substring1> [<substring2> ...] => <new text>',
    consolidateNeedsMatches: 'consolidate needs 1..20 unique substrings (left of =>)',
    consolidateNeedsText: 'consolidate needs new text (right of =>)',
    consolidated: (track, scope, removed, text, used, limit) => `Consolidated (${track}/${scope}): removed ${removed}, added 1.\nNew entry: ${text}\nLayer usage: ${used}/${limit}`,
    sessionUsage: 'session usage: /memory session | /memory session on | /memory session off',
    sessionNoId: 'session: this invocation carries no session id (the command always runs inside a session; retry from the composer).',
    sessionState: (id, state, statusOnly) => `Session ${id}: memory ${state}.${statusOnly ? '' : ' Switched.'}`,
    sessionOn: 'ON (inject + recall + write)',
    sessionOff: 'OFF (no injection, no recall, no writes, no observation)',
    sessionToggleHintOn: 'Turn it off when this conversation should leave no trace: /memory session off',
    sessionToggleHintOff: 'Turn it back on: /memory session on',
    sessionOffRead: 'This session has memory switched off, so query is refused. /memory list, budgets and audit stay available (management reads are not affected); /memory session on re-enables memory for this session.',
    exportUsage: 'export dumps all entries + budgets as one JSON document (read-only; redirect it to a file for backup/migration): /memory export',
    importUsage: 'import restores entries from an export document (a file path, or inline JSON starting with {): /memory import <path> | /memory import \'{"plugin":"dsh-memento",...}\'',
    importBadJson: 'import: inline JSON could not be parsed',
    importReadFailed: (path, message) => `import: cannot read ${JSON.stringify(path)}: ${message}`,
    importBadSchema: (schema) => `import: not a dsh-memento export document (expected schema "${schema}")`,
    importNoEntries: 'import: the export document contains no entries',
    importTooMany: (max) => `import: the export document has more than ${max} entries; split it and import in batches`,
    importBadEntry: 'import: every entry needs a string track, scope, and non-empty text',
    imported: (n) => `Imported ${n} entries into memory (single approval). Entries get fresh ids and timestamps; proposals, audit rows and recall counts are not migrated.`,
    adaptersEmpty: 'No memory adapters registered.',
    adaptersList: (n, rows) => `Memory adapters (${n}):\n${rows}\nImport: /memory import --adapter=<id> <path|inline JSON>; export: /memory export --adapter=<id>`,
    adapterExportUsage: 'adapter export usage: /memory export --adapter=<id> (read-only conversion to stdout)',
    adapterImportUsage: 'adapter import usage: /memory import --adapter=<id> <file path> (or inline JSON starting with {)',
    adapterServiceMissing: 'memory adapter registry is unavailable in this profile',
    adapterBadFlag: 'adapter id missing or invalid: use --adapter=<id> (lowercase kebab-case)',
    adapterUnknown: (id) => `no memory adapter "${id}" is registered; run /memory adapters`,
    adapterPayload: (id, message) => `adapter ${id} rejected the payload: ${message}`,
    adapterImported: (n, id) => `Imported ${n} entries via adapter ${id} (single approval). Entries get fresh ids and timestamps.`,
    observeUsage: 'observe usage: /memory observe [--days=N] [--sessions=N] [--per-session=N] [--chars=N] [--budget=N] — read-only scan of your own past messages (no approval, no writes). Parameters are clamped to the hard limits; the output states what was NOT covered. To have the model infer from it, just say "observe me".',
    observeUnavailable: 'observe: this profile provides no session-query service, so conversation history cannot be read.',
    observeHint: 'Hand this slice to the model for inference: say "observe me" (the yammory-observe skill drives memory_observe commit through the approval gate). This command itself only reads — nothing was written.',
    observeFailed: (message) => `observe scan failed: ${message}`,
    unknownVerb: (verb) => `Unknown subcommand "${verb}". Usage: /memory list | query <word> | add <text> | remove <substring> | consolidate <substring...> => <new text> | restore <id...> | arbitrate <id...> | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <path> | observe [--days=N] | session [on|off]`,
    commandFailed: (message) => `memory command failed: ${message}`,
    restoreNeedsIds: 'restore needs 1..20 entry ids: /memory restore <id> [<id> ...] (ids come from a tidy plan or /memory list; only superseded entries can be restored)',
    restored: (n, text, used, limit) => `Restored ${n} entr${n === 1 ? 'y' : 'ies'} to active (back to every session\u2019s view, version untouched): ${text}\nLayer usage: ${used}/${limit}`,
    arbitrateNeedsIds: 'arbitrate needs 1..20 entry ids covering both sources: /memory arbitrate <id> [<id> ...] (the direction comes from the arbitration table — ability follows observation, preference follows self-report, the other five facets keep both with a `gap` tag)',
    arbitratedKeep: (facet, kept, demoted, used, limit) => `Arbitrated on ${facet}: kept ${kept}, demoted ${demoted} (kept on disk, out of every session\u2019s view; restore brings them back)\nLayer usage: ${used}/${limit}`,
    arbitratedCoexist: (facet, n, tag) => `Arbitrated on ${facet}: coexist — nothing was demoted, ${n} entr${n === 1 ? 'y' : 'ies'} tagged \`${tag}\` (the gap itself is the evidence)`,
  },
  zh: {
    usage: '用法：/memory list | query <词> | add <文本> | remove <唯一子串> | consolidate <唯一子串...> => <新文本> | restore <id...> | arbitrate <id...> | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <路径> | observe [--days=N] | session [on|off]',
    memoryEmpty: '记忆为空。',
    entries: (total, shown) => `记忆条目（共 ${total} 条，显示前 ${shown} 条）：`,
    entriesFull: (total) => `记忆条目（${total} 条）：`,
    queryNeedsWord: 'query 需要一个关键词：/memory query <词>',
    noMatch: (text) => `没有条目包含「${text}」。`,
    matches: (total, shown) => `命中（共 ${total} 条，显示前 ${shown} 条）：`,
    matchesFull: (total) => `命中（${total} 条）：`,
    budgets: '预警线用量：',
    proposalsNone: '暂无待审批记忆提案。',
    proposalsList: (n, rows) => `待审批提案（${n} 条）：\n${rows}\n审批：/memory proposals approve <id>；驳回：/memory proposals dismiss <id>`,
    proposalsUsage: 'proposals 用法：/memory proposals | proposals approve <id> | proposals dismiss <id>',
    proposalNotPending: (id) => `proposal ${JSON.stringify(id)} 不是待审批提案（可能已裁决或不存在）`,
    proposalApproved: (track, scope, text, used, limit) => `已批准提案并写入记忆（${track}/${scope}）：${text}\n该层用量：${used}/${limit}`,
    proposalDismissed: (id) => `已驳回提案 ${id}。`,
    auditEmpty: '审计为空。',
    audit: (n) => `最近审计（${n} 条）：`,
    addNeedsText: 'add 需要文本：/memory add [--track=user|agent] [--scope=user-global|workspace] <文本>',
    added: (track, scope, text, used, limit) => `已添加（${track}/${scope}）：${text}\n该层用量：${used}/${limit}`,
    removeNeedsSubstring: 'remove 需要一个唯一子串：/memory remove [--track=user|agent] [--scope=user-global|workspace] <唯一子串>',
    removed: (track, scope, text, used, limit) => `已删除（${track}/${scope}）：${text}\n该层用量：${used}/${limit}`,
    consolidateUsage: 'consolidate 用法：/memory consolidate [--track=user|agent] [--scope=user-global|workspace] <唯一子串1> [<唯一子串2> ...] => <新文本>',
    consolidateNeedsMatches: 'consolidate 需要 1..20 个唯一子串（=> 左侧）',
    consolidateNeedsText: 'consolidate 需要新文本（=> 右侧）',
    consolidated: (track, scope, removed, text, used, limit) => `已整合（${track}/${scope}）：删除 ${removed} 条，新增 1 条。\n新条目：${text}\n该层用量：${used}/${limit}`,
    sessionUsage: 'session 用法：/memory session | /memory session on | /memory session off',
    sessionNoId: 'session：本次调用没有携带会话 id（命令总在会话内执行；请在输入框里重试）。',
    sessionState: (id, state, statusOnly) => `会话 ${id}：记忆${state}。${statusOnly ? '' : '已切换。'}`,
    sessionOn: '开启（注入 + 召回 + 写入）',
    sessionOff: '已关闭（不注入、不召回、不写入、不观察）',
    sessionToggleHintOn: '想让这段对话不留痕，就关掉它：/memory session off',
    sessionToggleHintOff: '想恢复记忆：/memory session on',
    sessionOffRead: '本会话已关闭记忆，query 被拒绝。/memory list、budgets、audit 仍然可用（管理面只读不受影响）；/memory session on 可为本会话重新开启记忆。',
    exportUsage: 'export 把所有条目 + 预算导出为一份 JSON 文档（只读；可重定向到文件做备份/迁移）：/memory export',
    importUsage: 'import 从导出文档恢复条目（文件路径，或以 { 开头的内联 JSON）：/memory import <路径> | /memory import \'{"plugin":"dsh-memento",...}\'',
    importBadJson: 'import：内联 JSON 无法解析',
    importReadFailed: (path, message) => `import：无法读取 ${JSON.stringify(path)}：${message}`,
    importBadSchema: (schema) => `import：不是 dsh-memento 导出文档（要求 schema "${schema}"）`,
    importNoEntries: 'import：导出文档没有任何条目',
    importTooMany: (max) => `import：导出文档超过 ${max} 条；请拆分后分批导入`,
    importBadEntry: 'import：每条都需要字符串 track、scope 与非空 text',
    imported: (n) => `已导入 ${n} 条记忆（单次审批）。条目获得新 id 与新时间戳；提案、审计行与召回计数不迁移。`,
    adaptersEmpty: '没有已注册的记忆适配器。',
    adaptersList: (n, rows) => `记忆适配器（${n} 个）：\n${rows}\n导入：/memory import --adapter=<id> <路径|内联 JSON>；导出：/memory export --adapter=<id>`,
    adapterExportUsage: '适配器导出用法：/memory export --adapter=<id>（只读转换输出到 stdout）',
    adapterImportUsage: '适配器导入用法：/memory import --adapter=<id> <文件路径>（或以 { 开头的内联 JSON）',
    adapterServiceMissing: '当前 profile 没有记忆适配器注册表',
    adapterBadFlag: '适配器 id 缺失或非法：请用 --adapter=<id>（小写 kebab-case）',
    adapterUnknown: (id) => `没有注册记忆适配器「${id}」；请运行 /memory adapters`,
    adapterPayload: (id, message) => `适配器 ${id} 拒绝了载荷：${message}`,
    adapterImported: (n, id) => `已通过适配器 ${id} 导入 ${n} 条记忆（单次审批）。条目获得新 id 与新时间戳。`,
    observeUsage: 'observe 用法：/memory observe [--days=N] [--sessions=N] [--per-session=N] [--chars=N] [--budget=N]——只读扫描你自己的旧发言（无审批、不写入）。参数会被夹到硬上限；输出会写明「没看到哪些」。想让模型据此推断，直接说「观察一下我」。',
    observeUnavailable: 'observe：本 profile 未提供 session-query 服务，读不到会话历史。',
    observeHint: '把这段交给模型推断：说「观察一下我」（yammory-observe skill 会引导 memory_observe commit 走审批门落库）。本命令自身只读，没有写入任何东西。',
    observeFailed: (message) => `observe 扫描失败：${message}`,
    unknownVerb: (verb) => `未知子命令「${verb}」。用法：/memory list | query <词> | add <文本> | remove <唯一子串> | consolidate <唯一子串...> => <新文本> | restore <id...> | arbitrate <id...> | proposals [approve|dismiss <id>] | budgets | audit | adapters | export [--adapter=<id>] | import [--adapter=<id>] <路径> | observe [--days=N] | session [on|off]`,
    commandFailed: (message) => `memory 命令失败：${message}`,
    restoreNeedsIds: 'restore 需要 1..20 个条目 id：/memory restore <id> [<id> ...]（id 取自整理计划或 /memory list；只有已降级的条目能被救回）',
    restored: (n, text, used, limit) => `已恢复 ${n} 条为在场状态（重新进入每个会话的可见集，version 不动）：${text}\n该层用量：${used}/${limit}`,
    arbitrateNeedsIds: 'arbitrate 需要 1..20 个覆盖两个来源的条目 id：/memory arbitrate <id> [<id> ...]（方向由裁决表决定——能力听观察、意愿听自陈，其余五面两条都留并各打 `gap` 标）',
    arbitratedKeep: (facet, kept, demoted, used, limit) => `已按「${facet}」面裁决：保留 ${kept}，降级 ${demoted} 条（留在库里，退出可见集；可用 restore 救回）\n该层用量：${used}/${limit}`,
    arbitratedCoexist: (facet, n, tag) => `已按「${facet}」面裁决：coexist——一条都没降级，${n} 条各打 \`${tag}\` 标（落差本身即证据）`,
  },
})

/** 命令注册描述与输入提示（双语）。 */


/** 快照冻结说明头。 */
export const SNAPSHOT_HEADER = {
  en: '[yammory_system: frozen memory snapshot — captured at session start; memory changes during this session do not update this block. To change memory, use the memory tool.]',
  zh: '[yammory_system：冻结记忆快照——会话启动时捕获；本会话内的记忆变更不更新此块。要修改记忆，请使用 memory 工具。]',
}

/** 快照分组标题（模型可见；en 与 DSH 核心提示一致，zh 为对应译文）。 */
export const GROUP_TITLES = {
  en: {
    'user/user-global': 'User profile (global preferences, communication style, landmines)',
    'user/workspace': 'User preferences for this workspace',
    'agent/user-global': 'Environment facts and conventions (cross-workspace)',
    'agent/workspace': 'Workspace facts, conventions, and lessons',
  },
  zh: {
    'user/user-global': '用户画像（全局偏好、沟通风格、雷区）',
    'user/workspace': '本工作区的用户偏好',
    'agent/user-global': '环境事实与约定（跨工作区）',
    'agent/workspace': '本工作区的事实、约定与教训',
  },
}

/** 快照待审批提案块标题。 */
export const PROPOSAL_HEADER = {
  en: 'Pending memory proposals (reviewed by the user; approve or dismiss via the /memory proposals command)',
  zh: '待审批记忆提案（由用户裁决；用 /memory proposals 命令 approve 或 dismiss）',
}

/** 预热段说明头（分路注入的「普遍相关」半边：与话题无关、每次会话都该在场的内容）。 */
export const WARMUP_HEADER = {
  en: '[yammory_system: warm-up block — the stable half of memory (speaking constraints + standing profile), frozen at session start. Workspace- and task-specific memory is NOT here: fetch it on demand with the memory_recall tool.]',
  zh: '[yammory_system：预热块——记忆里稳定的一半（表达约束 ＋ 常驻画像），会话启动时冻结。工作区与任务相关的记忆不在此块：需要时用 memory_recall 工具按需取。]',
}

/** 表达约束段标题。 */
export const CONSTRAINT_HEADER = {
  en: 'Speaking constraints',
  zh: '表达约束',
}

/** 常驻画像分组标题（预热段里 user-global 那半边；与 GROUP_TITLES 同义，独立成键以便分路渲染）。 */
export const WARMUP_PROFILE_TITLE = {
  en: 'Standing profile (cross-workspace preferences, communication style, landmines)',
  zh: '常驻画像（跨工作区的偏好、沟通风格、雷区）',
}

/**
 * 预热段末行的「一行目录」（S4b-6）：把不进预热的那半边（workspace 层 ＋ agent 轨）
 * 折成一个数字，让模型知道「这里还有东西可按需取」。只报条数，不搬内容。
 */
export const WARMUP_DIRECTORY = {
  en: (/** @type {number} */ n) => `${n} more workspace / agent-track entr${n === 1 ? 'y stays' : 'ies stay'} out of this block — fetch them on demand with memory_recall.`,
  zh: (/** @type {number} */ n) => `本工作区与 agent 轨另有 ${n} 条记忆不在本块——需要时用 memory_recall 取。`,
}

/** 四档说话要求词表（档位键固定为 KNOWLEDGE_TIERS；表到 level 的映射在 lib/constraint.mjs）。 */
export const TIER_VOICE = {
  en: {
    科普: 'No jargon; define any term you must use, on the spot; analogies throughout; short and shallow, conclusion first.',
    本科: 'Common terms as-is, rare ones explained in passing; analogies in moderation; medium length, reasoning allowed.',
    硕士: 'Terms free; few analogies; may go deep.',
    专家: 'Terms free including shorthand and acronyms; almost no analogies; complete, with boundaries and uncertainties stated.',
  },
  zh: {
    科普: '不用术语，非用不可就当场解释；大量类比；短、浅、先给结论。',
    本科: '常用术语直接用，生僻的随手解释；适度类比；中等篇幅，可带推理。',
    硕士: '术语自由；少用类比；可深入。',
    专家: '术语自由，含行话与缩写；几乎不用类比；完整，含边界与不确定。',
  },
}

/**
 * 按语言选文案表（未知语言回退 en；调用方已在加载期校验词汇）。
 * @param {Record<string, unknown>} table - 语言键 → 文案。
 * @param {string} language - 'en' | 'zh'。
 * @returns {unknown} 所选文案。
 */
export function pick(table, language) {
  return table[language] ?? table.en
}

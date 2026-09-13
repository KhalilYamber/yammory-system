// lib/constants.mjs — yammory_system 词汇表与协议常量（零 DSH 依赖）。
//
// 本文件只放协议级常量（词汇、错误码、存储格式版本）。部署可调参数一律走
// index.mjs 的 Schemastery Config，绝不在此写死 tunable。

/** 记忆轨道（双轨分家）：user=用户画像，agent=环境事实/约定/教训。 */
export const TRACKS = /** @type {readonly ['user', 'agent']} */ (['user', 'agent'])

/** 分层作用域：user-global 跨工作区，workspace 按会话 cwd。 */
export const SCOPES = /** @type {readonly ['user-global', 'workspace']} */ (['user-global', 'workspace'])

/** 七面多边形固定板块（用户画像的七个「面」，条目 facet 词汇；定稿自 docs/改造蓝图.md 第一节）。 */
export const PROFILE_FACETS = /** @type {readonly string[]} */ ([
  '躯体', '心智', '价值与意愿', '能力与技能', '行为与习惯', '社会与处境', '经历与轨迹',
])

/** 条目状态（soft delete 预留）：active=在用，superseded=已废弃。S1 只落列与迁移，回滚语义留 S5。 */
export const ENTRY_STATUSES = /** @type {readonly ['active', 'superseded']} */ (['active', 'superseded'])

/** 八大类知识领域及其子领域（定稿自 docs/知识领域清单.md，定死不再增删）。清单逐行实数为 31 个子领域，文末「27」为笔误。 */
export const KNOWLEDGE_CATEGORIES = /** @type {readonly (readonly [string, readonly string[]])[]} */ ([
  ['语言', ['中文', '英语', '其他外语']],
  ['数理与逻辑', ['数学', '统计与概率', '逻辑与推理']],
  ['自然科学', ['物理', '化学', '生物与医学', '地球与天文']],
  ['工程与技术', ['计算机与编程', 'AI 与数据', '电子与硬件', '工程与制造']],
  ['人文与社会', ['历史', '地理', '哲学', '经济与金融', '法律与政治', '心理与教育']],
  ['艺术与审美', ['文学', '音乐', '美术与设计', '影视与游戏']],
  ['生活与实务', ['健康与养生', '饮食与烹饪', '理财与消费', '人际与沟通']],
  ['元能力', ['学习方法', '信息检索与辨别', 'AI 与工具使用']],
])

/** 子领域扁平清单（profile 表的领域刻度，共 31 项；见上：清单文末「27」为笔误）。 */
export const KNOWLEDGE_DOMAINS = /** @type {readonly string[]} */ (KNOWLEDGE_CATEGORIES.flatMap(([, domains]) => domains))

/** 知识水平四档（level 1–10 的分档锚点，定稿自 docs/知识领域清单.md）。 */
export const KNOWLEDGE_TIERS = /** @type {readonly ['科普', '本科', '硕士', '专家']} */ (['科普', '本科', '硕士', '专家'])

/**
 * level(1–10) → tier 四档的稳定映射（tier 可由 level 推导；profile 落库时缺省 tier 即用此推导）。
 * @param {number} level - 知识水平（1–10）。
 * @returns {'科普' | '本科' | '硕士' | '专家'} 对应档位。
 */
export function tierForLevel(level) {
  if (level <= 3) return '科普'
  if (level <= 6) return '本科'
  if (level <= 8) return '硕士'
  return '专家'
}

/** 写策略（Config.writePolicy）：ask=用户审批，auto=放行但记录审批来源，off=拒绝。 */
export const WRITE_POLICIES = ['ask', 'auto', 'off']

/** 审批请求里标识本插件记忆写动作的工具名（审批 answerer 据此认领请求）。 */
export const TOOL_NAME = 'memory'

/** 审批 reason 前缀（含方括号）：answerer 只认领带本前缀的 memory 写请求，防止误伤同工具名的其它请求。 */
export const REQUEST_MARKER = '[yammory_system]'

/** 记忆库 schema 版本（单调递增；旧版逐级迁移，新版响亮拒绝）。v2 = proposals 提案表；v3 = agent_key + 召回排序列；v4 = tags + version（协议 v1 条目规范）；v5 = facet/level/status 列 + profile 表（七面多边形 + 分领域知识水平 + soft delete 预留）。 */
export const SCHEMA_VERSION = 5

/** 数据库文件名（位于 $DSH_HOME/dsh-memento/ 下）。 */
export const DEFAULT_DB_NAME = 'memory.db'

/** 条目默认来源标注（seed 写 source: 'claude' 时除外）。 */
export const DEFAULT_SOURCE = 'dsh-memento'

/** Provider 层查询返回硬上限：显式 limit 的钳制天花板（防模型/面板拉爆上下文）。 */
export const MAX_QUERY_LIMIT = 1000

/** 面板审计路由的返回上限：只读抽屉的审计尾展示天花板（协议常量，非部署 tunable）。 */
export const PANEL_AUDIT_CEILING = 200

/** /memory export 文档的 schema 标记（export 与 import 共用；import 只认本标记）。 */
export const EXPORT_SCHEMA = 'memory-export-v1'

/** /memory import 单次导入条目数上限：防一次性灌入海量条目把审批载荷撑爆（协议常量）。 */
export const MAX_IMPORT_ENTRIES = 1000

/** consolidate 单次整合的定位子串数上限（协议写语义，Provider 与协议核心共用）。 */
export const MAX_CONSOLIDATE_MATCHES = 20

/** 结构化错误码：工具与面板据此分支，模型据此决定"整合后重试"还是"放弃"。 */
export const ERROR_CODES = {
  DISABLED: 'MEMORY_DISABLED',
  INVALID_INPUT: 'INVALID_INPUT',
  NO_AGENT: 'WRITE_REQUIRES_AGENT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  WRITE_DENIED: 'WRITE_DENIED',
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  STORE_CORRUPT: 'STORE_CORRUPT',
  STORE_UNSUPPORTED_VERSION: 'STORE_UNSUPPORTED_VERSION',
  ADAPTER_NOT_FOUND: 'ADAPTER_NOT_FOUND',
  ADAPTER_PAYLOAD: 'ADAPTER_PAYLOAD',
  EMBEDDING_NOT_FOUND: 'EMBEDDING_NOT_FOUND',
  RETRIEVAL_NOT_FOUND: 'RETRIEVAL_NOT_FOUND',
}

/** 会话事件名（SessionEventMap 声明合并的词汇表；运行时按已知类型自适应派发）。 */
export const SESSION_EVENTS = {
  added: 'memory/added',
  updated: 'memory/updated',
  removed: 'memory/removed',
  recalled: 'memory/recalled',
  snapshot: 'memory/snapshot',
}

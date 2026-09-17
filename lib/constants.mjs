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

/** 条目状态（soft delete）：active=在用，superseded=已废弃（留痕）。降级与回滚两侧见 S5。 */
export const ENTRY_STATUSES = /** @type {readonly ['active', 'superseded']} */ (['active', 'superseded'])

/** 在场状态值（读路径与会话可见集的谓词；降级/回滚两侧共用，避免裸字面量散落）。 */
export const ACTIVE_STATUS = 'active'

/** 降级状态值（soft delete 的留痕侧：可回滚，绝不物理删）。 */
export const SUPERSEDED_STATUS = 'superseded'

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

/**
 * 记忆库 schema 版本（单调递增；旧版逐级迁移，新版响亮拒绝）。
 * v2 = proposals 提案表；v3 = agent_key + 召回排序列；v4 = tags + version（协议 v1 条目规范）；
 * v5 = facet/level/status 列 + profile 表（七面多边形 + 分领域知识水平 + soft delete 预留）；
 * v6 = session_switch 表（会话级记忆开关；只存「关」的行）；
 * v7 = tidy_requests 表（面板「整理全库」的排队标记；pending → done 单向，绝不碰条目）；
 * v8 = entries.batch_id / audit.batch_id（自动整理批次标识；批次只读查询与留痕重建用）。
 */
export const SCHEMA_VERSION = 8

/**
 * 会话级记忆开关的默认值（F5）：无行即开。
 * 表里只保留 enabled=0 的「关」行（重开即删行），因此「默认开」既是缺省语义也是唯一写入语义。
 */
export const SESSION_DEFAULT_ENABLED = true

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

/**
 * 把握分级三档（自动整理的判定输出面）：auto=够确定，机械可判，可直接合；
 * review=不够确定，进待批单子；skip=不合格，原地不动。
 */
export const MERGE_VERDICTS = /** @type {readonly ['auto', 'review', 'skip']} */ (['auto', 'review', 'skip'])

/**
 * 把握分级的五根硬杠名（判定依据的复述用语，唯一出处）：
 * - `same-bucket`：同桶（track × scope × agentKey，workspace 层再加 workspaceKey）；
 * - `member-count`：成员数落在 [2, maxMembers]；
 * - `verbatim`：去掉空白、标点与符号后，成员与拟合并文本**逐字一致**——auto 档的守门杠；
 * - `similarity`：两两 Jaccard 的最小值（字面重合度，复用 lib/stats.mjs 口径）；
 * - `coverage`：拟合并文本对每条源条目的词元覆盖率的最小值（信息不丢）。
 */
export const MERGE_GATES = Object.freeze({
  sameBucket: 'same-bucket',
  memberCount: 'member-count',
  verbatim: 'verbatim',
  similarity: 'similarity',
  coverage: 'coverage',
})

/**
 * 分级阈值（协议常量，非部署 tunable）：判定不变量，故不落 Config。
 * 取值保守——宁可多产单子，少自动合。`reviewSimilarity` 与整理计划的提示线
 * `PAIR_HINT_THRESHOLD`（lib/consolidate.mjs）同值；两处含义不同（一处是分档底线，
 * 一处是给模型看的线索线），故各自保留、互不引用。
 * 实测口径：字面几乎相同（改标点）落在 0.89，字面部分重合落在 0.57，
 * 改写过的同义句落在 0.11——本表只承担字面判断，语义判断归会话里的模型。
 */
export const MERGE_GRADE_LINES = Object.freeze({
  maxMembers: 5,
  autoSimilarity: 0.85,
  reviewSimilarity: 0.5,
  autoCoverage: 0.9,
  reviewCoverage: 0.6,
})

/**
 * 条目 id 形状：UUID v4。下沉到这里（而非留在 lib/protocol.mjs）是为了让 store 的插入口
 * 能用同一条形状判据拒绝畸形 id——Provider 与协议层各写一份正则，迟早各说各话。
 */
export const ENTRY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * 「已整理」标记（规格 3.5.11）：整理产出的条目恒带此标，下次整理见到就跳过。
 * 定义在最底层（而非 lib/protocol.mjs）是为了断开一处环：protocol 要用分级函数、
 * consolidate 要用这个标，常量下沉后两边各取所需、互不 import。
 * `lib/protocol.mjs` 仍 re-export 同一绑定，对外导出面一字不变。
 */
export const MERGED_TAG = 'merged'

/** 会话开关路由的 sessionId 长度上限（协议常量）：超长 id 一律 400，不进库也不进审计。 */
export const MAX_SWITCH_SESSION_ID = 200

/**
 * 观察通道（memory_observe）的硬上限（协议常量，非部署 tunable）：
 * 模型传再大的 days/sessions 也放大不过这里——预算是闸门，不是建议。
 * 默认值（更保守）走 index.mjs 的 Config.observe。
 */
export const OBSERVE_LIMITS = Object.freeze({
  days: 90,
  sessions: 20,
  perSession: 20,
  messageChars: 800,
  totalChars: 30000,
})

/** 观察通道的可钳制参数键（顺序即 resolveObserveOptions 的遍历顺序）。 */
export const OBSERVE_KEYS = Object.freeze(['days', 'sessions', 'perSession', 'messageChars', 'totalChars'])

/**
 * 五个「仅观察」子板块及其所属顶层七面（S 集合，施工清单第三节）。
 * 落库口径（方案 7.1 裁决 (a)）：facet 取七面值，子板块进 tags——零 schema 改动。
 */
export const OBSERVATION_FACES = Object.freeze({
  思维方式与思辨: '心智',
  人格特质: '心智',
  情绪模式与心理强度: '心智',
  自我认知: '价值与意愿',
  决策与行动风格: '行为与习惯',
})

/** 「校正」面：观察补充非 S 面时的标记（不进 facet，只在 tags 里标来源）。 */
export const OBSERVATION_CORRECTION = '校正'

/** 观察面的合法取值（五个仅观察子板块 ＋ 「校正」）。 */
export const OBSERVATION_FACE_VALUES = Object.freeze([...Object.keys(OBSERVATION_FACES), OBSERVATION_CORRECTION])

/** 观察写入的 source 值（自由字符串，无需动 schema；粒度键 `source:observation` 与它对齐）。 */
export const OBSERVATION_SOURCE = 'observation'

/** 观察条目的固定标签（与子板块标签、日期标签并列）。 */
export const OBSERVATION_TAG = 'observation'

/** 一次 commit 的观察条目数上限：审批载荷与「宁少勿多」纪律的双重闸（提示词另有「至多 3 条」的软纪律）。 */
export const MAX_OBSERVATION_ENTRIES = 8

/**
 * 无人值守轮的任务文本标记（闸二的自产文本窄排除）：定时轮由系统计划任务唤起，它的位置
 * 参数会被内核记成一条 `user/message`（`source.kind === 'user'`）。不过滤的话，观察轮自己的
 * 任务说明就会混进下一轮切片当「用户证据」。任务文本以本标记开头即排除，并计入账单的
 * `injected`——排除是响亮的，不是静默丢弃。人若手打这句也一样被排除，故标记取得不易误触。
 */
export const SCHEDULED_ROUND_MARKER = '【无人值守轮】'

/**
 * 分面裁决表（S5 §2.1，口径唯一出处）：同一件事上「观察」与「自陈」冲突时听谁。
 * - `observation`：听观察组，降自陈组（做得到就是做得到）；
 * - `self-report`：听自陈组，降观察组（喜好只有本人说了算）；
 * - `coexist`：都不降级，两组各打 `gap` 标（落差本身是证据，两条都留）。
 * 表即方向——`arbitrate` 不接受调用方反向指定，故「能力听观察」是代码不变量而非纪律。
 * 只覆盖七个 facet 值；facet 为空/未知一律响亮拒绝，不猜。
 */
export const ARBITRATION_BY_FACET = Object.freeze({
  能力与技能: 'observation',
  价值与意愿: 'self-report',
  躯体: 'coexist',
  心智: 'coexist',
  行为与习惯: 'coexist',
  社会与处境: 'coexist',
  经历与轨迹: 'coexist',
})

/** 裁决方向：听观察组（能力类）。 */
export const ARBITRATION_OBSERVATION = 'observation'

/** 裁决方向：听自陈组（意愿类）。 */
export const ARBITRATION_SELF_REPORT = 'self-report'

/** 裁决方向：两组并存（其余五面；都不降级，各打 gap 标）。 */
export const ARBITRATION_COEXIST = 'coexist'

/** 落差标：coexist 两条都留时各打一枚（落差是证据，不是噪声）。 */
export const GAP_TAG = 'gap'

/** 每条目的标签数上限（协议常量，非部署 tunable；Provider 与协议核心共用同一出处）。 */
export const MAX_TAGS_PER_ENTRY = 16

/** 单个标签字符数上限（JS 字符，协议常量）。 */
export const MAX_TAG_LENGTH = 32

/**
 * 经验条目的话题标判据（预热段末行的经验目录用；客户端面板的同一判据另存一份于
 * `client/client.js` 的 RESERVED_TOPIC_TAGS——那边是零构建 classic script，无法
 * import 本文件。改这里时同步改那边）。
 * 保留词 = 机器写的观察/整理/裁决标与分类标；另加日期标形状（观察条目自带）。
 */
export const EXPERIENCE_TOPIC_RESERVED_TAGS = Object.freeze(['observation', 'merged', 'gap', 'A-开发相关', 'B-非开发'])

/** 日期标形状（`YYYY-MM-DD`；观察条目自带，不算话题）。 */
export const EXPERIENCE_DATE_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 预热段末行的经验目录最多列几个话题（协议常量，非部署 tunable：冻结块要短）。 */
export const WARMUP_TOPIC_CAP = 8

/** 全部合法裁决方向（表值域；写入常量即自检，见 assertArbitrationTable）。 */
const ARBITRATION_DIRECTIONS = Object.freeze([ARBITRATION_OBSERVATION, ARBITRATION_SELF_REPORT, ARBITRATION_COEXIST])

/**
 * 裁决表自检（模块顶层调用一次）：键必须逐值等于七面、值必须是三个合法方向。
 * 表与七面脱节时响亮抛出——「facet 为空/未知一律拒绝」那条纪律才有兜底。
 * @returns {void} 一致时不返回内容。
 */
export function assertArbitrationTable() {
  const declared = Object.keys(ARBITRATION_BY_FACET)
  if (declared.length !== PROFILE_FACETS.length || PROFILE_FACETS.some((facet) => !declared.includes(facet))) {
    throw new Error(`yammory_system constants: ARBITRATION_BY_FACET keys [${declared.join('|')}] must cover exactly PROFILE_FACETS [${PROFILE_FACETS.join('|')}]`)
  }
  for (const [facet, direction] of Object.entries(ARBITRATION_BY_FACET)) {
    if (!ARBITRATION_DIRECTIONS.includes(direction)) {
      throw new Error(`yammory_system constants: ARBITRATION_BY_FACET[${facet}] = ${JSON.stringify(direction)} is not one of ${ARBITRATION_DIRECTIONS.join('|')}`)
    }
  }
}

assertArbitrationTable()


/** 结构化错误码：工具与面板据此分支，模型据此决定"整合后重试"还是"放弃"。 */
export const ERROR_CODES = {
  DISABLED: 'MEMORY_DISABLED',
  INVALID_INPUT: 'INVALID_INPUT',
  NO_AGENT: 'WRITE_REQUIRES_AGENT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  STALE_WRITE: 'STALE_WRITE',
  WRITE_DENIED: 'WRITE_DENIED',
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  STORE_CORRUPT: 'STORE_CORRUPT',
  STORE_UNSUPPORTED_VERSION: 'STORE_UNSUPPORTED_VERSION',
  ADAPTER_NOT_FOUND: 'ADAPTER_NOT_FOUND',
  ADAPTER_PAYLOAD: 'ADAPTER_PAYLOAD',
  EMBEDDING_NOT_FOUND: 'EMBEDDING_NOT_FOUND',
  RETRIEVAL_NOT_FOUND: 'RETRIEVAL_NOT_FOUND',
  SESSION_QUERY_UNAVAILABLE: 'SESSION_QUERY_UNAVAILABLE',
  SESSION_MEMORY_OFF: 'SESSION_MEMORY_OFF',
}

/** 会话事件名（SessionEventMap 声明合并的词汇表；运行时按已知类型自适应派发）。 */
export const SESSION_EVENTS = {
  added: 'memory/added',
  updated: 'memory/updated',
  removed: 'memory/removed',
  recalled: 'memory/recalled',
  snapshot: 'memory/snapshot',
}

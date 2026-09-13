// lib/strings.mjs — 模型可见/命令面文案（零 DSH 依赖，纯数据）。
//
// 语言词表：en 为源文（冻结现状），zh 为本次新写的对应译文。渲染函数用
// pick(strings, language) 选表；语言词汇本身在 index.mjs 的 Config.language
// （默认 en，非法值加载期响亮失败）。

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

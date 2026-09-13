// lib/constraint.mjs — 表达约束生成（零 DSH 依赖，纯函数）。
//
// 把 profile 表的分领域知识水平（1–10）经四档映射翻译成一段「说话要求」，供
// 预热段注入。四档锚点与说话要求定稿自 施工清单.md 第四节 4.1 表：1–3 科普 /
// 4–6 本科（默认锚点）/ 7–8 资深 / 9–10 专家。
//
// 档位词汇与 tierForLevel 在 lib/constants.mjs（S1 已建，本模块不改动它）；
// 说话要求的文案在 lib/strings.mjs。两张表的分档边界必须一致——漂移会在本模块
// 加载期响亮抛出（assertTierRules），不静默产错档。

import { KNOWLEDGE_TIERS, tierForLevel } from './constants.mjs'
import { TIER_VOICE, CONSTRAINT_HEADER, pick } from './strings.mjs'

/**
 * @typedef {object} TierRule - 一档的锚点与说话要求。
 * @property {'科普'|'本科'|'硕士'|'专家'} tier - 档位名（KNOWLEDGE_TIERS 之一）。
 * @property {number} minLevel - 该档 level 下界（含）。
 * @property {number} maxLevel - 该档 level 上界（含）。
 * @property {string} zh - 中文说话要求。
 * @property {string} en - 英文说话要求。
 */

/** 四档锚点规则表（施工清单 4.1 表；顺序即档位由低到高）。 */
export const TIER_RULES = /** @type {readonly TierRule[]} */ ([
  { tier: '科普', minLevel: 1, maxLevel: 3, zh: TIER_VOICE.zh.科普, en: TIER_VOICE.en.科普 },
  { tier: '本科', minLevel: 4, maxLevel: 6, zh: TIER_VOICE.zh.本科, en: TIER_VOICE.en.本科 },
  { tier: '硕士', minLevel: 7, maxLevel: 8, zh: TIER_VOICE.zh.硕士, en: TIER_VOICE.en.硕士 },
  { tier: '专家', minLevel: 9, maxLevel: 10, zh: TIER_VOICE.zh.专家, en: TIER_VOICE.en.专家 },
])

/** 未打分领域的默认档（施工清单 4.1：本科是默认锚点）。 */
export const DEFAULT_TIER = '本科'

/** 领域等级列表上限：防 profile 表灌满后把预热段撑爆（协议常量，非部署 tunable）。 */
export const MAX_CONSTRAINT_DOMAINS = 31

/**
 * 校验常量表与本模块规则表一致：档位词汇相同且同序、每档都有说话要求、分档边界与
 * tierForLevel 逐值吻合。不一致即抛（模块顶层调用一次，调用方也可自行复验）。
 * @returns {void} 一致时不返回内容。
 */
export function assertTierRules() {
  const declared = TIER_RULES.map((rule) => rule.tier)
  if (declared.length !== KNOWLEDGE_TIERS.length || declared.some((tier, index) => tier !== KNOWLEDGE_TIERS[index])) {
    throw new Error(`yammory_system constraint: TIER_RULES tiers [${declared.join('|')}] must match KNOWLEDGE_TIERS [${KNOWLEDGE_TIERS.join('|')}] in the same order`)
  }
  for (const rule of TIER_RULES) {
    if (rule.zh === '' || rule.en === '') {
      throw new Error(`yammory_system constraint: tier ${rule.tier} is missing its speaking requirement`)
    }
    for (let level = 1; level <= 10; level += 1) {
      const inside = level >= rule.minLevel && level <= rule.maxLevel
      if (inside !== (tierForLevel(level) === rule.tier)) {
        throw new Error(`yammory_system constraint: tier ${rule.tier} range ${rule.minLevel}-${rule.maxLevel} disagrees with tierForLevel(${level}) = ${tierForLevel(level)}`)
      }
    }
  }
  if (!KNOWLEDGE_TIERS.includes(DEFAULT_TIER)) {
    throw new Error(`yammory_system constraint: DEFAULT_TIER ${DEFAULT_TIER} is not one of ${KNOWLEDGE_TIERS.join('|')}`)
  }
}

assertTierRules()

/** 与 memento 既有语言词汇一致：非法值在加载期由 Config 响亮拒绝，此处只做回退。 */
function isZh(/** @type {string} */ language) {
  return language === 'zh'
}

/**
 * 按 level 取四档规则。level 已由 store 保证为 1..10；越界回退默认档（不抛，渲染
 * 路径不该因一行脏数据炸掉整段预热）。
 * @param {number} level - 1..10。
 * @returns {TierRule} 对应规则行。
 */
export function ruleForLevel(level) {
  return TIER_RULES.find((rule) => level >= rule.minLevel && level <= rule.maxLevel)
    ?? /** @type {TierRule} */ (TIER_RULES.find((rule) => rule.tier === DEFAULT_TIER))
}

/**
 * 渲染表达约束段：已打分领域逐条列档位＋一句总口径（组合规则，可复算），未打分
 * 领域一句默认带过。
 *
 * 只列 profile 表里「已打分的领域」；表为空时给一句默认锚点，而非留白让模型猜口吻。
 * 行序按 level 由高到低（同 level 按领域名升序），因此同一份 profile 每次渲染逐字
 * 一致——预热段要能冻结、要能进前缀缓存。
 * @param {Array<{domain: string, level: number}>} [profileRows] - profile 表行（domain/level 即可）。
 * @param {string} [language] - 'en' | 'zh'（默认 en）。
 * @returns {string} 表达约束段文本（无已打分领域时也非空）。
 */
export function renderConstraint(profileRows = [], language = 'en') {
  const sorted = [...profileRows]
    .filter((row) => typeof row.domain === 'string' && row.domain !== '' && Number.isInteger(row.level))
    .sort((a, b) => b.level - a.level || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
    .slice(0, MAX_CONSTRAINT_DOMAINS)
  const head = /** @type {string} */ (pick(CONSTRAINT_HEADER, language))
  if (isZh(language)) {
    return [
      `【${head}】`,
      `用户水平（按当前话题领域取用；未列领域按${DEFAULT_TIER}档）：`,
      ...(sorted.length === 0 ? ['· （尚无已打分的领域）'] : sorted.map((row) => `· ${row.domain} ${row.level}/10（${ruleForLevel(row.level).tier}）`)),
      '当前话题落在某领域时，按该领域的规则说；若档位不同，按该领域 level 对应的档位执行。',
      '',
      '规则表（组合规则，按 level 复算）：',
      ...[...TIER_RULES].reverse().map((rule) => `· ${rule.tier}（${rule.minLevel}–${rule.maxLevel} 级）：${rule.zh}`),
    ].join('\n')
  }
  return [
    `[${head}]`,
    `User level (look up by the current topic domain; unlisted domains default to the undergraduate tier):`,
    ...(sorted.length === 0 ? ['· (no domain scored yet)'] : sorted.map((row) => `· ${row.domain} ${row.level}/10 (${ruleForLevel(row.level).tier})`)),
    'Speak at the tier matching the current topic domain; when tiers differ, follow that domain’s level.',
    '',
    'Tier rules (composition rules, resolved by level):',
    ...[...TIER_RULES].reverse().map((rule) => `· ${rule.tier} (levels ${rule.minLevel}–${rule.maxLevel}): ${rule.en}`),
  ].join('\n')
}

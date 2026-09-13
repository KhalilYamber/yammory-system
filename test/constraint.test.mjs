// test/constraint.test.mjs — 表达约束生成单测：四档映射/组合规则/排序/默认档/双语/
// 常量表与 tierForLevel 的一致性断言。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TIER_RULES, DEFAULT_TIER, MAX_CONSTRAINT_DOMAINS,
  assertTierRules, ruleForLevel, renderConstraint,
} from '../lib/constraint.mjs'
import { KNOWLEDGE_TIERS, tierForLevel } from '../lib/constants.mjs'

test('S2：四档规则表与 KNOWLEDGE_TIERS / tierForLevel 一致（不自立一套分档）', () => {
  assert.doesNotThrow(() => assertTierRules())
  assert.deepEqual(TIER_RULES.map((rule) => rule.tier), [...KNOWLEDGE_TIERS])
  for (const rule of TIER_RULES) {
    assert.equal(tierForLevel(rule.minLevel), rule.tier, `${rule.minLevel} 应落 ${rule.tier}`)
    assert.equal(tierForLevel(rule.maxLevel), rule.tier, `${rule.maxLevel} 应落 ${rule.tier}`)
  }
})

test('S2：ruleForLevel 覆盖 1..10 全档，越界回退默认档（渲染路径不炸）', () => {
  assert.equal(ruleForLevel(1).tier, '科普')
  assert.equal(ruleForLevel(3).tier, '科普')
  assert.equal(ruleForLevel(4).tier, '本科')
  assert.equal(ruleForLevel(6).tier, '本科')
  assert.equal(ruleForLevel(7).tier, '硕士')
  assert.equal(ruleForLevel(8).tier, '硕士')
  assert.equal(ruleForLevel(9).tier, '专家')
  assert.equal(ruleForLevel(10).tier, '专家')
  assert.equal(ruleForLevel(0).tier, DEFAULT_TIER, '越界回退默认档')
  assert.equal(ruleForLevel(99).tier, DEFAULT_TIER, '越界回退默认档')
})

test('S2：默认档 = 本科（施工清单 4.1 的默认锚点）', () => {
  assert.equal(DEFAULT_TIER, '本科')
})

test('S2：只列已打分的领域；未打分领域用一句默认带过', () => {
  const text = renderConstraint([{ domain: '计算机与编程', level: 8 }, { domain: '数学', level: 5 }], 'zh')
  assert.ok(text.includes('计算机与编程 8/10（硕士）'))
  assert.ok(text.includes('数学 5/10（本科）'))
  assert.ok(text.includes(`未列领域按${DEFAULT_TIER}档`), '未打分领域一句默认带过')
  assert.ok(!text.includes('生物'), '未打分的领域不出现在清单里')
})

test('S2：领域按 level 由高到低列出，同 level 按领域名升序（渲染确定性）', () => {
  const rows = [
    { domain: '生物与医学', level: 3 },
    { domain: '数学', level: 5 },
    { domain: '计算机与编程', level: 8 },
    { domain: '统计与概率', level: 5 },
  ]
  const text = renderConstraint(rows, 'zh')
  const order = ['计算机与编程', '数学', '统计与概率', '生物与医学'].map((d) => text.indexOf(d))
  assert.ok(order.every((index) => index >= 0), '四个领域都在')
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '顺序应为 8 → 5 → 5 → 3')
  assert.equal(renderConstraint([...rows].reverse(), 'zh'), text, '输入顺序不影响输出（可冻结）')
})

test('S2：四档说话要求全部在场（组合规则，模型按 level 复算）', () => {
  const zh = renderConstraint([{ domain: '数学', level: 5 }], 'zh')
  assert.ok(zh.startsWith('【表达约束】'))
  assert.ok(zh.includes('· 专家（9–10 级）：术语自由'))
  assert.ok(zh.includes('· 硕士（7–8 级）：术语自由'))
  assert.ok(zh.includes('· 本科（4–6 级）：常用术语直接用'))
  assert.ok(zh.includes('· 科普（1–3 级）：不用术语'))
  assert.ok(zh.includes('当前话题落在某领域时'))
})

test('S2：空 profile 表也非空——给默认锚点，不留白让模型猜口吻', () => {
  const text = renderConstraint([], 'zh')
  assert.ok(text.includes('【表达约束】'))
  assert.ok(text.includes('（尚无已打分的领域）'))
  assert.ok(text.includes(`未列领域按${DEFAULT_TIER}档`))
  assert.ok(text.includes('· 本科（4–6 级）'))
})

test('S2：language=en 出英文表头与档位说明；非法语言回退 en', () => {
  const en = renderConstraint([{ domain: '数学', level: 5 }])
  assert.ok(en.startsWith('[Speaking constraints]'))
  assert.ok(en.includes('· 数学 5/10 (本科)'))
  assert.ok(en.includes('unlisted domains default to the undergraduate tier'))
  assert.ok(en.includes('Tier rules (composition rules, resolved by level):'))
  assert.ok(en.includes('(levels 9–10)'))
  assert.equal(renderConstraint([{ domain: '数学', level: 5 }], 'fr'), en, '未知语言回退 en')
})

test('S2：脏行被过滤（缺 domain / level 非整数）而不是渲染成空档位', () => {
  const text = renderConstraint([
    { domain: '数学', level: 5 },
    { domain: '', level: 7 },
    { domain: '物理', level: 4.5 },
  ], 'zh')
  assert.ok(text.includes('数学 5/10'))
  assert.ok(!text.includes('物理'), '非整数 level 不渲染')
  assert.ok(!text.includes(' 7/10'), '空 domain 不渲染')
})

test('S2：领域条数受 MAX_CONSTRAINT_DOMAINS 钳制（防撑爆预热段）', () => {
  const rows = Array.from({ length: MAX_CONSTRAINT_DOMAINS + 10 }, (_, index) => ({ domain: `领域${index}`, level: index % 10 + 1 }))
  const text = renderConstraint(rows, 'zh')
  const listed = text.split('\n').filter((line) => line.startsWith('· ') && line.includes('/10（'))
  assert.equal(listed.length, MAX_CONSTRAINT_DOMAINS)
})

// test/observe.test.mjs — 观察通道：纯逻辑单测（两条闸 / 采样 / 预算 / 条目组装）
// ＋ memory_observe 工具集成测试（授权收窄端到端、过滤闸、响亮降级、审批门）。
// 「能读谁」与「什么算他说的话」是观察通道最敏感的两处，靠用例钉住，不靠自觉。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HUMAN_SOURCE_KINDS,
  isHumanMessageEvent,
  isUserMessageEvent,
  extractHumanMessages,
  sampleEvenly,
  sessionScope,
  resolveObserveOptions,
  buildObservationSlice,
  composeObservationText,
  normalizeObservationEntries,
  observationTags,
  formatDate,
  formatStamp,
} from '../lib/observe.mjs'
import { InvalidInputError } from '../lib/errors.mjs'
import { OBSERVE_LIMITS, OBSERVATION_FACE_VALUES } from '../lib/constants.mjs'
import { apply, DEFAULT_BUDGETS, handleMemoryCommand } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent, makeExec } from './helpers/mock-ctx.mjs'

const DAY = 86400000
const NOW = new Date('2026-09-13T12:00:00').getTime()

/** 合成一条 user/message 事件（source.kind 可指定）。 */
function message(kind, text, seq = 0, time = NOW) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' } }
}

/** 切片文案（中性，测试只关心结构与预算）。 */
const LABELS = {
  header: (info) => `SLICE days=${info.days} sessions=${info.sessions}`,
  session: (info) => `SESSION ${info.sessionId} messages=${info.messages}`,
  message: (info) => `MSG ${info.text}`,
}

function session(sessionId, createdAt, events, title) {
  return { sessionId, createdAt, events, ...(title === undefined ? {} : { title }) }
}

// ── 闸一：授权收窄 ────────────────────────────────────────────────────────────

test('闸一：有 cwd 时只读 cwd 精确相等的会话（cwd 过滤 AND 时间窗）', () => {
  const scope = sessionScope({ cwd: 'D:\\work\\proj', sessionId: 's1', days: 14, now: NOW })
  assert.equal(scope.selfOnly, false)
  assert.deepEqual(scope.filters, [
    { kind: 'cwd', values: ['D:\\work\\proj'] },
    { kind: 'created-at', from: NOW - 14 * DAY },
  ])
})

test('闸一：无 cwd 时只读当前会话自己，绝不跨会话读', () => {
  const scope = sessionScope({ cwd: undefined, sessionId: 's1', days: 7, now: NOW })
  assert.equal(scope.selfOnly, true)
  assert.deepEqual(scope.filters, [
    { kind: 'id', values: ['s1'] },
    { kind: 'created-at', from: NOW - 7 * DAY },
  ])
  // 空串等同缺失（不给「传空 cwd 就变成全工作区」的口子）
  assert.equal(sessionScope({ cwd: '', sessionId: 's1', days: 7, now: NOW }).selfOnly, true)
})

test('闸一：既没有 cwd 也没有 sessionId 时响亮拒绝，不读任何东西', () => {
  assert.throws(() => sessionScope({ cwd: undefined, sessionId: undefined, days: 14, now: NOW }), InvalidInputError)
  assert.throws(() => sessionScope({ cwd: '', sessionId: '', days: 14, now: NOW }), InvalidInputError)
})

// ── 闸二：事件过滤 ────────────────────────────────────────────────────────────

test('闸二：白名单只有 user / user-rpc 两种 kind', () => {
  assert.deepEqual([...HUMAN_SOURCE_KINDS], ['user', 'user-rpc'])
  assert.equal(isHumanMessageEvent(message('user', '在的')), true)
  assert.equal(isHumanMessageEvent(message('user-rpc', '在的')), true)
})

test('闸二：本机实测的 8 类系统注入全部被挡（plugin / agent-instructions / skill-catalog / goal / subagent-* 等）', () => {
  const injected = [
    'plugin',
    'agent-instructions',
    'skill-catalog',
    'goal',
    'subagent-settled',
    'subagent-report',
    'agent-message',
    'skill-invocation',
  ]
  for (const kind of injected) {
    assert.equal(isHumanMessageEvent(message(kind, '伪发言')), false, `${kind} 必须被挡`)
    assert.equal(isUserMessageEvent(message(kind, '伪发言')), true, `${kind} 仍是 user/message 事件（故必须靠白名单挡）`)
  }
})

test('闸二：缺 source / 缺 kind / 非对象一律不算真人发言（失败封闭）', () => {
  assert.equal(isHumanMessageEvent({ type: 'user/message', data: { content: [] } }), false)
  assert.equal(isHumanMessageEvent({ type: 'user/message', data: { source: {} } }), false)
  assert.equal(isHumanMessageEvent({ type: 'user/message', data: null }), false)
  assert.equal(isHumanMessageEvent({ type: 'user/message' }), false)
  assert.equal(isHumanMessageEvent({ type: 'assistant/message', data: { source: { kind: 'user' } } }), false)
  assert.equal(isHumanMessageEvent(null), false)
  assert.equal(isHumanMessageEvent('user/message'), false)
})

test('extractHumanMessages：只留真人发言，并如实统计被挡下的伪发言条数', () => {
  const events = [
    { type: 'session', seq: 0 },
    message('user', '先看检索', 1),
    message('agent-instructions', '# AGENTS.md 全文', 2),
    message('skill-catalog', '<available_skills>', 3),
    message('plugin', 'Current runtime context.', 4),
    message('user-rpc', '继续', 5),
    { type: 'assistant/message', seq: 6, data: { content: [{ type: 'text', text: '好的' }] } },
  ]
  const { messages, injected } = extractHumanMessages(events, 400)
  assert.deepEqual(messages.map((m) => m.text), ['先看检索', '继续'])
  assert.equal(injected, 3, '三条伪发言被挡下并计数')
})

test('extractHumanMessages：单条超限即截断加省略号且标 truncated，长度不超上限', () => {
  const long = '甲'.repeat(500)
  const short = extractHumanMessages([message('user', long, 0)], 400).messages[0]
  assert.equal(short.truncated, true)
  assert.equal(short.text.length, 400, '含省略号也在上限内')
  assert.equal(short.text.endsWith('…'), true)
  const kept = extractHumanMessages([message('user', '甲'.repeat(400), 1)], 400).messages[0]
  assert.equal(kept.truncated, false)
  assert.equal(kept.text.length, 400)
})

test('extractHumanMessages：空白发言丢弃、非数组输入返回空、图片等非文本块不产生条目', () => {
  assert.deepEqual(extractHumanMessages(null, 400), { messages: [], injected: 0 })
  assert.deepEqual(extractHumanMessages([message('user', '   ', 0)], 400).messages, [])
  const imageOnly = { type: 'user/message', seq: 0, time: NOW, data: { content: [{ type: 'image', source: 'x.png' }], source: { kind: 'user' } } }
  assert.deepEqual(extractHumanMessages([imageOnly], 400).messages, [])
})

// ── 均匀采样 ──────────────────────────────────────────────────────────────────

test('sampleEvenly：保住首条与末条，中间等距取', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ seq: index, at: NOW, text: `m${index}`, truncated: false }))
  assert.deepEqual(sampleEvenly(items, 4).map((i) => i.seq), [0, 3, 6, 9])
  assert.deepEqual(sampleEvenly(items, 5).map((i) => i.seq), [0, 2, 5, 7, 9])
  assert.deepEqual(sampleEvenly(items, 1).map((i) => i.seq), [0], '只取一条时取首条')
})

test('sampleEvenly：条数够则不采样、空输入与零条数返回空', () => {
  const items = [{ seq: 0, at: NOW, text: 'a', truncated: false }, { seq: 1, at: NOW, text: 'b', truncated: false }]
  assert.deepEqual(sampleEvenly(items, 5).map((i) => i.seq), [0, 1])
  assert.deepEqual(sampleEvenly([], 5), [])
  assert.deepEqual(sampleEvenly(items, 0), [])
})

// ── 参数钳制 ──────────────────────────────────────────────────────────────────

const OBSERVE_DEFAULTS = { days: 14, sessions: 8, perSession: 12, messageChars: 400, totalChars: 12000 }

test('resolveObserveOptions：缺省/非法值回落默认，合法值原样通过', () => {
  const resolved = resolveObserveOptions({}, OBSERVE_DEFAULTS)
  assert.deepEqual(resolved.options, OBSERVE_DEFAULTS)
  assert.deepEqual(resolved.clamped, [])
  const junk = resolveObserveOptions({ days: 'abc', sessions: null, perSession: Number.NaN, messageChars: undefined, totalChars: Infinity }, OBSERVE_DEFAULTS)
  assert.deepEqual(junk.options, OBSERVE_DEFAULTS)
  assert.deepEqual(junk.clamped, [])
})

test('resolveObserveOptions：模型放大参数被夹到硬上限并如实报告（预算不是建议）', () => {
  const resolved = resolveObserveOptions({ days: 99999, sessions: 500, totalChars: 10 ** 9 }, OBSERVE_DEFAULTS)
  assert.equal(resolved.options.days, OBSERVE_LIMITS.days)
  assert.equal(resolved.options.sessions, OBSERVE_LIMITS.sessions)
  assert.equal(resolved.options.totalChars, OBSERVE_LIMITS.totalChars)
  assert.deepEqual(resolved.clamped.map((c) => c.key).sort(), ['days', 'sessions', 'totalChars'])
  assert.deepEqual(resolved.clamped.find((c) => c.key === 'days'), { key: 'days', requested: 99999, applied: 90 })
})

test('resolveObserveOptions：小数向下取整、下界为 1', () => {
  const resolved = resolveObserveOptions({ days: 3.9, sessions: 0, perSession: -5 }, OBSERVE_DEFAULTS)
  assert.equal(resolved.options.days, 3)
  assert.equal(resolved.options.sessions, 1)
  assert.equal(resolved.options.perSession, 1)
})

// ── 切片组装与预算记账 ────────────────────────────────────────────────────────

test('buildObservationSlice：窗口外的会话不进候选，会话数按 newest-first 截断', () => {
  const sessions = [
    session('new', NOW - 1 * DAY, [message('user', '最近的', 0, NOW - 1 * DAY)]),
    session('mid', NOW - 5 * DAY, [message('user', '五天前', 0, NOW - 5 * DAY)]),
    session('old', NOW - 30 * DAY, [message('user', '一个月前', 0, NOW - 30 * DAY)]),
  ]
  const slice = buildObservationSlice(sessions, { ...OBSERVE_DEFAULTS, sessions: 1 }, NOW, LABELS)
  assert.equal(slice.scanned.sessions, 2, '30 天前的会话在 14 天窗口外')
  assert.equal(slice.scanned.read, 1, '会话数上限生效')
  assert.deepEqual(slice.picked.map((p) => p.sessionId), ['new'])
  assert.equal(slice.text.includes('最近的'), true)
  assert.equal(slice.text.includes('一个月前'), false)
})

test('buildObservationSlice：切片全由伪发言构成时覆盖为零，整窗如实记为未覆盖', () => {
  const sessions = [
    session('a', NOW - 1 * DAY, [message('agent-instructions', '# AGENTS.md', 0, NOW - 1 * DAY), message('plugin', 'runtime context', 1, NOW - 1 * DAY)]),
  ]
  const slice = buildObservationSlice(sessions, OBSERVE_DEFAULTS, NOW, LABELS)
  assert.equal(slice.covered.sessions, 0)
  assert.equal(slice.covered.messages, 0)
  assert.equal(slice.covered.from, null)
  assert.equal(slice.scanned.injected, 2, '被挡下的伪发言条数进账单')
  assert.equal(slice.uncovered.sessions, 1)
  assert.equal(slice.uncovered.days, OBSERVE_DEFAULTS.days, '一条没覆盖到 = 整个窗口都没看')
})

test('buildObservationSlice：预算到顶即停，并把未覆盖的会话数与天数报出来', () => {
  const events = Array.from({ length: 40 }, (_, index) => message('user', `发言${index}`.padEnd(60, '·'), index, NOW - index * 60000))
  const sessions = [session('a', NOW - DAY, events), session('b', NOW - 2 * DAY, events.map((e) => ({ ...e, time: e.time - 2 * DAY })))]
  const options = { days: 14, sessions: 8, perSession: 20, messageChars: 400, totalChars: 600 }
  const slice = buildObservationSlice(sessions, options, NOW, LABELS)
  assert.equal(slice.budget.truncated, true)
  assert.equal(slice.budget.used, slice.text.length, '记账口径 = 真实文本长度')
  assert.equal(slice.text.length <= options.totalChars, true)
  assert.equal(slice.uncovered.sessions > 0, true)
  assert.equal(slice.uncovered.messages > 0, true)
  assert.equal(slice.uncovered.days > 0, true)
})

test('buildObservationSlice：任何预算下文本都不超上限（含极小预算的退化路径）', () => {
  const events = Array.from({ length: 12 }, (_, index) => message('user', `第${index}条发言，够长够长够长够长`, index, NOW - index * 60000))
  const sessions = [session('a', NOW - DAY, events)]
  for (const totalChars of [1, 10, 40, 100, 400, 1200, 12000]) {
    const slice = buildObservationSlice(sessions, { ...OBSERVE_DEFAULTS, totalChars }, NOW, LABELS)
    assert.equal(slice.text.length <= totalChars, true, `totalChars=${totalChars} 时不得超预算`)
    assert.equal(slice.budget.used, slice.text.length)
  }
})

test('buildObservationSlice：覆盖账单给出真正看到的时间范围与未覆盖天数', () => {
  const sessions = [
    session('mid', NOW - 8 * DAY, [message('user', '八天前的发言', 0, NOW - 8 * DAY)]),
    session('new', NOW - 1 * DAY, [message('user', '昨天的发言', 0, NOW - 1 * DAY)]),
  ]
  const slice = buildObservationSlice(sessions, OBSERVE_DEFAULTS, NOW, LABELS)
  assert.equal(slice.covered.sessions, 2)
  assert.equal(slice.covered.messages, 2)
  assert.equal(slice.covered.from, NOW - 8 * DAY)
  assert.equal(slice.covered.to, NOW - 1 * DAY)
  assert.equal(slice.uncovered.sessions, 0)
  assert.equal(slice.uncovered.messages, 0)
  assert.equal(slice.uncovered.days, 6, '窗口下界到最老覆盖点之间还有 6 天没看')
  assert.deepEqual(slice.window, { from: NOW - 14 * DAY, to: NOW })
})

test('buildObservationSlice：会话抬头带上标题与条数，空标题归一为 null', () => {
  const sessions = [session('a', NOW - DAY, [message('user', '一', 0, NOW - DAY), message('user', '二', 1, NOW - DAY)], '标题甲')]
  const slice = buildObservationSlice(sessions, OBSERVE_DEFAULTS, NOW, LABELS)
  assert.deepEqual(slice.picked, [{ sessionId: 'a', title: '标题甲', at: NOW - DAY, messages: 2 }])
  const untitled = buildObservationSlice([session('b', NOW - DAY, [message('user', '一', 0, NOW - DAY)])], OBSERVE_DEFAULTS, NOW, LABELS)
  assert.equal(untitled.picked[0].title, null)
})

// ── 写入侧组装 ────────────────────────────────────────────────────────────────

test('composeObservationText：来源与观察时间前置，证据随条目落库（审批时人看到的就是证据）', () => {
  const zh = composeObservationText({ text: '被追问时会先复述约束再动手', evidence: '“先把方案读完再改代码”' }, NOW, 'zh')
  assert.equal(zh, `[观察 ${formatDate(NOW)}] 被追问时会先复述约束再动手\n证据：“先把方案读完再改代码”`)
  const en = composeObservationText({ text: 'restates constraints first', evidence: '"read the plan first"' }, NOW, 'en')
  assert.equal(en, `[observed ${formatDate(NOW)}] restates constraints first\nevidence: "read the plan first"`)
})

test('observationTags：子板块 + observation + 日期，去重且保留附加标签', () => {
  assert.deepEqual(observationTags({ face: '思维方式与思辨' }, NOW), ['思维方式与思辨', 'observation', formatDate(NOW)])
  const tagged = observationTags({ face: '校正', tags: ['专业能力', '校正', ''] }, NOW)
  assert.deepEqual(tagged, ['校正', '专业能力', 'observation', formatDate(NOW)])
})

test('formatDate / formatStamp：本地时区的日期与分钟级时间戳', () => {
  const at = new Date('2026-09-13T09:05:00').getTime()
  assert.equal(formatDate(at), '2026-09-13')
  assert.equal(formatStamp(at), '2026-09-13 09:05')
})

test('normalizeObservationEntries：面映射到七面 facet，子板块与日期进 tags，source 由工具锚死', () => {
  const entries = normalizeObservationEntries([
    { face: '思维方式与思辨', text: '先复述约束再动手', evidence: '“先把方案读完”' },
    { face: '情绪模式与心理强度', text: '被打断会先停下来确认', evidence: '“等一下，你刚说的我没听清”', tags: ['沟通'] },
  ], NOW, 'zh')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], {
    track: 'user',
    scope: 'user-global',
    text: `[观察 ${formatDate(NOW)}] 先复述约束再动手\n证据：“先把方案读完”`,
    source: 'observation',
    tags: ['思维方式与思辨', 'observation', formatDate(NOW)],
    facet: '心智',
  })
  assert.equal(entries[1].facet, '心智', '情绪模式同属心智面')
  assert.deepEqual(entries[1].tags, ['情绪模式与心理强度', '沟通', 'observation', formatDate(NOW)])
})

test('normalizeObservationEntries：「校正」面必须自带被校正的七面，否则拒绝', () => {
  const corrected = normalizeObservationEntries([{ face: '校正', facet: '能力与技能', text: '实际能独立交付', evidence: '“我把它写完并跑通了”' }], NOW, 'zh')
  assert.equal(corrected[0].facet, '能力与技能')
  assert.throws(() => normalizeObservationEntries([{ face: '校正', text: 'x', evidence: 'y' }], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '校正', facet: '不存在的面', text: 'x', evidence: 'y' }], NOW, 'zh'), InvalidInputError)
})

test('normalizeObservationEntries：缺结论/缺证据/低把握/超条数一律响亮拒绝（低把握不写）', () => {
  assert.throws(() => normalizeObservationEntries([], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '人格特质', evidence: 'y' }], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '人格特质', text: 'x' }], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '人格特质', text: '  ', evidence: 'y' }], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '人格特质', text: 'x', evidence: 'y', confidence: '低' }], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '人格特质', text: 'x', evidence: 'y', confidence: '很高' }], NOW, 'zh'), InvalidInputError)
  assert.throws(() => normalizeObservationEntries([{ face: '不存在的面', text: 'x', evidence: 'y' }], NOW, 'zh'), InvalidInputError)
  const nine = Array.from({ length: 9 }, () => ({ face: '人格特质', text: 'x', evidence: 'y' }))
  assert.throws(() => normalizeObservationEntries(nine, NOW, 'zh'), InvalidInputError)
  const eight = Array.from({ length: 8 }, () => ({ face: '人格特质', text: 'x', evidence: 'y' }))
  assert.equal(normalizeObservationEntries(eight, NOW, 'zh').length, 8)
  assert.equal(OBSERVATION_FACE_VALUES.length, 6, '五个观察面 ＋ 校正')
})

// ── 集成：memory_observe 工具（mock ctx ＋ 假 sessionQuery） ────────────────────

/** 集成挂载：临时库 ＋ 可控审批 ＋ memory_observe 工具。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-observe-'))
  const mock = createMockCtx()
  /** @type {object[]} */
  const approvals = []
  mock.ctx.approval = {
    request: async (/** @type {object} */ req) => { approvals.push(req); return opts.outcome ?? 'allowed-once' },
    overrideOf: () => undefined,
    config: { policy: 'auto' },
  }
  mock.ctx.provide('commands', { register() { return () => {} } })
  apply(mock.ctx, {
    enabled: true,
    dbPath: path.join(dir, 'memory.db'),
    budgets: DEFAULT_BUDGETS,
    writePolicy: opts.writePolicy ?? 'auto',
    language: opts.language ?? 'en',
    ...(opts.observe === undefined ? {} : { observe: opts.observe }),
  })
  return { dir, mock, approvals }
}

function teardown(mounted) {
  mounted.mock.dispose()
  rmSync(mounted.dir, { recursive: true, force: true })
}

/**
 * 假 sessionQuery：真的按过滤条件下推（cwd 精确 / id / created-at 下界），
 * 这样闸一可以直接断在「别的工作区的内容有没有出现」上，而不只是「传了什么参数」。
 * @param {Array<{id: string, cwd: string, createdAt: number, events?: unknown[], unreadable?: boolean}>} sessions
 * @param {object[][]} filterLog
 */
function fakeSessionQuery(sessions, filterLog = []) {
  return {
    async filterSessions(/** @type {any[]} */ filters) {
      filterLog.push(filters)
      const cwd = filters.find((filter) => filter.kind === 'cwd')
      const id = filters.find((filter) => filter.kind === 'id')
      const from = filters.find((filter) => filter.kind === 'created-at')?.from ?? 0
      return sessions
        .filter((s) => (cwd === undefined || cwd.values.includes(s.cwd)))
        .filter((s) => (id === undefined || id.values.includes(s.id)))
        .filter((s) => s.createdAt >= from)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({ header: { id: s.id, createdAt: s.createdAt } }))
    },
    async readSession(/** @type {string} */ id) {
      const found = sessions.find((s) => s.id === id)
      if (found === undefined || found.unreadable === true) throw new Error(`session ${id} unreadable`)
      return { session: { createdAt: found.createdAt }, events: found.events ?? [] }
    },
    async readTitleSnapshots(/** @type {string[]} */ ids) {
      return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: `title-of-${id}` } } }))
    },
  }
}

function observeTool(mock) {
  const tool = mock.tools.find((/** @type {{name: string}} */ candidate) => candidate.name === 'memory_observe')
  assert.ok(tool, 'memory_observe 工具已注册')
  return tool
}

test('memory_observe：工具参数面不含任何 sessionId（模型不能点名会话）', (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const schema = /** @type {{properties: Record<string, unknown>, required: string[]}} */ (observeTool(mounted.mock).parameters)
  const keys = Object.keys(schema.properties)
  for (const forbidden of ['sessionId', 'session', 'id', 'sessionsIds', 'sessionIds']) {
    assert.equal(keys.includes(forbidden), false, `参数面不得出现 ${forbidden}`)
  }
  assert.deepEqual(keys.sort(), ['action', 'days', 'entries', 'messageChars', 'perSession', 'sessions', 'totalChars'])
  assert.deepEqual(schema.required, ['action'])
})

test('闸一端到端：scan 只读 cwd 精确相等的会话，别的工作区一个字都不出现', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const filterLog = /** @type {object[][]} */ ([])
  const now = Date.now()
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'mine', cwd: 'D:\\proj', createdAt: now - 3600000, events: [message('user', '本项目约定：提交前跑门链', 0, now - 3600000)] },
    { id: 'theirs', cwd: 'D:\\other', createdAt: now - 3600000, events: [message('user', '别人工作区的机密内容', 0, now - 3600000)] },
  ], filterLog))
  const session = makeSession({ id: 'mine', cwd: 'D:\\proj' })
  const result = await observeTool(mounted.mock).execute({ action: 'scan' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(result.ok, true)
  assert.equal(result.selfOnly, false)
  assert.deepEqual(filterLog[0][0], { kind: 'cwd', values: ['D:\\proj'] }, '服务端下推 cwd 精确过滤')
  assert.equal(result.slice.includes('本项目约定'), true)
  assert.equal(result.slice.includes('别人工作区的机密内容'), false, '跨工作区内容绝不出现')
  assert.equal(result.scanned.sessions, 1, '别的工作区的会话不在候选里')
})

test('闸一端到端：会话没有 cwd 时只读自己（id 精确相等），selfOnly 标记出来', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const filterLog = /** @type {object[][]} */ ([])
  const now = Date.now()
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'self', cwd: '', createdAt: now - 3600000, events: [message('user', '我自己的发言', 0, now - 3600000)] },
    { id: 'other', cwd: '', createdAt: now - 3600000, events: [message('user', '同一工作区别人的发言', 0, now - 3600000)] },
  ], filterLog))
  const session = makeSession({ id: 'self', cwd: '' })
  const result = await observeTool(mounted.mock).execute({ action: 'scan' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(result.selfOnly, true)
  assert.deepEqual(filterLog[0][0], { kind: 'id', values: ['self'] })
  assert.equal(result.slice.includes('我自己的发言'), true)
  assert.equal(result.slice.includes('同一工作区别人的发言'), false)
})

test('闸二端到端：系统注入的伪发言进不了切片，只进 injected 计数', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const now = Date.now()
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([{
    id: 'mine',
    cwd: 'D:\\proj',
    createdAt: now - 3600000,
    events: [
      message('user', '真人发言甲', 0, now - 3600000),
      message('plugin', 'Current runtime context: sandbox policy...', 1, now - 3590000),
      message('agent-instructions', '# AGENTS.md 全文（七千多字）', 2, now - 3580000),
      message('skill-catalog', '<available_skills>…', 3, now - 3570000),
      message('goal', '<goal_round>…', 4, now - 3560000),
      message('user-rpc', '真人发言乙', 5, now - 3550000),
    ],
  }]))
  const session = makeSession({ id: 'mine', cwd: 'D:\\proj' })
  const result = await observeTool(mounted.mock).execute({ action: 'scan' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(result.scanned.messages, 2)
  assert.equal(result.scanned.injected, 4)
  assert.equal(result.slice.includes('真人发言甲'), true)
  assert.equal(result.slice.includes('真人发言乙'), true)
  for (const leaked of ['Current runtime context', '# AGENTS.md', 'available_skills', 'goal_round']) {
    assert.equal(result.slice.includes(leaked), false, `${leaked} 不得出现在切片里`)
  }
})

test('memory_observe scan：session-query 缺失时响亮降级（ok:false ＋ 明确 code），绝不假装没有历史', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const result = await observeTool(mounted.mock).execute({ action: 'scan' }, makeExec({ agent: makeAgent(makeSession()) }))
  assert.equal(result.ok, false)
  assert.equal(result.available, false)
  assert.equal(result.error.code, 'SESSION_QUERY_UNAVAILABLE')
  const rendered = observeTool(mounted.mock).output.render({ action: 'scan' }, result)
  assert.match(rendered[0].text, /unavailable/)
})

test('memory_observe scan：预算到顶即停并如实报未覆盖，审计留一行 observed', async (t) => {
  const mounted = mount({ observe: { days: 14, sessions: 8, perSession: 20, messageChars: 400, totalChars: 300 } })
  t.after(() => teardown(mounted))
  const now = Date.now()
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    id: `s${index}`,
    cwd: 'D:\\proj',
    createdAt: now - (index + 1) * 3600000,
    events: Array.from({ length: 10 }, (_, m) => message('user', `会话${index}的第${m}条发言，内容够长够长够长够长够长`, m, now - (index + 1) * 3600000 + m * 1000)),
  }))
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery(sessions))
  const session = makeSession({ id: 's0', cwd: 'D:\\proj' })
  const result = await observeTool(mounted.mock).execute({ action: 'scan' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(result.budget.truncated, true)
  assert.equal(result.budget.used <= 300, true)
  assert.equal(result.uncovered.sessions > 0, true)
  assert.equal(result.uncovered.days > 0, true)
  const audit = /** @type {Array<{action: string, source: string, text: string}>} */ (mounted.mock.services.get('memory').store.auditList(5))
  const observed = audit.find((row) => row.action === 'observed')
  assert.ok(observed, 'scan 落一行 observed 审计（下次从更早窗口接着看）')
  assert.equal(observed.source, 'observation')
  assert.match(observed.text, /truncated/)
})

test('memory_observe scan：模型放大参数被钳到硬上限并报出来（下推的时间窗同步收窄）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const filterLog = /** @type {object[][]} */ ([])
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([], filterLog))
  const session = makeSession({ id: 'x', cwd: 'D:\\proj' })
  const before = Date.now()
  const result = await observeTool(mounted.mock).execute(
    { action: 'scan', days: 99999, sessions: 500, totalChars: 10 ** 9, perSession: 99 },
    makeExec({ agent: makeAgent(session) }),
  )
  assert.deepEqual(result.clamped.map((/** @type {{key: string}} */ c) => c.key).sort(), ['days', 'perSession', 'sessions', 'totalChars'])
  const created = /** @type {{from: number}} */ (filterLog[0][1])
  assert.equal(created.kind, 'created-at')
  assert.equal(Math.abs(created.from - (before - 90 * DAY)) < 5000, true, '窗口按钳制后的 90 天下推')
  assert.equal(result.budget.limit, OBSERVE_LIMITS.totalChars)
})

// ── 集成：commit（审批门 ＋ 落库口径） ────────────────────────────────────────

test('memory_observe commit：一次审批 ＋ 一次原子写，source 锚死 observation，审批载荷带 source:observation', async (t) => {
  const mounted = mount({ language: 'zh' })
  t.after(() => teardown(mounted))
  const session = makeSession({ id: 's1', cwd: 'D:\\proj' })
  const result = await observeTool(mounted.mock).execute({
    action: 'commit',
    entries: [
      { face: '思维方式与思辨', text: '先复述约束再动手', evidence: '“先把方案读完再改代码”', confidence: '高' },
      { face: '决策与行动风格', text: '拿不准时会先要一次复核', evidence: '“你替我看看有没有漏”', confidence: '中' },
    ],
  }, makeExec({ agent: makeAgent(session, 'call-9') }))

  assert.equal(result.ok, true)
  assert.equal(result.added, 2)
  assert.equal(mounted.approvals.length, 1, '一次 commit 一次审批')
  const reason = /** @type {{reason: string, toolName: string}} */ (mounted.approvals[0])
  assert.equal(reason.toolName, 'memory')
  assert.match(reason.reason, /\[source:observation\]/, '粒度键 source:observation 在载荷里（用户可单独把它设成 auto/off）')
  assert.match(reason.reason, /\(2 entries\)/)
  assert.match(reason.reason, /先把方案读完再改代码/, '审批载荷携带证据原文')

  const stored = /** @type {Array<{text: string, source: string, tags: string[], facet: string, track: string, scope: string}>} */ (
    mounted.mock.services.get('memory').store.listEntries()
  )
  assert.equal(stored.length, 2)
  for (const entry of stored) {
    assert.equal(entry.source, 'observation')
    assert.equal(entry.track, 'user')
    assert.equal(entry.scope, 'user-global')
    assert.equal(entry.tags.includes('observation'), true)
    assert.match(entry.text, /证据：/)
  }
  assert.deepEqual([...new Set(stored.map((/** @type {{facet: string}} */ entry) => entry.facet))].sort(), ['心智', '行为与习惯'])
  assert.deepEqual(result.entries.map((/** @type {{facet: string}} */ e) => e.facet).sort(), ['心智', '行为与习惯'])
  assert.equal(result.usage.track, 'user')
})

test('memory_observe commit：审批被拒 → 零落盘（审批门不可绕过）', async (t) => {
  const mounted = mount({ outcome: 'rejected' })
  t.after(() => teardown(mounted))
  const result = await observeTool(mounted.mock).execute({
    action: 'commit',
    entries: [{ face: '人格特质', text: 'x', evidence: 'y' }],
  }, makeExec({ agent: makeAgent(makeSession()) }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'WRITE_DENIED')
  assert.equal(mounted.mock.services.get('memory').store.listEntries().length, 0)
})

test('memory_observe commit：坏条目零落盘（低把握/坏面/超条数/空批次都由一个批次挡住）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const tool = observeTool(mounted.mock)
  const exec = makeExec({ agent: makeAgent(makeSession()) })
  const cases = [
    { entries: [{ face: '人格特质', text: 'x', evidence: 'y', confidence: '低' }] },
    { entries: [{ face: '人格特质', text: 'x', evidence: '   ' }] },
    { entries: [{ face: '人格特质', text: 'x', evidence: 'y' }, { face: '校正', text: 'x', evidence: 'y' }] },
    { entries: Array.from({ length: 9 }, () => ({ face: '人格特质', text: 'x', evidence: 'y' })) },
    { entries: [] },
  ]
  for (const args of cases) {
    const result = await tool.execute({ action: 'commit', ...args }, exec)
    assert.equal(result.ok, false, JSON.stringify(args).slice(0, 60))
    assert.equal(result.error.code, 'INVALID_INPUT')
  }
  // 框架层的参数校验比本工具更靠前：必填字段缺失、枚举越界在 execute 之前就被拒
  await assert.rejects(tool.execute({ action: 'commit', entries: [{ face: '人格特质', text: 'x' }] }, exec), /evidence/)
  await assert.rejects(tool.execute({ action: 'commit', entries: [{ face: '人格特质', text: 'x', evidence: 'y', confidence: '很高' }] }, exec), /confidence/)
  await assert.rejects(tool.execute({ action: 'commit', entries: [{ face: '不存在面', text: 'x', evidence: 'y' }] }, exec), /face/)
  assert.equal(mounted.approvals.length, 0, '条目都没通过校验，审批一次也不该发起')
  assert.equal(mounted.mock.services.get('memory').store.listEntries().length, 0)
})

test('memory_observe commit：越预警线仍整批落盘（软预警）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const tool = observeTool(mounted.mock)
  const session = makeSession({ id: 's2', cwd: 'D:\\proj' })
  const huge = '甲'.repeat(1900)
  const first = await tool.execute({
    action: 'commit',
    entries: [{ face: '人格特质', text: huge, evidence: 'y' }],
  }, makeExec({ agent: makeAgent(session) }))
  assert.equal(first.ok, true)
  const second = await tool.execute({
    action: 'commit',
    entries: [{ face: '人格特质', text: huge, evidence: 'y' }],
  }, makeExec({ agent: makeAgent(session) }))
  assert.equal(second.ok, true)
  assert.equal(mounted.mock.services.get('memory').store.listEntries().length, 2, '越线批次照常落盘')
})

// ── 渲染 ──────────────────────────────────────────────────────────────────────

test('memory_observe 渲染：scan 摘要报覆盖与未覆盖，commit 摘要报条数与用量（双语）', async (t) => {
  const mounted = mount({ language: 'zh' })
  t.after(() => teardown(mounted))
  const now = Date.now()
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'a', cwd: 'D:\\proj', createdAt: now - 3600000, events: [message('user', '一句发言', 0, now - 3600000)] },
  ]))
  const tool = observeTool(mounted.mock)
  const session = makeSession({ id: 'a', cwd: 'D:\\proj' })
  const scanned = await tool.execute({ action: 'scan', days: 3 }, makeExec({ agent: makeAgent(session) }))
  const zhText = tool.output.render({ action: 'scan' }, scanned)[0].text
  assert.match(zhText, /观察切片（只读）/)
  assert.match(zhText, /覆盖：/)
  assert.match(zhText, /一句发言/)

  const committed = await tool.execute({
    action: 'commit',
    entries: [{ face: '自我认知', text: '对自己的评价偏保守', evidence: '“我一般吧”' }],
  }, makeExec({ agent: makeAgent(session) }))
  const commitText = tool.output.render({ action: 'commit' }, committed)[0].text
  assert.match(commitText, /已写入 1 条观察条目/)
  assert.match(commitText, /该层用量：user\/user-global/)
})

test('memory_observe 渲染：空切片与自限读都有一行明说（不许静默为空）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const now = Date.now()
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'self', cwd: '', createdAt: now - 3600000, events: [message('plugin', '只有伪发言', 0, now - 3600000)] },
  ]))
  const tool = observeTool(mounted.mock)
  const result = await tool.execute({ action: 'scan' }, makeExec({ agent: makeAgent(makeSession({ id: 'self', cwd: '' })) }))
  const text = tool.output.render({ action: 'scan' }, result)[0].text
  assert.match(text, /no usable evidence/)
  assert.match(text, /no cwd/)
  assert.match(text, /NOT covered/)
})

// ── 命令面：/memory observe ───────────────────────────────────────────────────

function observeInvocation(session, signal) {
  return { rawInput: 'observe', agent: makeAgent(session), signal: signal ?? new AbortController().signal }
}

test('/memory observe：只读打印切片与账单，末行指向模型推断路径，且不写库', async (t) => {
  const mounted = mount({ language: 'zh' })
  t.after(() => teardown(mounted))
  const now = Date.now()
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery([
    { id: 'a', cwd: 'D:\\proj', createdAt: now - 3600000, events: [message('user', '先把方案读完再改代码', 0, now - 3600000)] },
  ]))
  const service = mounted.mock.services.get('memory')
  const result = await handleMemoryCommand(mounted.mock.ctx, service, observeInvocation(makeSession({ id: 'a', cwd: 'D:\\proj' })))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /观察切片（只读）/)
  assert.match(result.text, /覆盖：/)
  assert.match(result.text, /先把方案读完再改代码/)
  assert.match(result.text, /说「观察一下我」/, '末行给出模型推断的入口')
  assert.equal(service.store.listEntries().length, 0, '命令面只读，零写入')
  const audit = /** @type {Array<{action: string}>} */ (service.store.auditList(5))
  assert.ok(audit.some((row) => row.action === 'observed'), '命令面同样留 observed 审计行')
})

test('/memory observe：--days/--sessions 生效并下推到 sessionQuery；未覆盖范围照报', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const filterLog = /** @type {object[][]} */ ([])
  const now = Date.now()
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    id: `s${index}`,
    cwd: 'D:\\proj',
    createdAt: now - (index + 1) * 3600000,
    events: [message('user', `第${index}场的发言`, 0, now - (index + 1) * 3600000)],
  }))
  mounted.mock.ctx.provide('sessionQuery', fakeSessionQuery(sessions, filterLog))
  const service = mounted.mock.services.get('memory')
  const before = Date.now()
  const result = await handleMemoryCommand(mounted.mock.ctx, service, {
    ...observeInvocation(makeSession({ id: 's0', cwd: 'D:\\proj' })),
    rawInput: 'observe --days=3 --sessions=2',
  })
  assert.equal(result.kind, 'success')
  const created = /** @type {{from: number}} */ (filterLog[0][1])
  assert.equal(created.kind, 'created-at')
  assert.equal(Math.abs(created.from - (before - 3 * DAY)) < 5000, true, '3 天窗口下推')
  assert.match(result.text, /2 session\(s\)|覆盖：2/, '会话数上限生效')
  assert.match(result.text, /NOT covered/, '没看全的部分照报')
})

test('/memory observe：坏标志报用法、无 session-query 报不可用（都不抛异常）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const service = mounted.mock.services.get('memory')
  const invocation = observeInvocation(makeSession({ id: 'a', cwd: 'D:\\proj' }))
  const bad = await handleMemoryCommand(mounted.mock.ctx, service, { ...invocation, rawInput: 'observe --days=abc' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /observe usage/)
  const unknownFlag = await handleMemoryCommand(mounted.mock.ctx, service, { ...invocation, rawInput: 'observe --weird=1' })
  assert.equal(unknownFlag.kind, 'error')
  const unavailable = await handleMemoryCommand(mounted.mock.ctx, service, invocation)
  assert.equal(unavailable.kind, 'error')
  assert.match(unavailable.text, /session-query/)
  assert.equal(service.store.listEntries().length, 0)
})

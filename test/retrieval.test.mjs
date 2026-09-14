// test/retrieval.test.mjs — retrieval Provider seam 单测 + memory_recall 召回
// 集成测试：keyword 分词检索器（F2 层 A 默认主路径）、substring 检索器、
// vector 检索器（伪嵌入余弦召回）、注册表、探测降级、以及 Config.retrieval.vector
// 开关接线的端到端路径。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  rankOrder,
  tokenize,
  KeywordRetriever,
  SubstringRetriever,
  VectorRetriever,
  RetrievalProviderRegistry,
  detectVectorBackend,
} from '../lib/retrieval.mjs'
import { FakeEmbeddingProvider } from '../lib/embedding.mjs'
import { InvalidInputError, RetrievalNotFoundError } from '../lib/errors.mjs'
import { apply, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent, makeExec } from './helpers/mock-ctx.mjs'

function entry(id, text, recallCount = 0, updatedAt = 0) {
  return { id, text, recallCount, updatedAt }
}

test('rankOrder：召回频次降序 → 更新时间降序 → id 升序', () => {
  const ordered = [entry('a', '', 0, 0), entry('b', '', 5, 0), entry('c', '', 5, 9), entry('d', '', 5, 9)]
  assert.deepEqual(ordered.sort(rankOrder).map((e) => e.id), ['c', 'd', 'b', 'a'])
})

test('tokenize：CJK 相邻二字 bigram、拉丁/数字整词、混排切段、去重', () => {
  assert.deepEqual(tokenize('用户偏好'), ['用户', '户偏', '偏好'], '中文滑窗二字')
  assert.deepEqual(tokenize('记忆'), ['记忆'], '恰好二字的段只有一个词元')
  assert.deepEqual(tokenize('知识 领域'), ['知识', '领域'], '空格切段，各自成词元')
  assert.deepEqual(tokenize('tea lapsang'), ['tea', 'lapsang'], '拉丁整词')
  assert.deepEqual(tokenize('LAPSANG'), ['lapsang'], '小写归一（检索大小写不敏感）')
  assert.deepEqual(tokenize('用户偏好 abc'), ['用户', '户偏', '偏好', 'abc'], '中英混排按段各走各的分词')
  assert.deepEqual(tokenize('偏好偏好'), ['偏好', '好偏'], '重复 bigram 去重（首现顺序保留）')
})

test('tokenize：空查询与无词元输入返回空数组（不返回全量）', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize('，。！？'), [], '纯标点无词元')
  assert.deepEqual(tokenize('!!!'), [])
  assert.deepEqual(tokenize(undefined), [], '非字符串不按原文归一（否则 "undefined" 会成词元）')
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(42), [], '数字不是查询')
})

test('KeywordRetriever：整串不出现、仅命中部分词元也能召回（多词 OR）', () => {
  const retriever = new KeywordRetriever()
  assert.equal(retriever.id, 'keyword')
  assert.equal(retriever.kind, 'substring')
  const entries = [
    entry('a', '用户偏好：回复用中文', 0, 1),
    entry('b', '用户偏好：代码注释用英文', 9, 0),
    entry('c', '项目约定：测试先于实现', 0, 0),
  ]
  assert.deepEqual(retriever.retrieve('用户偏好', entries).map((e) => e.id), ['b', 'a'])
  assert.deepEqual(retriever.retrieve('测试先于实现', entries).map((e) => e.id), ['c'], 'CJK 长查询整串不出现仍可召回')
  assert.deepEqual(retriever.retrieve('偏好英文', entries).map((e) => e.id), ['b', 'a'], '命中任一词元即进候选')
})

test('KeywordRetriever：相关度（覆盖率＋词元权重＋整串加成）优先，平手退回 rankOrder', () => {
  const retriever = new KeywordRetriever()
  const entries = [
    entry('exact', '用户偏好：回复用中文', 0, 1),
    entry('full', '用户偏好：代码注释用英文', 0, 0),
    entry('partial', '项目约定：偏好英文注释', 0, 0),
    entry('unrelated', '项目约定：测试先于实现', 0, 0),
  ]
  // 相邻二字滑窗含跨词 bigram（'用户偏好英文' → 用户/户偏/偏好/好英/英文，共 5 个）。
  assert.deepEqual(tokenize('用户偏好英文'), ['用户', '户偏', '偏好', '好英', '英文'], '打分前提：查询切成 5 个词元')
  // full 覆盖 4/5（0.4 + 0.24 = 0.64）＞ exact 覆盖 3/5 且词元更短（0.3 + 0.186 = 0.486）
  // ＞ partial 覆盖 2/5 且只中短词元（0.2 + 0.08 = 0.28）；unrelated 零命中不入集。
  assert.deepEqual(retriever.retrieve('用户偏好英文', entries).map((e) => e.id), ['full', 'exact', 'partial'])
  // 整串加成单独可验：同级覆盖（both 3/5）下，含整串的 0.64 + 0.2 = 0.84 压过不含的 0.64。
  const bonus = [entry('no-bonus', '用户偏好abc', 0, 0), entry('with-bonus', '用户偏好回复', 0, 0)]
  assert.deepEqual(retriever.retrieve('用户偏好回复', bonus).map((e) => e.id), ['with-bonus', 'no-bonus'], '整串精确命中加成 0.2 生效')
  // 两条都不含整串时同分，相关度不再分胜负 → 退回 rankOrder（id 升序）。
  const noBonus = [entry('x', '用户偏好abc', 0, 0), entry('y', 'abc用户偏好', 0, 0)]
  assert.deepEqual(retriever.retrieve('用户偏好回复', noBonus).map((e) => e.id), ['x', 'y'], '无整串加成时退回 rankOrder')
  // 平手：两条同分同覆盖率，退回避旧规矩（召回次数 → 更新时间 → id）。
  const tied = [entry('a', '用户偏好：回复用中文', 1, 0), entry('b', '用户偏好：代码注释用英文', 5, 0)]
  assert.deepEqual(retriever.retrieve('用户偏好', tied).map((e) => e.id), ['b', 'a'])
})

test('KeywordRetriever：空查询零命中 / 无关联零命中 / 不截断 / 不改写入参', () => {
  const retriever = new KeywordRetriever()
  const entries = [entry('a', '用户偏好：回复用中文'), entry('b', '项目约定：测试先于实现')]
  assert.deepEqual(retriever.retrieve('', entries), [])
  assert.deepEqual(retriever.retrieve('   ', entries), [])
  assert.deepEqual(retriever.retrieve('量子引力', entries), [], '全无关联则零命中')
  assert.deepEqual(retriever.retrieve('用户偏好', []), [], '空候选零命中')
  const many = Array.from({ length: 25 }, (_, index) => entry(`id-${String(index).padStart(2, '0')}`, '用户偏好：回复用中文', 0, 25 - index))
  const before = many.map((item) => item.id)
  assert.equal(retriever.retrieve('用户偏好', many).length, 25, '命中集不截断（截断由调用方 slice 决定）')
  assert.deepEqual(many.map((item) => item.id), before, '排序不改写入参数组')
})

test('KeywordRetriever：热度进主分 = 量 × 衰减，久未被召回即失温', () => {
  const retriever = new KeywordRetriever()
  const now = Date.UTC(2026, 0, 31)
  const base = { text: '用户偏好：回复用中文', tags: [], updatedAt: now }
  const entries = [
    { id: 'stale-hot', recallCount: 50, lastRecalled: now - 200 * 86400000, ...base },
    { id: 'live-warm', recallCount: 6, lastRecalled: now - 1 * 86400000, ...base },
  ]
  assert.deepEqual(
    retriever.retrieve('用户偏好', entries, { now }).map((e) => e.id),
    ['live-warm', 'stale-hot'],
    '累计召回 50 次但半年未召回 → 失温；近一天内的 6 次 → 保持热度',
  )
  const noStamp = [{ id: 'no-stamp', recallCount: 50, ...base }, { id: 'plain', ...base }]
  assert.deepEqual(
    retriever.retrieve('用户偏好', noStamp, { now }).map((e) => e.id),
    ['no-stamp', 'plain'],
    '缺上次召回时间戳不算热（退回 rankOrder 的召回次数序）',
  )
})

test('KeywordRetriever：新旧进主分——同样相关的新条目浮上来', () => {
  const retriever = new KeywordRetriever()
  const now = Date.UTC(2026, 0, 31)
  const entries = [
    entry('old', '用户偏好：回复用中文', 0, now - 300 * 86400000),
    entry('new', '用户偏好：回复用中文', 0, now),
  ]
  assert.deepEqual(retriever.retrieve('用户偏好', entries, { now }).map((e) => e.id), ['new', 'old'])
})

test('KeywordRetriever：标签面也参与匹配（折权），正文命中优先', () => {
  const retriever = new KeywordRetriever()
  const now = Date.UTC(2026, 0, 31)
  const entries = [
    { id: 'tag', text: '一些别的记录', tags: ['用户偏好'], recallCount: 0, updatedAt: now },
    { id: 'body', text: '用户偏好：回复用中文', tags: [], recallCount: 0, updatedAt: now },
  ]
  assert.deepEqual(retriever.retrieve('用户偏好', entries, { now }).map((e) => e.id), ['body', 'tag'], '只在标签里命中的条目也能召回，但排在正文命中之后')
})

test('KeywordRetriever：无 tags 的条目与旧实现逐字一致（向后兼容）', () => {
  const retriever = new KeywordRetriever()
  const entries = [entry('x', '用户偏好abc', 0, 0), entry('y', 'abc用户偏好', 0, 0)]
  assert.deepEqual(retriever.retrieve('用户偏好回复', entries).map((e) => e.id), ['x', 'y'])
})

test('SubstringRetriever：大小写不敏感子串过滤 + 召回频次排序（不截断）', () => {
  const retriever = new SubstringRetriever()
  assert.equal(retriever.id, 'substring')
  assert.equal(retriever.kind, 'substring')
  const entries = [
    entry('a', '用户偏好：回复用中文', 0, 1),
    entry('b', '用户偏好：代码注释用英文', 9, 0),
    entry('c', '项目约定：测试先于实现', 0, 0),
  ]
  const hits = retriever.retrieve('用户偏好', entries)
  assert.deepEqual(hits.map((e) => e.id), ['b', 'a'])
  assert.deepEqual(retriever.retrieve('不存在', entries), [])
  assert.deepEqual(retriever.retrieve('用户偏好', entries).length, 2)
})

test('VectorRetriever：按余弦相似度召回（伪嵌入 token 重叠）', () => {
  const embedding = new FakeEmbeddingProvider()
  const retriever = new VectorRetriever({ embedding })
  assert.equal(retriever.id, 'vector')
  assert.equal(retriever.kind, 'vector')
  const entries = [
    entry('q', 'quantum gravity is hard'),
    entry('l', 'favorite drink is lapsang souchong'),
  ]
  const ranked = retriever.retrieve('tea lapsang', entries)
  assert.deepEqual(ranked.map((e) => e.id), ['l', 'q'])
})

test('VectorRetriever：空候选直接返回空；缺 embedding 响亮失败', () => {
  const embedding = new FakeEmbeddingProvider()
  assert.deepEqual(new VectorRetriever({ embedding }).retrieve('x', []), [])
  assert.throws(() => new VectorRetriever({}), (error) => error instanceof InvalidInputError)
  assert.throws(() => new VectorRetriever({ embedding: null }), (error) => error instanceof InvalidInputError)
})

test('detectVectorBackend：无 provider 不可用；伪嵌入不计入可用；语义 provider 可用', () => {
  assert.deepEqual(detectVectorBackend(), { available: false, sqliteVec: false, reason: 'no embedding provider available' })
  assert.deepEqual(
    detectVectorBackend({ embedding: new FakeEmbeddingProvider() }),
    { available: false, sqliteVec: false, reason: 'embedding provider is not semantic' },
    '伪嵌入 semantic=false，不得计入可用性（否则中文召回会被静默关掉）',
  )
  const semantic = { id: 'real', name: 'Real', description: 'semantic', dimensions: 8, semantic: true, embed: (texts) => texts.map(() => Array.from({ length: 8 }, () => 0)) }
  assert.deepEqual(detectVectorBackend({ embedding: semantic }), { available: true, sqliteVec: false })
})

test('RetrievalProviderRegistry：register 可逆 / list 排序 / get / resolve / 冲突', () => {
  const registry = new RetrievalProviderRegistry()
  const substring = new SubstringRetriever()
  const disposer = registry.register(substring)
  assert.deepEqual(registry.list().map((p) => p.id), ['substring'])
  assert.equal(registry.get('substring'), substring)
  assert.equal(registry.resolve('substring'), substring)
  assert.throws(() => registry.register(new SubstringRetriever()), (error) => error instanceof InvalidInputError)
  assert.throws(() => registry.resolve('nope'), (error) => error instanceof RetrievalNotFoundError)
  disposer()
  assert.equal(registry.get('substring'), undefined)
})

test('RetrievalProviderRegistry：非法契约响亮失败', () => {
  const registry = new RetrievalProviderRegistry()
  assert.throws(() => registry.register(null), (error) => error instanceof InvalidInputError)
  assert.throws(() => registry.register({ id: 'Bad_Id', name: 'x', description: 'x', kind: 'vector', retrieve: () => [] }), (error) => error instanceof InvalidInputError)
  assert.throws(() => registry.register({ id: 'ok', name: '', description: 'x', kind: 'vector', retrieve: () => [] }), (error) => error instanceof InvalidInputError)
  assert.throws(() => registry.register({ id: 'ok', name: 'x', description: '', kind: 'vector', retrieve: () => [] }), (error) => error instanceof InvalidInputError)
  assert.throws(() => registry.register({ id: 'ok', name: 'x', description: 'x', kind: 'fuzzy', retrieve: () => [] }), (error) => error instanceof InvalidInputError)
  assert.throws(() => registry.register({ id: 'ok', name: 'x', description: 'x', kind: 'vector' }), (error) => error instanceof InvalidInputError)
})

/** 集成挂载：临时库 + 自动放行审批 + 可选 retrieval 配置。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-retrieval-'))
  const dbPath = path.join(dir, 'memory.db')
  const mock = createMockCtx()
  mock.ctx.approval = { request: async () => 'allowed-once', overrideOf: () => undefined, config: { policy: 'auto' } }
  mock.ctx.provide('commands', { register() { return () => {} } })
  apply(mock.ctx, {
    enabled: true,
    dbPath,
    budgets: DEFAULT_BUDGETS,
    writePolicy: 'auto',
    language: 'en',
    recall: { historyLimitDefault: 8, snippetCap: 5, snippetChars: 300, windowDays: 30 },
    retrieval: opts.retrieval ?? { vector: false },
  })
  return { dir, mock }
}

function teardown(mounted) {
  mounted.mock.dispose()
  rmSync(mounted.dir, { recursive: true, force: true })
}

test('retrieval 接线：只有伪嵌入时 vector=true 也回落 keyword（不静默关掉中文召回）', (t) => {
  const mounted = mount({ retrieval: { vector: true } })
  t.after(() => teardown(mounted))
  const { mock } = mounted
  const embeddings = mock.services.get('memoryEmbedding')
  const retrievers = mock.services.get('memoryRetrieval')
  assert.ok(embeddings, 'memoryEmbedding 服务已提供')
  assert.ok(retrievers, 'memoryRetrieval 服务已提供')
  assert.ok(embeddings.get('fake-hash'), '默认伪嵌入 provider 已注册')
  assert.equal(embeddings.firstSemantic(), undefined, '伪嵌入声明 semantic=false，不算语义 provider')
  assert.ok(retrievers.get('substring'), '内置 substring 检索器已注册')
  assert.equal(retrievers.get('vector'), undefined, '只有伪嵌入时不装 vector 检索器（回落 keyword）')
})

test('retrieval 接线：vector=false（默认）不注册 vector 检索器', (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const retrievers = mounted.mock.services.get('memoryRetrieval')
  assert.equal(retrievers.get('vector'), undefined)
})

test('memory_recall：vector=true 但只有伪嵌入 → 走 keyword，全无关联仍零命中', async (t) => {
  const mounted = mount({ retrieval: { vector: true } })
  t.after(() => teardown(mounted))
  const service = mounted.mock.services.get('memory')
  const session = makeSession()
  const write = { agent: makeAgent(session) }
  await service.add({ track: 'user', scope: 'user-global', text: '用户偏好：回复用中文' }, write)
  await service.add({ track: 'user', scope: 'user-global', text: '项目约定：测试先于实现' }, write)
  const tool = mounted.mock.tools.find((t) => t.name === 'memory_recall')
  const hit = await tool.execute({ query: '偏好' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(hit.ok, true)
  assert.ok(hit.memory.total >= 1, '中文短词仍召回')
  assert.equal(hit.memory.entries[0].text, '用户偏好：回复用中文')
  // 伪嵌入若接管，VectorRetriever 会「全量返回、只排序」——全无关联也会吐出一堆条目。
  // 这条断言正是那种静默降级的探测器：走 keyword 时它必须为零命中。
  const miss = await tool.execute({ query: '量子引力' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(miss.memory.total, 0, '全无关联则零命中（被伪嵌入接管时这里会返回全部条目）')
})

test('memory_recall：默认 keyword 主路径（命中任一词元即可召回，不要求整串）', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const service = mounted.mock.services.get('memory')
  const session = makeSession()
  await service.add({ track: 'user', scope: 'user-global', text: 'favorite drink is lapsang souchong' }, { agent: makeAgent(session) })
  const tool = mounted.mock.tools.find((t) => t.name === 'memory_recall')
  const hit = await tool.execute({ query: 'lapsang' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(hit.memory.total, 1)
  const multi = await tool.execute({ query: 'tea lapsang' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(multi.memory.total, 1, '多词查询命中任一词元即召回（旧 substring 路径此处零命中）')
  assert.equal(multi.memory.entries[0].text, 'favorite drink is lapsang souchong')
})

test('memory_recall：默认 keyword 主路径下全无关联仍零命中', async (t) => {
  const mounted = mount()
  t.after(() => teardown(mounted))
  const service = mounted.mock.services.get('memory')
  const session = makeSession()
  await service.add({ track: 'user', scope: 'user-global', text: 'favorite drink is lapsang souchong' }, { agent: makeAgent(session) })
  const tool = mounted.mock.tools.find((t) => t.name === 'memory_recall')
  const miss = await tool.execute({ query: 'quantum gravity' }, makeExec({ agent: makeAgent(session) }))
  assert.equal(miss.memory.total, 0)
  assert.deepEqual(miss.memory.entries, [])
})

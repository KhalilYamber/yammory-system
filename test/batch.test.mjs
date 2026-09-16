// test/batch.test.mjs — 批次留痕与审计重建（F8 批次面）。
//
// 本小类的全部价值在一条上：**一轮自动整理可以被审计逐条还原**——批次号贯穿产出条目、
// 降级条目与审计行，事后仅凭审计就能说清「合了哪些 id、产出哪一条、谁干的、何时」。
// 用例沿三条线钉：
// ① 贯穿——同一批次号出现在产出条目、全部降级条目与全部合并审计行上；
// ② 重建——batchReport 只读还原源 id 清单 / 产出条目 id / 来源 / 会话 / 起止时间戳；
// ③ 只读——按批查询连查两次，库、审计与审批门三者零变动（也不落新审计行）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryProtocolCore, AUTO_TIDY_SOURCE } from '../lib/protocol.mjs'
import { openMemoryStore } from '../lib/store.mjs'
import { ERROR_CODES, SCHEMA_VERSION } from '../lib/constants.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const UNKNOWN_BATCH = '00000000-0000-4000-8000-000000000000'

/** 真 store ＋ 协议核心（审批全放行；gate 记录调用，用来证明只读面不碰审批门）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-batch-'))
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  /** @type {object[]} */
  const gateCalls = []
  const core = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    gate: async (/** @type {object} */ payload) => { gateCalls.push(payload); return 'allowed-once' },
    emit: () => {},
  })
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, core, gateCalls, cleanup }
}

const writeCtx = (/** @type {string} */ sessionId) => ({ agent: { session: { id: sessionId, header: { cwd: '/w' } } } })
const rawAudit = (/** @type {{db: {prepare: (sql: string) => {all: () => unknown[]}}}} */ store) =>
  /** @type {Array<{action: string, entry_id: string | null, text: string | null, source: string, batch_id: string | null}>} */ (
    store.db.prepare('SELECT action, entry_id, text, source, batch_id FROM audit ORDER BY seq').all()
  )
const countRows = (/** @type {{db: {prepare: (sql: string) => {get: () => unknown}}}} */ store, /** @type {string} */ table) =>
  Number(/** @type {{n: number}} */ (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n)
/** 合成候选（同桶、纯标点差异 → 判 auto）。 */
const addPair = (/** @type {{insertEntry: (input: object) => {id: string}}} */ store, /** @type {string} */ text) => [
  store.insertEntry({ track: 'user', scope: 'user-global', text }),
  store.insertEntry({ track: 'user', scope: 'user-global', text: `${text}。` }),
]

test('批次留痕：批次号贯穿产出条目、降级条目与全部合并审计行', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')

  const result = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-batch'))
  assert.equal(typeof result.batchId, 'string', '回执带批次号')
  assert.ok(result.batchId.length > 0, '批次号非空')
  assert.equal(result.entry?.batchId, result.batchId, '产出条目带批次号')
  assert.equal(store.entryById(a.id)?.batchId, result.batchId, '降级条目 a 带批次号')
  assert.equal(store.entryById(b.id)?.batchId, result.batchId, '降级条目 b 带批次号')

  const rows = rawAudit(store).filter((row) => row.batch_id !== null)
  assert.equal(rows.length, 4, '本批审计行 = 2 降级 + 1 产出 + 1 摘要')
  assert.ok(rows.every((row) => row.batch_id === result.batchId), '每一行都是同一个批次号')
})

test('审计重建：仅凭审计行还原源 id 清单、产出 id、来源、会话与起止时间戳', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-rebuild'))

  const report = core.batchReport(batchId)
  assert.ok(report, '批次报告非空')
  assert.deepEqual(report.sourceIds, [a.id, b.id], '源 id 清单与传入同序')
  assert.deepEqual(report.producedIds, [entry?.id], '产出条目 id')
  assert.equal(report.source, AUTO_TIDY_SOURCE, '来源 = 自动整理的来源标识')
  assert.equal(report.sessionId, 's-rebuild', '会话归属可还原')
  assert.ok(Number.isInteger(report.startedAt) && Number.isInteger(report.endedAt) && report.endedAt >= report.startedAt, '起止时间戳可还原')
  assert.deepEqual(report.entries.map((item) => item.id).sort(), [a.id, b.id, /** @type {string} */ (entry?.id)].sort(), '两侧条目都取得到')

  // 只凭 Provider 的原始行也能还原（batchReport 不引入额外信息源）
  const raw = store.auditByBatch(batchId)
  assert.deepEqual(raw.filter((row) => row.action === 'supersede').map((row) => row.entryId), [a.id, b.id])
  assert.deepEqual(raw.filter((row) => row.action === 'supersede-add').map((row) => row.entryId), [entry?.id])
})

test('审计形状：降级行 text 恒为 null，批次另有摘要行', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId, entry } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-shape'))

  const rows = store.auditByBatch(batchId)
  const demotions = rows.filter((row) => row.action === 'supersede')
  assert.equal(demotions.length, 2, '两条降级行')
  assert.ok(demotions.every((row) => row.text === null), '降级行只记 id，审计不复制正文')
  assert.ok(demotions.every((row) => row.batchId === batchId), '降级行带批次号')

  const summary = rows.filter((row) => row.action === 'consolidation')
  assert.equal(summary.length, 1, '每批一行摘要')
  assert.equal(summary[0].batchId, batchId, '摘要行带批次号')
  assert.ok(String(summary[0].text).includes(/** @type {string} */ (entry?.id)), '摘要行写明产出条目')
  assert.ok(String(summary[0].text).startsWith('superseded 2'), '摘要行写明降级条数')
})

test('按批查询为纯只读：连查两次，库、审计与审批门三者零变动', async (t) => {
  const { store, core, gateCalls, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const { batchId } = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复' }, writeCtx('s-readonly'))

  const before = { audit: countRows(store, 'audit'), entries: countRows(store, 'entries'), gates: gateCalls.length }
  const first = core.batchReport(batchId)
  const second = core.batchReport(batchId)
  assert.deepEqual(second, first, '两次结果逐字段一致')
  assert.equal(countRows(store, 'audit'), before.audit, '不落审计行')
  assert.equal(countRows(store, 'entries'), before.entries, '不改条目行')
  assert.equal(gateCalls.length, before.gates, '不走审批门')
})

test('批次边界：两批互不串；未知批次为 null；形状非法响亮拒绝', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a1, a2] = addPair(store, '偏好中文回复')
  const [b1, b2] = addPair(store, '偏好英文界面')
  const first = await core.autoTidy({ ids: [a1.id, a2.id], text: '偏好中文回复' }, writeCtx('s-1'))
  const second = await core.autoTidy({ ids: [b1.id, b2.id], text: '偏好英文界面' }, writeCtx('s-2'))
  assert.notEqual(first.batchId, second.batchId, '两批批次号不同')

  assert.deepEqual(core.batchReport(first.batchId)?.sourceIds, [a1.id, a2.id], '第一批只含自己的源 id')
  assert.deepEqual(core.batchReport(second.batchId)?.sourceIds, [b1.id, b2.id], '第二批只含自己的源 id')
  assert.deepEqual(core.batchReport(first.batchId)?.entries.map((item) => item.id).sort(), [a1.id, a2.id, /** @type {string} */ (first.entry?.id)].sort(), '第一批条目不含别批')

  assert.equal(core.batchReport(UNKNOWN_BATCH), null, '未知批次返回 null（查无此批不是异常）')
  for (const bad of ['', null, 123, undefined]) {
    assert.throws(() => core.batchReport(/** @type {never} */ (bad)), (error) => /** @type {{code?: string}} */ (error).code === ERROR_CODES.INVALID_INPUT, `形状非法（${String(bad)}）响亮拒绝`)
  }
  assert.throws(() => store.auditByBatch(''), (error) => /** @type {{code?: string}} */ (error).code === ERROR_CODES.INVALID_INPUT)
  assert.throws(() => store.entriesByBatch(''), (error) => /** @type {{code?: string}} */ (error).code === ERROR_CODES.INVALID_INPUT)
})

test('批次号不可由调用方伪造：input 里塞 batchId 不起作用，批次只属自动路径', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const [a, b] = addPair(store, '偏好中文回复')
  const forged = await core.autoTidy({ ids: [a.id, b.id], text: '偏好中文回复', batchId: 'forged' }, writeCtx('s-forge'))
  assert.notEqual(forged.batchId, 'forged', 'input 里的批次号不作数（只认核心内部铸出的那个）')
  assert.equal(core.batchReport('forged'), null, '伪造批次号查无此批')

  // 普通整理（非自动路径）不产批次：三个面全为 null
  const [c, d] = addPair(store, '偏好中文回复')
  const plain = await core.supersede({ ids: [c.id, d.id], text: '偏好中文回复' }, writeCtx('s-plain'))
  assert.equal(plain.entry?.batchId ?? null, null, '普通整理的产出条目无批次号')
  assert.equal(store.entryById(c.id)?.batchId ?? null, null, '普通整理的降级条目无批次号')
  assert.ok(rawAudit(store).filter((row) => row.entry_id === c.id || row.entry_id === d.id).every((row) => row.batch_id === null), '普通整理的审计行无批次号')
})

test('v7 → v8 迁移：批次列就位，旧数据原样保留且批次为空', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-batch-migrate-'))
  const dbPath = path.join(dir, 'memory.db')
  const v7 = new DatabaseSync(dbPath)
  v7.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE entries (id TEXT PRIMARY KEY, track TEXT NOT NULL, scope TEXT NOT NULL, workspace_key TEXT NOT NULL DEFAULT '',
      agent_key TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, source TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_id TEXT,
      facet TEXT, level INTEGER, status TEXT NOT NULL DEFAULT 'active', last_recalled INTEGER, recall_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, track TEXT,
      scope TEXT, entry_id TEXT, text TEXT, outcome TEXT, source TEXT, session_id TEXT);
    INSERT INTO entries (id, track, scope, workspace_key, text, source, created_at, updated_at)
      VALUES ('e-1', 'user', 'user-global', '', '旧库里的条目', 'dsh-memento', 1, 1);
    INSERT INTO meta (key, value) VALUES ('schema_version', '7');
  `)
  v7.close()

  const store = openMemoryStore(dbPath)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal(SCHEMA_VERSION, 8, '本版本 schema 为 v8')
  assert.equal(String(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value), '8', '迁移后回填 v8')
  const columnsOf = (/** @type {string} */ table) => /** @type {Array<{name: string}>} */ (store.db.prepare(`PRAGMA table_info(${table})`).all()).map((info) => info.name)
  assert.ok(columnsOf('entries').includes('batch_id'), 'entries.batch_id 就位')
  assert.ok(columnsOf('audit').includes('batch_id'), 'audit.batch_id 就位')
  assert.equal(store.listEntries().length, 1, '旧条目原样保留')
  assert.equal(store.listEntries()[0].batchId, null, '旧条目批次为空')
  assert.deepEqual(store.auditByBatch(UNKNOWN_BATCH), [], '新列的按批查询就位且为空')
})

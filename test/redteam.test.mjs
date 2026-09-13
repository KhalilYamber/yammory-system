// test/redteam.test.mjs — 红队修复的回归测试（Provider / 协议核心 / 观察三层的窄口）。
// 每条对应 2026-09-13 红队报告里的一个可复现问题，把洞钉住，防止重开。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryStore } from '../lib/store.mjs'
import { MemoryProtocolCore } from '../lib/protocol.mjs'
import { extractHumanMessages } from '../lib/observe.mjs'
import { SCHEMA_VERSION } from '../lib/constants.mjs'

const BUDGETS = { user: { userGlobal: 2000, workspace: 2000 }, agent: { userGlobal: 2000, workspace: 2000 } }
const WRITE = { agent: { session: { id: 's-red', header: { cwd: '/w' } } } }

/** 独立临时库 + 协议核心（自动放行的真 gate）。 */
function tempCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-redteam-'))
  const dbPath = path.join(dir, 'memory.db')
  const store = openMemoryStore(dbPath)
  const core = new MemoryProtocolCore({
    store,
    budgets: BUDGETS,
    writePolicy: 'ask',
    gate: async () => 'allowed-once',
    emit: () => {},
  })
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { dir, dbPath, store, core, cleanup }
}

test('红队②：text 含 U+0000 → 落盘前响亮拒绝（否则 node:sqlite 静默截断）', (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  assert.throws(
    () => store.insertEntry({ track: 'user', scope: 'user-global', text: 'a\u0000b' }),
    (error) => error.code === 'INVALID_INPUT',
  )
  assert.throws(
    () => store.replaceEntry({ track: 'user', scope: 'user-global', text: 'x\u0000y', match: 'zzz' }),
    (error) => error.code === 'INVALID_INPUT',
  )
  assert.equal(store.listEntries().length, 0, '带 NUL 的文本绝不落盘')
})

test('红队③：tags 元素非字符串 → 落盘前响亮拒绝（防一条脏标签毒化整库）', (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  for (const bad of [[null], [123], ['ok', {}], ['a\u0000b']]) {
    assert.throws(
      () => store.insertEntry({ track: 'user', scope: 'user-global', text: 'x', tags: bad }),
      (error) => error.code === 'INVALID_INPUT',
    )
  }
  assert.equal(store.listEntries().length, 0)
  // 库仍可读：没有脏标签进库
  assert.doesNotThrow(() => store.listEntries())
})

test('红队④：schema_version 行丢失后重开自愈（幂等迁移，不死胡同）', (t) => {
  const { dir, dbPath, store } = tempCore()
  store.insertEntry({ track: 'user', scope: 'user-global', text: '保命条目' })
  store.close()
  // 直接把版本行删掉（模拟损坏）；旧实现会从 0 重跑迁移并撞上「表已存在」而永久打不开。
  const raw = new DatabaseSync(dbPath)
  raw.prepare('DELETE FROM meta WHERE key = ?').run('schema_version')
  raw.close()
  const reopened = openMemoryStore(dbPath)
  t.after(() => { reopened.close(); rmSync(dir, { recursive: true, force: true }) })
  const row = reopened.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  assert.equal(Number(row.value), SCHEMA_VERSION, '版本行被回填')
  assert.equal(reopened.listEntries().length, 1, '旧数据保留')
})

test('红队⑧：queryEntries 非法 track/scope → 结构化 INVALID_INPUT，不抛裸 SQLite 错', (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  assert.throws(() => store.queryEntries({ track: {} }), (error) => error.code === 'INVALID_INPUT')
  assert.throws(() => store.queryEntries({ scope: [] }), (error) => error.code === 'INVALID_INPUT')
  assert.throws(() => store.queryEntries({ track: 'user', scope: 'bogus' }), (error) => error.code === 'INVALID_INPUT')
})

test('红队⑩：extractHumanMessages 的 maxChars<=0 不再产出超长串（slice(0,-1) 反噬）', () => {
  const long = 'x'.repeat(500)
  const events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: long }] } }]
  for (const maxChars of [0, -5, 0.5, Number.NaN]) {
    const { messages } = extractHumanMessages(events, maxChars)
    assert.equal(messages.length, 1)
    assert.ok(messages[0].text.length <= 1, `maxChars=${String(maxChars)} 时应截断到 ≤1 字符，实际 ${messages[0].text.length}`)
    assert.equal(messages[0].truncated, true)
  }
})

test('红队⑨：add(undefined/null) → 结构化 INVALID_INPUT，不抛裸 TypeError', async (t) => {
  const { core, cleanup } = tempCore()
  t.after(cleanup)
  for (const input of [undefined, null, 'nope', 42]) {
    await assert.rejects(() => core.add(input, WRITE), (error) => error.code === 'INVALID_INPUT')
  }
})

test('红队⑥：伪造 write.gate 被拒（只有内部登记过的传输可覆盖审批门）', async (t) => {
  const { store, core, cleanup } = tempCore()
  t.after(cleanup)
  const forged = async () => 'allowed-once'
  await assert.rejects(
    () => core.add({ track: 'user', scope: 'user-global', text: 'x' }, { ...WRITE, gate: forged }),
    (error) => error.code === 'INVALID_INPUT',
  )
  assert.equal(store.listEntries().length, 0, '伪造 gate 的写没有落盘')
})

test('红队⑦：replace 乐观锁——版本前置不满足即 STALE_WRITE，不静默覆盖', async (t) => {
  const { store, cleanup } = tempCore()
  t.after(cleanup)
  const entry = store.insertEntry({ track: 'user', scope: 'user-global', text: '原始内容' })
  // 第一次替换把版本推到 2
  store.replaceEntry({ track: 'user', scope: 'user-global', match: '原始内容', text: '第一次改' })
  assert.throws(
    () => store.replaceEntry({ track: 'user', scope: 'user-global', match: '第一次改', text: '第二次改', expectedVersion: entry.version }),
    (error) => error.code === 'STALE_WRITE' && error.details.expected === 1 && error.details.actual === 2,
  )
  assert.equal(store.queryEntries({ track: 'user', scope: 'user-global', text: '第一次改' }).total, 1, '并发写保留')
  assert.equal(store.queryEntries({ track: 'user', scope: 'user-global', text: '第二次改' }).total, 0, '落后版本没写进去')
})

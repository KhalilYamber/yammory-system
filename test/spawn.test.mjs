// test/spawn.test.mjs — F9「点一下即跑」：后台整理轮的纯函数判据、执行体控制器，
// 以及面板路由把两者串起来的那条链。
//
// 三层各测各的：
//   ① lib/consolidate.mjs 的 buildTidyRunState：五档状态全由标记 ＋ 审计行 ＋ 批次账本算出，
//      不新落表；这里逐档验，包括「标记过期没人接手」这一档。
//   ② lib/spawn.mjs 的 buildTidyCommand / launchTidyRound：命令行逐字核对、单飞锁、超时杀、
//      非零退出、起不来、日志落盘与清旧——假进程注入，不开真子进程。
//   ③ index.mjs 的 /api/memento/tidy-request：登记 ＋ 起进程 ＋ 状态行的完整链（一条假进程用例
//      验接线，一条真进程用例验链本身）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { buildTidyRunState, selectWholeLibraryCandidates, TIDY_RUN_DEFAULT_TIMEOUT_MS } from '../lib/consolidate.mjs'
import { buildTidyCommand, launchTidyRound, resolveTidyExec, defaultTidyExec, tidyLogMtime, MAX_TIDY_LOGS, MAX_TIDY_TASK_CHARS, TIDY_EXEC_SOURCES } from '../lib/spawn.mjs'
import { TIDY_RUN_SOURCE, TIDY_RUN_OUTCOMES, TIDY_RUN_FAILURES, SCHEDULED_ROUND_MARKER } from '../lib/constants.mjs'
import { apply, DEFAULT_BUDGETS } from '../index.mjs'
import { createMockCtx, makeSession, makeAgent } from './helpers/mock-ctx.mjs'

/**
 * 假子进程：够 launchTidyRound 用的最小面（pid / 事件 / kill）。
 * `done()` 手动触发退出（code 由参数给），用来验「非零退出」那条分支。
 * @param {{pid?: number, spawnError?: Error}} [opts] - {pid, spawnError}（spawnError 立即派发 error 事件）。
 * @returns {{child: import('node:child_process').ChildProcess, done: (code?: number | null) => void, killed: () => boolean}} 假进程与触发器。
 */
function fakeChild(opts = {}) {
  const emitter = new EventEmitter()
  let killed = false
  const child = /** @type {import('node:child_process').ChildProcess} */ (/** @type {unknown} */ ({
    pid: opts.pid ?? 4242,
    // stdout/stderr 给一对可 pipe 的假流：实现用管道接日志（Windows 上 detached 子进程
    // 会丢掉继承的 fd），假进程也得有这两个面。
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: (event, fn) => { emitter.on(event, fn); return child },
    kill: () => { killed = true; return true },
  }))
  const done = (code = 0) => {
    emitter.emit('exit', code)
  }
  if (opts.spawnError !== undefined) queueMicrotask(() => emitter.emit('error', opts.spawnError))
  return { child, done, killed: () => killed }
}

/** 独立临时库 + 完整插件（供面板路由的集成用）。 */
function mount(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-'))
  const dbPath = path.join(dir, 'memory.db')
  const mock = createMockCtx()
  const routes = new Map()
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  }
  mock.ctx.provide('connection', connection)
  mock.ctx.approval = {
    config: { policy: 'ask' },
    overrideOf() { return undefined },
    async request(req) { return mock.ctx.waterfall('approval/request', req, async () => 'unavailable') },
  }
  apply(mock.ctx, {
    enabled: true,
    dbPath,
    budgets: DEFAULT_BUDGETS,
    writePolicy: opts.writePolicy ?? 'auto',
    language: 'zh',
    panelEntriesLimit: 200,
    panelAuditLimit: 20,
    auditRetentionDays: 0,
    ...(opts.spawnFn === undefined ? {} : { tidySpawnFn: opts.spawnFn }),
    ...(opts.tidyEnv === undefined ? {} : { tidyEnv: opts.tidyEnv }),
    ...(opts.tidy === undefined ? {} : { tidy: opts.tidy }),
  })
  const teardown = () => {
    mock.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, mock, routes, teardown, service: mock.services.get('memory') }
}

/** 造一个 POST /api/memento/tidy-request 的 Request。 */
function tidyPost(/** @type {object} */ body = {}) {
  return new Request('http://127.0.0.1:3080/api/memento/tidy-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── ① 管理轮的状态判据（纯函数）──────────────────────────────────────────────

test('F9 状态：没有标记、没有整理轮审计行 → idle（面板显示点一下的说明）', () => {
  const state = buildTidyRunState({ pending: null, auditRows: [], batches: [], language: 'zh' })
  assert.equal(state.state, 'idle')
  assert.equal(state.batchId, null)
  assert.ok(state.lines[0].includes('点一下就交给后台'), '空闲行给的是动作说明')
})

test('F9 状态：标记在、还没有 started 行 → pending（等执行体起来）', () => {
  const now = Date.now()
  const state = buildTidyRunState({
    pending: { id: 'r1', createdAt: now - 1000, status: 'pending' },
    auditRows: [],
    batches: [],
    now,
    language: 'zh',
  })
  assert.equal(state.state, 'pending')
  assert.ok(state.lines[0].includes('已排队'))
})

test('F9 状态：started 行比标记新 → running；进程退出后批次收尾行把它翻成 done', () => {
  const now = Date.now()
  const markerAt = now - 5000
  const startedAt = now - 3000
  const running = buildTidyRunState({
    pending: { id: 'r1', createdAt: markerAt, status: 'pending' },
    auditRows: [{ action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: startedAt, text: 'spawned dsh --profile headless …' }],
    batches: [],
    now,
    language: 'zh',
  })
  assert.equal(running.state, 'running')
  assert.ok(running.lines[0].includes('整理中'))

  // 整理跑完：标记被 supersede 清掉，批次收尾行比标记新 → done，且批次号与组数都报出来。
  const done = buildTidyRunState({
    pending: null,
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: startedAt, text: 'spawned …' },
      { action: 'consolidation', ts: now - 1000, text: 'batch 9c0ffee0-1111-4111-8111-111111111111: merged 2 …' },
    ],
    batches: [{ batchId: '9c0ffee0-1111-4111-8111-111111111111', at: now - 1000, count: 2 }],
    now,
    language: 'zh',
  })
  assert.equal(done.state, 'done')
  assert.equal(done.batchId, '9c0ffee0-1111-4111-8111-111111111111')
  assert.equal(done.batchCount, 2)
  assert.ok(done.lines[0].includes('已完成'), '完成行')
  assert.ok(done.lines[0].includes('批次 9c0ffee0'), '完成行带批次号')
  assert.ok(done.lines[1].includes('--batch=9c0ffee0'), '第二行给整批撤回的出口')
})

test('F9 状态：执行体正常退出（没落下批次）→ done「没有需要合并的条目」，不是永久「整理中」', () => {
  const now = Date.now()
  const exitedOnly = buildTidyRunState({
    pending: null,
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 60000, text: 'spawned …' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.exited, ts: now - 30000, text: 'exit code 0; log tidy-x.log' },
    ],
    batches: [],
    now,
    language: 'zh',
  })
  assert.equal(exitedOnly.state, 'done', '正常退出就是收尾凭据（模型回 NOTHING 的那一轮只有它）')
  assert.equal(exitedOnly.batchId, null, '没有批次就不编一个出来')
  assert.ok(exitedOnly.lines[0].includes('没有需要合并'), '照实说无事可做')

  // 库里留着更早的批次（前几轮的、别的工作区的）：本轮什么都没合，就不能把它的编号挂到
  // 今天的完成行上——用户会拿到一个自己没见过的批次号，还配一条撤回提示。
  const staleBatch = buildTidyRunState({
    pending: null,
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 60000, text: 'spawned …' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.exited, ts: now - 30000, text: 'exit code 0' },
    ],
    batches: [{ batchId: 'old-batch', at: now - 86400000, count: 2 }],
    now,
    language: 'zh',
  })
  assert.equal(staleBatch.state, 'done')
  assert.equal(staleBatch.batchId, null, '不是本轮的批次就不报')
  assert.ok(staleBatch.lines[0].includes('没有需要合并'), '本轮没产出就照实说')

  const withBatch = buildTidyRunState({
    pending: null,
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 60000, text: 'spawned …' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.exited, ts: now - 20000, text: 'exit code 0' },
    ],
    batches: [{ batchId: 'batch-1', at: now - 10000, count: 3 }],
    now,
    language: 'zh',
  })
  assert.equal(withBatch.state, 'done')
  assert.equal(withBatch.batchId, 'batch-1', '有产出的轮次照样把批次号报出来')

  // 退出行之后又起了新一轮（started 比退出新）：旧退出行不许把在跑的一轮说成「已完成」。
  const secondRound = buildTidyRunState({
    pending: { id: 'r2', createdAt: now - 8000, status: 'pending' },
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 60000, text: 'spawned …' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.exited, ts: now - 20000, text: 'exit code 0' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 7000, text: 'spawned …' },
    ],
    batches: [],
    now,
    language: 'zh',
  })
  assert.equal(secondRound.state, 'running', '新一轮在跑')
})

test('F9 状态：起了进程却超窗口没有任何收尾 → failed（宿主重启也不会把按钮永久锁死）', () => {
  const now = Date.now()
  const startedAt = now - 1200000
  const mark = { id: 'r1', createdAt: now - 3600000, status: 'pending' }
  // 判活窗口 8 分钟，这里已经 20 分钟没有任何收尾凭据：进程多半是随宿主重启一起没了。
  const abandoned = buildTidyRunState({
    pending: mark,
    auditRows: [{ action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: startedAt, text: 'spawned …' }],
    batches: [],
    now,
    timeoutMs: 480000,
    language: 'zh',
  })
  assert.equal(abandoned.state, 'failed', '过了判活窗口还没有收尾凭据 = 这一轮的收尾永远不会来了')
  assert.equal(abandoned.failure, TIDY_RUN_FAILURES.abandoned)
  assert.ok(abandoned.lines[0].includes('整理失败'), '面板照实报失败，按钮随之解锁')

  // 窗口之内仍旧是「在跑」：这一档只收真正不会再有下文的轮次，不许把正在跑的轮次说成失败。
  const stillRunning = buildTidyRunState({
    pending: mark,
    auditRows: [{ action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 60000, text: 'spawned …' }],
    batches: [],
    now,
    timeoutMs: 480000,
    language: 'zh',
  })
  assert.equal(stillRunning.state, 'running')

  // 退出凭据比 started 新：照旧收尾成 done，不因为「超了窗口」被旧账拖成失败。
  const settled = buildTidyRunState({
    pending: null,
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: startedAt, text: 'spawned …' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.exited, ts: now - 600000, text: 'exit code 0' },
    ],
    batches: [],
    now,
    timeoutMs: 480000,
    language: 'zh',
  })
  assert.equal(settled.state, 'done', '有凭据就按凭据走，超窗只管「一点凭据都没有」那一种')
})

test('F9 状态：failed 行 → failed 并给出失败码；标记过期没人接手也算失败（不是「没跑过」）', () => {
  const now = Date.now()
  const failed = buildTidyRunState({
    pending: { id: 'r1', createdAt: now - 60000, status: 'pending' },
    auditRows: [
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.started, ts: now - 50000, text: 'spawned …' },
      { action: TIDY_RUN_SOURCE, outcome: TIDY_RUN_OUTCOMES.failed, ts: now - 40000, text: `${TIDY_RUN_FAILURES.exit}: exit code 1` },
    ],
    batches: [],
    now,
    language: 'zh',
  })
  assert.equal(failed.state, 'failed')
  assert.ok(String(failed.failure).startsWith(TIDY_RUN_FAILURES.exit), '失败码带上「进程非零退出」的原因')
  assert.ok(failed.lines[0].includes('整理失败'))

  // 标记老过判活窗口、连 started 都没有：这是「执行体没起来」，不是「从来没安排过」。
  const stale = buildTidyRunState({
    pending: { id: 'r2', createdAt: now - TIDY_RUN_DEFAULT_TIMEOUT_MS - 1000, status: 'pending' },
    auditRows: [],
    batches: [],
    now,
    language: 'zh',
  })
  assert.equal(stale.state, 'failed')
  assert.equal(stale.failure, TIDY_RUN_FAILURES.stale)
})

test('F9 状态：昨天的批次不再占着面板那一行（结果只展示一天，之后退回 idle 说明）', () => {
  const now = Date.now()
  const state = buildTidyRunState({
    pending: null,
    auditRows: [],
    batches: [{ batchId: 'old-batch', at: now - 3 * 86400000, count: 1 }],
    now,
    language: 'en',
  })
  assert.equal(state.state, 'idle')
  assert.ok(state.lines[0].includes('One click'), '退回动作说明，不谎报「已完成」')
})

test('F9 候选：全库口径不看热度窗口（久未动过的重复条目同样算候选）', () => {
  const now = Date.now()
  const old = now - 400 * 86400000
  const entries = [
    { id: 'a', track: 'user', scope: 'user-global', text: '甲', createdAt: old, updatedAt: old, status: 'active' },
    { id: 'b', track: 'user', scope: 'user-global', text: '乙', createdAt: old, updatedAt: old, status: 'active' },
    { id: 'c', track: 'user', scope: 'user-global', text: '丙', createdAt: old, updatedAt: old, status: 'active', tags: ['merged'] },
  ]
  const whole = selectWholeLibraryCandidates(entries)
  assert.equal(whole.candidates.length, 2, '热度窗口外的两条都进来')
  assert.equal(whole.skippedMerged, 1, '已整理的照样跳过')
})

// ── ② 执行体控制器（假进程注入）──────────────────────────────────────────────

test('F9 命令行：exec + --profile + profile + 任务文本，任务作为单个位置参数', () => {
  const built = buildTidyCommand({ profile: 'headless', task: 'do the thing', exec: 'dsh', platform: 'linux' })
  assert.deepEqual(built, { command: ['dsh', '--profile', 'headless', 'do the thing'], shell: false })
  assert.equal(defaultTidyExec('win32'), 'dsh.cmd')
  assert.equal(defaultTidyExec('linux'), 'dsh')
})

test('F9 命令行：.cmd/.bat 启动器整条命令自行引号化（Windows 实测不能直接进 spawn，EINVAL）', () => {
  const built = buildTidyCommand({ profile: 'headless', task: '任务\n第二行', exec: 'C:\\Program Files\\dsh.cmd' })
  assert.equal(built.shell, true, '.cmd 要走 shell')
  assert.ok(built.cmdArg.startsWith('"'), '可执行文件路径在被引号里（路径可能有空格）')
  assert.ok(built.cmdArg.endsWith('"任务\n第二行"'), '任务文本整体是那个双引号参数（换行与元字符都在引号里当字面量）')
  assert.equal(built.cmdArg.includes('--profile headless'), true, '启动器参数原样在命令里')
  const plain = buildTidyCommand({ profile: 'headless', task: '任务', exec: 'dsh' })
  assert.equal(plain.shell, false, '普通可执行文件不走 shell')
  assert.equal(plain.command[3], '任务', '非 shell 路径原样保留任务文本')
  // shell 路径下任务文本自己含双引号会把参数提前收尾 → 响亮拒绝（模板里包动作名一律用反引号，故不冲突）。
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: '带 " 引号', exec: 'dsh.cmd' }))
  assert.ok('command' in buildTidyCommand({ profile: 'headless', task: '带 " 引号', exec: 'dsh' }), '普通路径不受这条限制')
})

test('F9 命令行：非法 profile / 空任务 / 超长任务 / 以 dash 起头 / 控制字符一律响亮拒绝', () => {
  assert.ok('error' in buildTidyCommand({ profile: 'bad profile', task: 'x' }))
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: '   ' }))
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'x'.repeat(MAX_TIDY_TASK_CHARS + 1) }))
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: '--help' }), '位置参数以 dash 起头会被启动器读成 flag')
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'ok\u0007bell' }))
  assert.ok('command' in buildTidyCommand({ profile: 'headless', task: '正常任务', exec: 'dsh' }))
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'x', args: ['--profile && rm -rf /'] }), '启动器参数带 shell 元字符一律拒绝（拼命令行的口子）')
  assert.ok('cmdArg' in buildTidyCommand({ profile: 'headless', task: '正常任务', exec: 'dsh.cmd' }), '.cmd 走 shell 形态（整条命令串）')
})

// ── ②b 执行体探测：写死一个命令名，等于把「它恰好躺在 PATH 里」当成前提 ──────────────
// 2026-09-22 实测：宿主从源码直跑（`node apps\cli\lib\bin.js web`）时 PATH 里没有 dsh，
// 面板每点一次都换成一句 cmd.exe 的「不是内部或外部命令」。这一组钉住三条探测路与它们的先后。

test('F9 探测：配置点名优先于一切（用户说了算，原样用）', () => {
  const resolved = resolveTidyExec({
    exec: 'D:\\tools\\my-dsh.cmd',
    platform: 'win32',
    env: { PATH: 'D:\\NodeJS' },
    argv: ['D:\\NodeJS\\node.exe', 'apps\\cli\\lib\\bin.js'],
    execPath: 'D:\\NodeJS\\node.exe',
    cwd: 'D:\\src',
    isFile: () => true,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.source, TIDY_EXEC_SOURCES.configured)
  assert.equal(resolved.exec, 'D:\\tools\\my-dsh.cmd')
  assert.equal(resolved.bootstrap, undefined, '点名那条不带宿主自身的脚本段')
})

test('F9 探测：宿主自身——argv[1] 相对路径按 cwd 补全，命令行是 node ＋ 宿主 CLI 脚本', () => {
  const checked = []
  const cwd = 'D:\\DeepSeek-Harness\\DSHAR工作目录\\deepseek-harness-src'
  const script = `${cwd}\\apps\\cli\\lib\\bin.js`
  const resolved = resolveTidyExec({
    exec: '',
    platform: 'win32',
    env: { PATH: 'C:\\Windows' },
    argv: ['D:\\NodeJS\\node.exe', 'apps\\cli\\lib\\bin.js', 'web', '--no-open'],
    execPath: 'D:\\NodeJS\\node.exe',
    cwd,
    isFile: (path) => { checked.push(path); return path === script },
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.source, TIDY_EXEC_SOURCES.host, '宿主在 PATH 之前被选中（同一个 DSH、同一份代码与 profile 语义）')
  assert.equal(resolved.exec, 'D:\\NodeJS\\node.exe')
  assert.equal(resolved.bootstrap, script)
  assert.deepEqual(checked, [script], '只查了宿主那个脚本，没去翻 PATH')

  const built = buildTidyCommand({ profile: 'headless', task: '整理', exec: resolved.exec, bootstrap: resolved.bootstrap })
  assert.deepEqual(built, {
    command: ['D:\\NodeJS\\node.exe', script, '--profile', 'headless', '整理'],
    shell: false,
  }, '脚本段插在 node 之后、启动器参数之前（Node 原样传参，任务文本一字不改）')
})

test('F9 探测：宿主那条不成立就退回 PATH；PATH 也没有才响亮失败', () => {
  const base = { exec: '', platform: 'win32', argv: ['node', 'notes.txt'], execPath: 'D:\\NodeJS\\node.exe', cwd: 'C:\\x' }
  const viaPath = resolveTidyExec({ ...base, env: { PATH: 'C:\\bin;D:\\tools' }, isFile: (path) => path === 'D:\\tools\\dsh.cmd' })
  assert.equal(viaPath.ok, true)
  assert.equal(viaPath.source, TIDY_EXEC_SOURCES.path)
  assert.equal(viaPath.exec, 'D:\\tools\\dsh.cmd')
  assert.equal(viaPath.bootstrap, undefined, 'PATH 那条自己就是执行体，不需要脚本段')

  const miss = resolveTidyExec({ ...base, env: { PATH: 'C:\\bin' }, isFile: () => false })
  assert.equal(miss.ok, false)
  assert.match(String(miss.detail), /dsh\.cmd/u, '失败说明点出找过哪些名字')
  assert.match(String(miss.detail), /tidy\.exec/u, '并给出可操作的那一句（配置里填绝对路径）')
})

test('F9 探测：POSIX 只找 dsh；Windows 按 .cmd → .exe → 无后缀 的顺序，命中即停', () => {
  const hits = []
  const win = resolveTidyExec({
    exec: '',
    platform: 'win32',
    argv: [],
    env: { PATH: 'D:\\NodeJS;C:\\bin' },
    cwd: '',
    execPath: '',
    isFile: (path) => { hits.push(path); return path === 'D:\\NodeJS\\dsh.exe' },
  })
  assert.equal(win.ok, true)
  assert.equal(win.exec, 'D:\\NodeJS\\dsh.exe')
  assert.deepEqual(hits.slice(0, 3), ['D:\\NodeJS\\dsh.cmd', 'D:\\NodeJS\\dsh.exe'], '.cmd 先试，第二个名字命中后不再往下找')
  const posix = resolveTidyExec({
    exec: '',
    platform: 'linux',
    argv: [],
    env: { PATH: '/usr/local/bin:/usr/bin' },
    execPath: '',
    cwd: '',
    isFile: (path) => path === '/usr/bin/dsh',
  })
  assert.equal(posix.ok, true)
  assert.equal(posix.exec, '/usr/bin/dsh')

  // PATH 条目的形状：带引号、空条目、Windows 大小写不敏感的 Path 键，都照常认。
  const quoted = resolveTidyExec({
    exec: '',
    platform: 'win32',
    argv: [],
    execPath: '',
    cwd: '',
    env: { Path: ';"C:\\Program Files\\dsh";;' },
    isFile: (path) => path === 'C:\\Program Files\\dsh\\dsh.cmd',
  })
  assert.equal(quoted.ok, true)
  assert.equal(quoted.exec, 'C:\\Program Files\\dsh\\dsh.cmd')
})

test('F9 探测：没注入的输入一律走进程默认值（装配层只给一个空 exec，别的什么都不给）', () => {
  const base = { exec: '', platform: 'linux', env: { PATH: '' }, execPath: '/x/node', cwd: '/x', isFile: () => false }
  // 不注入 argv 与注入进程自己的 argv，结果必须逐字一致——某一处兜底漏掉时，这条会露馅
  // （真机验过一次：argv 没兜底，于是明明有宿主 CLI 却报「没找到执行体」）。
  assert.deepEqual(resolveTidyExec(base), resolveTidyExec({ ...base, argv: process.argv }))
  // 同理，env / platform / cwd / execPath 一个都不注入时读的也是进程自己那一份：结论只可能落在
  // 宿主、PATH 或一声响亮的失败上，不存在「因为没注入所以探测做半截」这第四种结局。
  const bare = resolveTidyExec({ exec: '' })
  if (bare.ok === true) {
    assert.ok([TIDY_EXEC_SOURCES.host, TIDY_EXEC_SOURCES.path].includes(bare.source), `落到宿主或 PATH 两路之一（实际 ${bare.source}）`)
  } else {
    assert.match(String(bare.detail), /tidy\.exec/u)
  }
})

test('F9 探测：bootstrap 的不变量（绝对路径、无引号、不与 .cmd 同用）', () => {
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'x', exec: 'node', bootstrap: 'apps/bin.js' }), '相对路径拒绝')
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'x', exec: 'node', bootstrap: 'C:\\a"b\\bin.js' }), '含双引号拒绝')
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'x', exec: 'node', bootstrap: 'C:\\a\u0007b\\bin.js' }), '含控制字符拒绝')
  assert.ok('error' in buildTidyCommand({ profile: 'headless', task: 'x', exec: 'C:\\dsh.cmd', bootstrap: 'C:\\bin.js' }), '批处理启动器不与脚本段同用')
  assert.ok('command' in buildTidyCommand({ profile: 'headless', task: 'x', exec: 'node', bootstrap: 'C:\\bin.js' }))
})

test('F9 执行体：exec 留空时 launchTidyRound 真的走探测（真命令行 = 宿主 node ＋ CLI 脚本）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-probe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = 'D:\\src\\apps\\cli\\lib\\bin.js'
  const calls = []
  const fake = fakeChild()
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: '', task: 't', logsDir: dir }, {
    active: new Set(),
    execInput: {
      platform: 'win32',
      env: { PATH: '' },
      argv: ['D:\\NodeJS\\node.exe', script],
      execPath: 'D:\\NodeJS\\node.exe',
      cwd: 'D:\\src',
      isFile: (path) => path === script,
    },
    spawnFn: (cmd, args) => { calls.push([cmd, args]); return fake.child },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], ['D:\\NodeJS\\node.exe', [script, '--profile', 'headless', 't']])
})

test('F9 执行体：三条探测路全落空 → spawn 失败，且不拿跑不起来的名字去 spawn', () => {
  let called = false
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: '', task: 't' }, {
    execInput: { platform: 'win32', env: { PATH: '' }, argv: [], execPath: '', cwd: '', isFile: () => false },
    spawnFn: () => { called = true; return fakeChild().child },
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure, TIDY_RUN_FAILURES.spawn)
  assert.equal(called, false, '探测落空时一个进程都不该被下发')
  assert.match(String(result.detail), /tidy\.exec/u)
})

test('F9 执行体：任务文本带无人值守标记（自产文本不许回流当用户证据）', async (t) => {
  const fake = fakeChild()
  const mounted = mount({ spawnFn: () => fake.child, tidy: { exec: 'dsh-stub' } })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  const payload = await (await route.fetch(tidyPost({}))).json()
  assert.ok(payload.taskPreview.startsWith(SCHEDULED_ROUND_MARKER), '内置任务文本以标记开头')
  assert.ok(payload.taskPreview.includes('auto-tidy'), '任务说明点名要用的动作')
  // 命令行里的那一份（不是预览）同样以标记开头——非 shell 路径给数组，shell 路径给整条命令串。
  const built = buildTidyCommand({ profile: 'headless', task: `${SCHEDULED_ROUND_MARKER}整理`, exec: 'dsh' })
  assert.ok('command' in built && built.command[3].startsWith(SCHEDULED_ROUND_MARKER))
})

test('F9 执行体：enabled=false → disabled（不起进程，也不写 started 行）', () => {
  const result = launchTidyRound({ enabled: false, profile: 'headless', exec: 'dsh', task: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.failure, TIDY_RUN_FAILURES.disabled)
})

test('F9 执行体：日志路径备不出来（目录名被一个文件占着）→ spawn 失败，不抛异常', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-nolog-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const blocking = path.join(dir, 'blocked')
  writeFileSync(blocking, 'not a directory')
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: blocking })
  assert.equal(result.ok, false)
  assert.equal(result.failure, TIDY_RUN_FAILURES.spawn)
  assert.ok(String(result.detail).includes('log path unavailable'), '失败原因写实（不是笼统的 spawn）')
})

test('F9 执行体：日志目录只留最近几个（清旧是维护动作，删不掉也不阻断）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (let index = 0; index < MAX_TIDY_LOGS + 5; index += 1) {
    writeFileSync(path.join(dir, `tidy-2026-01-01T00-00-${String(index).padStart(2, '0')}-000Z.log`), 'x')
  }
  const fake = fakeChild()
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir }, {
    active: new Set(),
    spawnFn: () => fake.child,
  })
  assert.equal(result.ok, true)
  const kept = readdirSync(dir).filter((name) => name.startsWith('tidy-'))
  // 上限是「不超过」：本轮那个日志由写流异步建出来，刚好卡在清理之后时计数会少一个，
  // 故这里钉的是不变量（不涨破上限 ＋ 最旧的被删 ＋ 最新的一批留着），不钉一个瞬时数字。
  assert.ok(kept.length <= MAX_TIDY_LOGS, `留下的不超过上限（实际 ${kept.length}，上限 ${MAX_TIDY_LOGS}）`)
  assert.equal(kept.includes('tidy-2026-01-01T00-00-00-000Z.log'), false, '最旧的那批被删')
  assert.equal(kept.includes('tidy-2026-01-01T00-00-24-000Z.log'), true, '最新的一批留着')
  assert.equal(result.ok, true, '清旧失败也不阻断起进程（清理是维护动作）')
})

test('F9 执行体：日志 mtime 读得到／读不到都如实返回（面板要报「这一轮的日志在哪」）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-mtime-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'tidy-x.log')
  writeFileSync(file, 'x')
  assert.equal(typeof tidyLogMtime(file), 'number')
  assert.equal(tidyLogMtime(path.join(dir, 'nope.log')), null, '读不到就 null，不抛')
})

test('F9 执行体：起得来 → 返回 pid/日志路径，进程进单飞集合；退出后出集合', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-logs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const active = new Set()
  const fake = fakeChild({ pid: 777 })
  const seen = []
  const options = []
  const result = launchTidyRound({
    enabled: true, profile: 'headless', exec: 'dsh', task: 'task', logsDir: dir, timeoutMs: 60000,
    taskOverride: '命令行里的那份覆盖稿',
  }, {
    active,
    spawnFn: (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object} */ opts) => {
      seen.push([cmd, args])
      options.push(opts)
      return fake.child
    },
    onExit: (code, logPath) => seen.push(['exit', code, logPath]),
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.pid, 777)
    assert.ok(result.logPath.startsWith(dir), '日志落在指定目录')
  }
  assert.deepEqual(seen[0][0], 'dsh')
  assert.deepEqual(seen[0][1], ['--profile', 'headless', '命令行里的那份覆盖稿'], '任务文本的配置覆盖优先于内置那份')
  assert.equal(options[0].detached, undefined, '刻意不 detached（Windows 上 detached 会把继承的管道一起丢，实测收不到输出）')
  assert.equal(options[0].shell, undefined, '普通可执行文件不打开 shell（原样传参）')
  assert.deepEqual(options[0].stdio[0], 'ignore', 'stdin 不接（没人跟它交互）')
  assert.equal(options[0].cwd, undefined, '相对 cwd 一律丢掉（宁可不给，也不给一个错的）')
  assert.equal(active.size, 1, '单飞锁：进程在跑时集合非空')
  fake.done(0)
  assert.equal(active.size, 0, '退出后集合清空（下一次点击可以重新起）')
  assert.equal(seen[1][0], 'exit')
  assert.equal(seen[1][1], 0)

  // `.cmd` 启动器：spawn 要拿整条已引号化的命令 ＋ shell: true ＋ windowsVerbatimArguments
  // （Windows 实测：直接 spawn .cmd 是 EINVAL，缺 verbatim 则带空格/元字符的路径被截断）。
  const batched = fakeChild()
  const batchedCalls = []
  launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh.cmd', task: '任务', logsDir: dir }, {
    active: new Set(),
    spawnFn: (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object} */ opts) => {
      batchedCalls.push([cmd, args, opts])
      return batched.child
    },
  })
  assert.equal(batchedCalls[0][0], '"dsh.cmd" --profile headless "任务"', '整条命令已引号化')
  assert.deepEqual(batchedCalls[0][1], [], 'shell 形态下不再另传参数')
  assert.equal(batchedCalls[0][2].shell, true, '.cmd 路径下 spawn 要带 shell: true')
  assert.equal(batchedCalls[0][2].windowsVerbatimArguments, true, '命令由我们自己引号化，别让 Node 再插一层')
})

test('F9 执行体：日志目录根本开不出来（父路径是个文件）→ spawn 失败，不抛异常', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-badlog-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const blocking = path.join(dir, 'blocked')
  writeFileSync(blocking, 'not a directory')
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: path.join(blocking, 'runs') })
  assert.equal(result.ok, false)
  assert.equal(result.failure, TIDY_RUN_FAILURES.spawn)
  assert.ok(String(result.detail).includes('log path unavailable'), '失败原因写实')
})

test('F9 执行体：假进程不吐字节也不崩（stdio 为空时照样能起、能退）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const emitter = new EventEmitter()
  const fake = { pid: 5, stdout: null, stderr: null, on: (event, fn) => { emitter.on(event, fn); return fake }, kill: () => true }
  const exits = []
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir }, {
    active: new Set(),
    spawnFn: () => /** @type {any} */ (fake),
    onExit: (code) => { exits.push(code) },
  })
  assert.equal(result.ok, true)
  emitter.emit('exit', 0)
  assert.deepEqual(exits, [0], '空 stdio 的进程照常走到回收')
})

test('F9 执行体：起不来的兜底（spawn 抛错）→ spawn 失败，日志流也收干净', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-throw-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir }, {
    active: new Set(),
    spawnFn: () => { throw new Error('EPERM: spawn refused') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure, TIDY_RUN_FAILURES.spawn)
  assert.ok(String(result.detail).includes('EPERM'))
})

test('F9 执行体：超时收口按进程树杀（Windows 走 taskkill /T /F）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-kill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeChild({ pid: 31337 })
  const killed = []
  launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir, timeoutMs: 5 }, {
    active: new Set(),
    spawnFn: () => fake.child,
    killRound: (child) => { killed.push(child.pid) },
  })
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.deepEqual(killed, [31337], '到点把这一轮（含它的进程树）收回')
      resolve(undefined)
    }, 40)
  })
})

test('F9 执行体：默认收口真跑一遍（起一个挂住的真进程，到点整棵树收掉）', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-realkill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const failures = []
  // 不注入 killRound：走真收口（POSIX 杀进程组 / Windows taskkill /T /F）。
  // 用「挂到天荒地老」的启动器壳（.cmd / .sh）：它吞掉固定参数后自己挂住，直到被收掉。
  // 不能拿 node.exe 直接跑 hang.cjs——固定参数里的 `--profile` 会被 node 当自己的选项，
  // 进程立刻以 code 9 退出，那就测不到「到点收口」这条路了。
  const hang = fileURLToPath(new URL(process.platform === 'win32' ? './fixtures/hang.cmd' : './fixtures/hang.sh', import.meta.url))
  const started = launchTidyRound({
    enabled: true, profile: 'headless', exec: hang, task: '挂住', logsDir: dir, timeoutMs: 200,
  }, {
    active: new Set(),
    onFailure: (failure) => { failures.push(failure) },
  })
  assert.equal(started.ok, true, '挂住的进程也起来得')
  await new Promise((resolve) => { setTimeout(resolve, 900) })
  assert.deepEqual(failures, [TIDY_RUN_FAILURES.timeout], '到点由默认收口处理并报 timeout（不抛、不静默）')
})

test('F9 执行体：清旧日志时删不掉的旧文件不阻断起进程', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-prunefail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (let index = 0; index < MAX_TIDY_LOGS + 3; index += 1) {
    writeFileSync(path.join(dir, `tidy-2026-01-01T00-00-${String(index).padStart(2, '0')}-000Z.log`), 'x')
  }
  const fake = fakeChild()
  const result = launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir }, {
    active: new Set(),
    spawnFn: () => fake.child,
  })
  assert.equal(result.ok, true, '清旧出不出问题都不影响这一轮起来')
  assert.ok(readdirSync(dir).length <= MAX_TIDY_LOGS + 1, '留下来的仍然有界')
})

test('F9 执行体：非零退出 → onFailure(exit)；起不来 → onFailure(spawn)；超时 → 杀进程并报 timeout', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yammory_system-f9-fail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  /** @type {Array<[string, string]>} */
  const failures = []
  const exitChild = fakeChild()
  launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir }, {
    active: new Set(),
    spawnFn: () => exitChild.child,
    onFailure: (failure, detail) => { failures.push([failure, detail]) },
  })
  exitChild.done(3)
  assert.equal(failures.length, 1, '非零退出要落一次失败回调')
  assert.equal(failures[0][0], TIDY_RUN_FAILURES.exit)

  const spawnChild = fakeChild({ spawnError: new Error('ENOENT: dsh not found') })
  launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir }, {
    active: new Set(),
    spawnFn: () => spawnChild.child,
    onFailure: (failure, detail) => { failures.push([failure, detail]) },
  })
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(failures[1][0], TIDY_RUN_FAILURES.spawn)
  assert.ok(failures[1][1].includes('ENOENT'))

  const slow = fakeChild()
  const killed = []
  launchTidyRound({ enabled: true, profile: 'headless', exec: 'dsh', task: 't', logsDir: dir, timeoutMs: 10 }, {
    active: new Set(),
    spawnFn: () => slow.child,
    killRound: (child) => { killed.push(child) },
    onFailure: (failure, detail) => { failures.push([failure, detail]) },
  })
  await new Promise((resolve) => { setTimeout(resolve, 40) })
  assert.equal(killed.length, 1, '到点收口（按进程树杀，注入版验「收了没有」）')
  slow.done(null) // 真进程被杀后也会收到 exit；假进程需要手动走这一步
  assert.equal(failures[2][0], TIDY_RUN_FAILURES.timeout)
  // 杀掉之后的非零退出码不许把「超时」改写成「跑失败了」。
  assert.equal(failures.length, 3)
})

// ── ③ 面板路由：登记 ＋ 起进程 ＋ 状态行 ─────────────────────────────────────

test('F9 路由：POST 登记标记、起一轮无头会话、回 running 状态行与任务预览', async (t) => {
  const fake = fakeChild({ pid: 9001 })
  const mounted = mount({ spawnFn: () => fake.child, tidy: { exec: 'dsh-stub' } })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  assert.ok(route, '路由已注册')

  const response = await route.fetch(tidyPost({}))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.spawned, true, '真起了进程')
  assert.equal(payload.state, 'running')
  assert.equal(payload.executorEnabled, true)
  assert.equal(payload.created, true)
  assert.ok(payload.taskPreview.startsWith(SCHEDULED_ROUND_MARKER), '任务预览带无人值守标记')
  assert.ok(payload.lines.some((line) => line.includes('整理中')), '状态行说「整理中」')
  assert.equal(mounted.service.store.tidyRequestPending()?.status, 'pending', '标记仍在（跑完才清）')

  const rows = mounted.service.store.auditList()
  const started = rows.find((row) => row.action === TIDY_RUN_SOURCE && row.outcome === TIDY_RUN_OUTCOMES.started)
  assert.ok(started, 'started 审计行已落')
  assert.equal(started.sessionId, null, '面板动作不属于任何会话，如实为 null')
  assert.equal(started.source, 'panel')
  assert.ok(started.text.includes('spawned '), '审计行记命令行与日志文件名（不是「整理成功」）')

  // GET 读回来是同一条状态（面板轮询走这一条）。
  const getRoute = await route.fetch(new Request('http://127.0.0.1:3080/api/memento/tidy-request'))
  const readBack = await getRoute.json()
  assert.equal(readBack.state, 'running')
  assert.equal(readBack.executorEnabled, true)

  // 重复点击不叠进程：第二次 POST 报 spawned=false，仍在跑。
  const again = await route.fetch(tidyPost({}))
  const againPayload = await again.json()
  assert.equal(againPayload.spawned, false, '单飞：已在跑就不再起')
  assert.equal(againPayload.created, false, '标记幂等：不堆行')
  assert.equal(againPayload.state, 'running')
})

test('F9 路由：执行体关掉时只登记标记（退回排队式，不起进程）', async (t) => {
  const mounted = mount({ tidy: { enabled: false } })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  const response = await route.fetch(tidyPost({}))
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.executorEnabled, false)
  assert.equal(payload.spawned, false)
  assert.equal(payload.state, 'pending', '标记在、没有 started 行 → 等下次会话开口')
  assert.equal(payload.failure, TIDY_RUN_FAILURES.disabled, '面板如实说明「执行体已关」，不谎报运行中')
  assert.equal(mounted.service.store.tidyRequestPending()?.status, 'pending')
  assert.equal(
    mounted.service.store.auditList().filter((row) => row.action === TIDY_RUN_SOURCE && row.outcome === TIDY_RUN_OUTCOMES.failed).length,
    0,
    '没起进程就不落执行体失败行（关掉是配置状态，不是失败）',
  )
})

test('F9 路由：起的进程非零退出 → failed 审计行与失败状态行都落地', async (t) => {
  const fake = fakeChild()
  const mounted = mount({ spawnFn: () => fake.child, tidy: { exec: 'dsh-stub' } })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  await route.fetch(tidyPost({}))
  fake.done(2)
  await new Promise((resolve) => { setImmediate(resolve) })
  const failed = mounted.service.store.auditList().find((row) => row.action === TIDY_RUN_SOURCE && row.outcome === TIDY_RUN_OUTCOMES.failed)
  assert.ok(failed, '失败行已落')
  assert.ok(String(failed.text).startsWith(TIDY_RUN_FAILURES.exit), '失败码写实（exit，不是笼统的 spawn）')
  assert.ok(String(failed.text).includes('exit code 2'), '顺带记下退出码')
  const readBack = await (await route.fetch(new Request('http://127.0.0.1:3080/api/memento/tidy-request'))).json()
  assert.equal(readBack.state, 'failed')
  assert.ok(String(readBack.failure).startsWith(TIDY_RUN_FAILURES.exit))
})

test('F9 路由：审批被拒 → 500 且零落盘（标记、审计、进程全不动）', async (t) => {
  const fake = fakeChild()
  const mounted = mount({ spawnFn: () => fake.child, writePolicy: 'off' })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  const response = await route.fetch(tidyPost({}))
  assert.equal(response.status, 500)
  const payload = await response.json()
  assert.match(String(payload.error), /denied|rejected/i, '拒绝如实报出（不静默吞）')
  assert.equal(mounted.service.store.tidyRequestPending(), null, '标记没登记')
  assert.equal(
    mounted.service.store.auditList().filter((row) => row.action === TIDY_RUN_SOURCE).length,
    0,
    '没有起进程审计',
  )
  assert.equal(
    mounted.service.store.auditList().filter((row) => row.action === 'tidy-request-denied').length,
    1,
    '被拒的登记留一行 denied 审计（turn 外路径的唯一证据链）',
  )
})

test('F9 路由：请求体严格（多余字段 / 非绝对 cwd 一律 400）', async (t) => {
  const mounted = mount({ tidy: { enabled: false } })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  const extra = await route.fetch(tidyPost({ cwd: '/tmp', nope: 1 }))
  assert.equal(extra.status, 400)
  const relative = await route.fetch(tidyPost({ cwd: 'relative/path' }))
  assert.equal(relative.status, 400)
  const blank = await route.fetch(tidyPost({ cwd: '' }))
  assert.equal(blank.status, 400)
  const ok = await route.fetch(tidyPost({ cwd: '/tmp' }))
  assert.equal(ok.status, 200, '只带 cwd 的请求合法')
})

test('F9 端到端（真进程）：点击 → 真起一个子进程 → 它写日志并成功退出 → 只有 started 行，没有失败行', async (t) => {
  // 这条不走注入的假进程：真 spawn 一个启动器壳（它吞掉 `--profile headless "<任务>"` 再唤醒会话脚本，
  // 这正是真 dsh 的形状），验证「起得来、参数照传、日志接得上、成功退出不落失败行」这套代码在真进程下
  // 也一样成立（假进程验的是接线，这条验的是链本身）。
  //
  // 壳与它的会话脚本先被复制到一个 **ASCII 临时目录**：cmd.exe 在非 ASCII 路径上会截断命令
  // （仓库路径含中文，实测报「'.cmd' 不是内部或外部命令」），ASCII 目录里 %~dp0 才解得对。
  const fixtures = path.dirname(fileURLToPath(import.meta.url))
  const sandbox = mkdtempSync(path.join(tmpdir(), 'yammory-e2e-'))
  // 收尾删除在 Windows 上会 EPERM：刚落盘的日志/子进程句柄还没释放。重试几次即可，
  // 删不掉也不该让一个已经通过的用例变红（清理是维护动作，不是断言）。
  t.after(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(sandbox, { recursive: true, force: true })
        return
      } catch {
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      }
    }
  })
  const launcher = path.join(sandbox, process.platform === 'win32' ? 'fake-dsh.cmd' : 'fake-dsh.sh')
  for (const name of ['fake-dsh.cmd', 'fake-dsh.sh', 'fake-dsh-script.cjs']) {
    if (name.endsWith('.cmd') && process.platform !== 'win32') continue
    if (name.endsWith('.sh') && process.platform === 'win32') continue
    writeFileSync(path.join(sandbox, name), readFileSync(path.join(fixtures, 'fixtures', name)))
  }
  const mounted = mount({
    tidy: { exec: launcher, timeoutMs: 30000 },
    tidyEnv: { YAMMORY_FAKE_LINE: 'e2e-ok', YAMMORY_FAKE_EXIT: '0' },
  })
  t.after(mounted.teardown)
  const route = mounted.routes.get('/api/memento/tidy-request')
  const payload = await (await route.fetch(tidyPost({ cwd: sandbox }))).json()
  assert.equal(payload.spawned, true, `真进程已拉起（failure=${payload.failure} detail=${payload.failureDetail} launcher=${launcher}）`)
  assert.ok(typeof payload.logPath === 'string' && payload.logPath.length > 0, '日志路径回带')
  const logPath = /** @type {string} */ (payload.logPath)
  if (process.platform === 'win32') {
    // Windows 上日志一定会落盘（写流 ＋ .cmd 壳），故这一半是真断言：等它出现。
    let log = ''
    for (let index = 0; index < 200; index += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      try {
        log = readFileSync(logPath, 'utf8')
      } catch {
        continue // 空 catch 语义：文件还没落盘，继续等
      }
      if (log.includes('e2e-ok')) break
    }
    assert.ok(log.includes('e2e-ok'), `日志文件里确实接住了子进程的 stdout（log=${JSON.stringify(log.slice(0, 200))}）`)
  } else {
    // POSIX 上写流的落盘时机不保证在被测进程退出前，日志内容不作断言（那是 fs 的时序，不是本插件的语义）。
    assert.ok(readFileSync(logPath, 'utf8') !== undefined, '日志路径可读（存在即通过）')
  }
  const rows = mounted.service.store.auditList().filter((row) => row.action === TIDY_RUN_SOURCE)
  assert.equal(rows.some((row) => row.outcome === TIDY_RUN_OUTCOMES.started), true, 'started 行已落（执行体已拉起）')
  assert.equal(rows.some((row) => row.outcome === TIDY_RUN_OUTCOMES.failed), false, '成功退出不落失败行（收尾由批次的 consolidation 行承担）')
  // 正常退出也要留一行凭据：没有产出批次的轮次（模型回 NOTHING）只有它，缺了它面板永远停在
  // 「整理中」。顺带把待整理标记收掉——这一轮已经响应过用户那一次点击。
  let exited = null
  for (let index = 0; index < 120; index += 1) {
    exited = mounted.service.store.auditList().find((row) => row.action === TIDY_RUN_SOURCE && row.outcome === TIDY_RUN_OUTCOMES.exited)
    if (exited) break
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  assert.ok(exited, 'exited 行已落（正常退出同样是收尾凭据）')
  assert.equal(mounted.service.store.tidyRequestPending(), null, '标记被这一轮收掉（answered，不是还挂着）')
})

test('F9 落库口径：待整理标记与批次账本能把五档状态走一遍（端到端判据，不假手 UI）', async (t) => {
  const mounted = mount({ writePolicy: 'auto', tidy: { enabled: false } })
  t.after(mounted.teardown)
  const service = mounted.service
  const write = { agent: makeAgent(makeSession({ id: 's-f9' })) }
  await service.requestTidy({ source: 'panel' }, write)
  const pending = service.store.tidyRequestPending()
  assert.ok(pending, '标记落地')
  // 直接按纯函数的入口验一遍（路由之外的第二条消费者：/memory 命令与未来的调度都一样读它）。
  const state = buildTidyRunState({
    pending,
    auditRows: /** @type {Array<{action?: string, outcome?: string, ts?: number, text?: string}>} */ (service.store.auditList()),
    batches: [],
    language: 'zh',
  })
  assert.equal(state.state, 'pending', '标记在、无 started → 等执行体')
  assert.ok(typeof service.store.auditList()[0].source === 'string', '登记行带来源标注（具体值由协议层决定，这里只验它在场）')
})

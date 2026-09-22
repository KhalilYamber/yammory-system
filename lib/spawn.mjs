// lib/spawn.mjs — 后台整理轮的执行体控制器（零 DSH 依赖，只用 node: 内置模块）。
//
// 这一层只做一件事：把一轮**用户点出来**的整理交给插件之外的执行体——一个货真价实的
// 无头会话（`dsh --profile headless "<任务>"`）。会话里的模型自己读计划、自己调 auto-tidy
// 落写，于是整条链仍在会话日志里，没有第二套身份、也没有看不见的模型调用。
//
// 边界（与 AGENTS.md 的「不新增定时器 / 不新增常驻后台进程 / 不新增后台模型通道」对齐）：
// - 没有定时器：进程只由一次显式点击拉起，没有周期性唤醒；
// - 不是常驻进程：会话跑完即退（`dsh --profile headless` 的一次性语义），这里不留守护；
// - 不是后台模型通道：它起的是真实会话，模型看见什么、写了什么都在会话日志与审计里；
// - 全程留痕且可退：起止各落一行审计、stdout/stderr 落日志文件、产出归入批次号可整批撤回；
//   要收口就改 headless profile 的粒度写策略，或把 tidy.enabled 关掉。
//
// 本文件不认识 ctx、不读库、不组审批载荷：调用方把配置与回调喂进来，它只管进程本身。

import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'

/** 任务文本的长度上限：位置参数再长也塞得进命令行，超过即响亮拒绝（不静默截断）。 */
export const MAX_TIDY_TASK_CHARS = 4000

/** 日志目录最多留几个文件（旧的先删）：日志是凭据不是档案，无限增长才是隐患。 */
export const MAX_TIDY_LOGS = 20

/**
 * 后台整理轮的配置面（`index.mjs` 的 Config.tidy 喂进来）。
 * @typedef {object} TidySpawnConfig
 * @property {boolean} enabled - 总开关；false 时点按钮只登记标记，退回排队式语义。
 * @property {string} profile - 执行体 profile 名（默认 headless）。
 * @property {string} exec - 执行体入口；空串 = 自动探测（宿主自身的 CLI 入口 → PATH 里的 dsh，见 resolveTidyExec）。
 * @property {string} task - 交给无头会话的任务文本（内置任务）。
 * @property {string} [taskOverride] - 覆盖任务文本的配置项（组合配置里那段「作业说明」；为空即用内置）。
 * @property {string[]} args - 插在 profile 之前的启动器参数（默认 ['--profile']）。
 * @property {string} [cwd] - 子进程工作目录（无头会话的可见集按它分；必须是绝对路径）。
 * @property {string} [dsHome] - DSH 主目录（写进子进程环境，保证两级读写同一个库/同一套 profile）。
 * @property {string} [dbPath] - 记忆库路径（同上；空则不注入）。
 * @property {string} [tsconfigPath] - 源码直跑时要指回的 tsconfig（观察轮 launcher 实测的那道坑）。
 * @property {string} [logsDir] - 日志目录（默认取系统临时目录下的 yammory-tidy-runs）。
 * @property {number} [timeoutMs] - 判活窗口；到点未退出即 kill 并落失败行。
 */

/**
 * 失败码（与 lib/constants.mjs 的 TIDY_RUN_FAILURES 同值域；这里保持字符串字面量，
 * 以免纯 Node 测试要跨一个与它无关的模块）。
 * @typedef {'disabled' | 'spawn' | 'exit' | 'timeout'} TidySpawnFailure
 */

/**
 * 平台默认的执行体名字（PATH 探测的首选候选；探测全流程见 resolveTidyExec，要覆盖由 Config.tidy.exec 显式给绝对路径）。
 * Windows 上 npm 全局装的 dsh 是 `.cmd`——它不能直接进 `spawn`，故默认值走 shell 那条形态
 * （见 `buildTidyCommand`）；其余平台是同名的 `dsh`，直接 exec。
 * @param {string} [platform] - process.platform（测试注入）。
 * @returns {string} 执行体名。
 */
export function defaultTidyExec(platform = process.platform) {
  return platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

/**
 * 执行体入口是怎么定下来的（日志、审计与排查都要能一眼看出这一轮用的是谁）：
 * `configured` = 配置里点名；`host` = 宿主自己的 node ＋ CLI 入口；`path` = PATH 里找到的 dsh。
 */
export const TIDY_EXEC_SOURCES = Object.freeze({
  configured: 'configured',
  host: 'host',
  path: 'path',
})

/**
 * 定下这一轮用哪个执行体。
 *
 * 写死一个 `dsh` 名字并不够：那个命令只在全局安装后才存在，而宿主完全可能是从源码直跑的
 * （实测形态 `"D:\NodeJS\node.exe" apps\cli\lib\bin.js web --no-open`），那时 PATH 里没有
 * dsh，写死的名字换来的就是每点一次都「不是内部或外部命令」。三条路按序探：
 *   ① 配置里点名的 `exec`（用户说了算，原样使用）；
 *   ② 宿主自身：宿主启动命令行里的 CLI 脚本 ＋ 宿主自己的 node——那是**同一个 DSH**，
 *      同一份代码、同一套 profile 语义；
 *   ③ PATH 里的 `dsh.cmd` / `dsh.exe` / `dsh`（全局安装的标准形态）。
 * 三条都不成，就如实说清三条都试过，并把「可在设置里给 tidy.exec 填绝对路径」一并给出——
 * 探测只该是起点，不该是唯一出路。
 * @param {{exec?: string, platform?: string, env?: Record<string, string | undefined>, argv?: string[], execPath?: string, cwd?: string, isFile?: (path: string) => boolean}} [input] - 探测输入（全部可注入：测试不碰真实环境）。
 * @returns {{ok: true, exec: string, bootstrap?: string, source: string} | {ok: false, detail: string}} 执行体或探测失败的说明。
 */
export function resolveTidyExec(input = {}) {
  const configured = typeof input.exec === 'string' ? input.exec.trim() : ''
  if (configured.length > 0) return { ok: true, exec: configured, source: TIDY_EXEC_SOURCES.configured }
  // 进程默认值集中在这里解一次，三条探测路只读 probe、各自不再兜底。装配层正是「只给一个空的
  // exec，别的什么都不注入」这么调的，兜底散在各处时漏一处，就等于宿主自身这条路整个失效
  // （2026-09-22 真机验出过一次：argv 没兜底，于是明明有宿主 CLI 却说「没找到执行体」）。
  const probe = {
    argv: Array.isArray(input.argv) ? input.argv : process.argv,
    env: input.env ?? process.env,
    platform: input.platform ?? process.platform,
    execPath: typeof input.execPath === 'string' && input.execPath.length > 0 ? input.execPath : process.execPath,
    cwd: typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd(),
    isFile: input.isFile ?? isFileSync,
  }
  const host = hostLauncher(probe)
  if (host !== null) return { ok: true, ...host, source: TIDY_EXEC_SOURCES.host }
  const onPath = launcherOnPath(probe)
  if (onPath !== null) return { ok: true, exec: onPath, source: TIDY_EXEC_SOURCES.path }
  return {
    ok: false,
    detail: 'no DSH launcher found: exec is not configured, the host was not started from a CLI script, and PATH holds no dsh.cmd/dsh.exe/dsh — set tidy.exec to an absolute path (or to your own launcher script)',
  }
}

/**
 * 宿主自身的启动器：启动命令行里的 CLI 脚本 ＋ 宿主自己的 node。
 *
 * `argv[1]` 是启动时原样写下的字符串，可能是个相对路径（实测 `apps\cli\lib\bin.js`），故先按
 * 宿主的 cwd 补成绝对路径；补完还要它真的在文件系统上存在、且是 JS 脚本，才敢拿来当执行体。
 * 这两道校验挡的是「宿主不是从 CLI 脚本起的」（桌面壳、被包装过的入口）——那种情况下这条路
 * 不成立，退回 PATH 探测，而不是硬拼一条跑不起来的命令。
 * @param {{argv: string[], execPath: string, cwd: string, platform: string, isFile: (path: string) => boolean}} input - 已解好默认值的探测输入（见 resolveTidyExec）。
 * @returns {{exec: string, bootstrap: string} | null} 执行体与宿主 CLI 脚本，或 null。
 */
function hostLauncher(input) {
  const script = typeof input.argv[1] === 'string' ? input.argv[1] : ''
  if (script.length === 0) return null
  const slash = input.platform === 'win32' ? '\\' : '/'
  const abs = isAbsolutePath(script) ? script : `${input.cwd.replace(/[\\/]+$/u, '')}${slash}${script.replace(/^[\\/]+/u, '')}`
  if (!/\.(?:c|m)?js$/iu.test(abs)) return null
  if (!input.isFile(abs)) return null
  if (typeof input.execPath !== 'string' || input.execPath.length === 0) return null
  return { exec: input.execPath, bootstrap: abs }
}

/**
 * PATH 里的 dsh（全局安装的标准形态）。Windows 上 npm 装出来的是 `.cmd`，故按 `.cmd` →
 * `.exe` → 无后缀的顺序找；POSIX 上就是同名的 `dsh`。PATH 条目里的引号与环境变量未展开的
 * 条目（`%SystemRoot%` 那种）一律跳过：读不到的文件本来就不该拿来当执行体。
 * @param {{env: Record<string, string | undefined>, platform: string, isFile: (path: string) => boolean}} input - 已解好默认值的探测输入（见 resolveTidyExec）。
 * @returns {string | null} 命中的绝对路径，或 null。
 */
function launcherOnPath(input) {
  const platform = input.platform
  const env = input.env
  const raw = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '')
  if (raw.length === 0) return null
  // 平台默认的那个名字排在头里（「猜法」的出处只有 defaultTidyExec 一处），后面是 Windows 上
  // npm 可能装出的别种形态。
  const preferred = defaultTidyExec(platform)
  const names = platform === 'win32' ? [preferred, 'dsh.exe', 'dsh'] : [preferred]
  const slash = platform === 'win32' ? '\\' : '/'
  for (const entry of raw.split(platform === 'win32' ? ';' : ':')) {
    const dir = entry.trim().replace(/^"|"$/gu, '')
    if (dir.length === 0) continue
    for (const name of names) {
      const candidate = `${dir.replace(/[\\/]+$/u, '')}${slash}${name}`
      if (input.isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * 文件存在且是普通文件（目录、断链、权限不足一律算「不在这里」）。
 * @param {string} path - 待查路径。
 * @returns {boolean} 是普通文件则为 true。
 */
function isFileSync(path) {
  try {
    return statSync(path).isFile()
  } catch {
    // 空 catch 语义：读不到（不存在／权限／断链）就是不可用，探测继续往下走。
    return false
  }
}

/**
 * 组一轮无头会话的命令行。
 *
 * 两种形态，取决于执行体是不是批处理文件：
 * - 普通可执行文件（`dsh`、`dsh.exe`、`node.exe`）：给出 `command = [exec, ...bootstrap, ...args, profile, task]`，
 *   由 Node 原样传参，任务文本一字不改。`bootstrap` 只在「宿主自身」形态出现：node 后面跟的是
 *   宿主 CLI 脚本的绝对路径，批处理那一路不接受它。
 * - Windows 的 `.cmd` / `.bat`（默认执行体 `dsh.cmd` 就是它）：Node 起进程时拒绝批处理文件
 *   （实测 `spawn EINVAL`），只能走 shell；而走 shell 就得应付 cmd.exe 的语法——可执行文件路径
 *   与任务文本都用双引号包住，于是空格、`&`、`^`、`|`、`<`、`>`、`%` 一律当字面量。
 *   代价是任务文本自己不能含双引号（模板里包动作名一律用反引号），这里对此响亮拒绝。
 * @param {{profile: string, task: string, exec?: string, bootstrap?: string, args?: string[], platform?: string}} input - {profile, task, exec?, bootstrap?, args?, platform?}。
 * @returns {{command: string[], shell: false} | {cmdArg: string, shell: true} | {error: string}} 命令行或错误码。
 */
export function buildTidyCommand(input) {
  const profile = input?.profile
  if (typeof profile !== 'string' || !/^[A-Za-z0-9._-]+$/.test(profile)) {
    return { error: 'profile must be a non-empty name of letters, digits, dots, underscores or dashes' }
  }
  const task = input?.task
  if (typeof task !== 'string' || task.trim().length === 0) return { error: 'task must be a non-empty string' }
  if (task.length > MAX_TIDY_TASK_CHARS) return { error: `task must be at most ${MAX_TIDY_TASK_CHARS} characters` }
  // 位置参数以「-」开头会被启动器当成自己的 flag（它只认第一个非 flag token 之后的参数），
  // 故任务文本不许以 dash 起头；控制字符（换行以外）会让日志与审计行读不出原样。
  if (task.trim().startsWith('-')) return { error: 'task must not start with a dash (the launcher would read it as a flag)' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(task)) return { error: 'task must not contain control characters' }
  const exec = typeof input?.exec === 'string' && input.exec.length > 0 ? input.exec : defaultTidyExec(input?.platform)
  const args = Array.isArray(input?.args) && input.args.length > 0 ? input.args : ['--profile']
  // 宿主自身形态的那一段：`node.exe` 后面跟的是**宿主 CLI 脚本的绝对路径**，不是启动器参数，
  // 故不跟 args 同一条校验规则（args 必须是裸 token，而路径天然带分隔符）。它只走不经过
  // shell 的数组形态，注入面由「绝对路径 ＋ 无控制字符 ＋ 无引号」三条钉住。
  const bootstrap = input?.bootstrap
  if (bootstrap !== undefined) {
    if (typeof bootstrap !== 'string' || !isAbsolutePath(bootstrap)) return { error: 'bootstrap must be an absolute path (the host CLI script)' }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F"]/u.test(bootstrap)) return { error: 'bootstrap must not contain control characters or double quotes' }
  }
  // 启动器参数在被拼进 shell 命令行时必须是裸 token：带空格或 shell 元字符的参数会被解读成
  // 另一次命令拼接（那是命令注入的口子）。参数由本插件自己给，这里只是把不变量钉住。
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 || !/^[A-Za-z0-9._=-]+$/.test(arg)) {
      return { error: 'launcher args must be plain tokens of letters, digits, dots, underscores, dashes or equals' }
    }
  }
  if (isBatchFile(exec)) {
    // 批处理启动器自己就知道该跑什么，再来一段 script 只会被 cmd.exe 当成第一个位置参数吃掉。
    if (bootstrap !== undefined) return { error: 'bootstrap cannot be combined with a .cmd/.bat launcher' }
    if (task.includes('"')) {
      return { error: 'task must not contain a double quote (a .cmd/.bat launcher runs through the shell, where the task text is the double-quoted argument)' }
    }
    return { cmdArg: `"${exec}" ${args.join(' ')} ${profile} "${task}"`, shell: true }
  }
  const script = bootstrap === undefined ? [] : [bootstrap]
  return { command: [exec, ...script, ...args, profile, task], shell: false }
}

/**
 * 收掉一个已经在跑的后台轮，连同它的进程树。
 *
 * 为什么是树：shell 形态下真正干活的是 shell 的子进程，只杀 shell 会留一个孤儿在那儿跑。
 * Windows 用 `taskkill /T /F`（系统自带），其余平台杀进程组（不 detached 时子进程与父同组，
 * 负号即整组）。杀不掉只是白等，失败行的文案仍写实「超时」——绝不让收口动作把结论改错。
 * @param {import('node:child_process').ChildProcess} child - 目标进程。
 * @returns {void}
 */
function killTree(child) {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      // 空 catch 语义：taskkill 不在或不认参数时退回单进程杀，别把收口卡死。
    }
  }
  try {
    if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 空 catch 语义：杀不掉就只能等它自己结束。
    }
  }
}

/** 路径后缀是批处理文件吗（`.cmd` / `.bat`；Windows 上这两种不能直接进 spawn）。 */
function isBatchFile(/** @type {string} */ exec) {
  return /\.(cmd|bat)$/iu.test(exec)
}

/**
 * 同一进程内是否已有一轮在跑（单飞锁的读面：面板与路由都用它防止叠进程）。
 * @param {Set<import('node:child_process').ChildProcess>} active - 在跑的进程集合。
 * @returns {boolean} 有则在跑。
 */
export function tidyRoundActive(active) {
  return active.size > 0
}

/**
 * 拉起一轮后台整理。任何一步失败都返回结构化结果，绝不抛出——调用方据此落审计行并把
 * 失败如实写进面板状态行（「失败要大声」）。
 *
 * `spawn` 与时钟都可注入，故本函数的每条分支都能在无真实子进程的情况下逐条验。
 * @param {TidySpawnConfig} config - 配置面（见 typedef）。
 * @param {{spawnFn?: typeof nodeSpawn, active?: Set<import('node:child_process').ChildProcess>, now?: () => number, onFailure?: (failure: TidySpawnFailure, detail: string) => void, onExit?: (code: number | null, logPath: string) => void, env?: Record<string, string | undefined>, killRound?: (child: import('node:child_process').ChildProcess) => void, execInput?: {exec?: string, platform?: string, env?: Record<string, string | undefined>, argv?: string[], execPath?: string, cwd?: string, isFile?: (path: string) => boolean}}} [hooks] - 注入点（测试与宿主共用）。
 * @returns {{ok: true, pid: number | null, logPath: string, command: string[]} | {ok: false, failure: TidySpawnFailure, detail: string}} 结果。
 */
export function launchTidyRound(config, hooks = {}) {
  if (config.enabled !== true) return { ok: false, failure: 'disabled', detail: 'tidy.enabled is false' }
  const spawnFn = hooks.spawnFn ?? nodeSpawn
  const active = hooks.active ?? new Set()
  const now = hooks.now ?? Date.now
  // 执行体先探再用：配置点名 → 宿主自身 → PATH（见 resolveTidyExec）。探不到就如实收在这一步，
  // 不拿一个跑不起来的名字去 spawn（那只会换来一句 cmd.exe 的「不是内部或外部命令」）。
  const resolved = resolveTidyExec({ ...hooks.execInput, exec: config.exec })
  if (resolved.ok !== true) return { ok: false, failure: 'spawn', detail: resolved.detail }
  // 批处理启动器要走 shell（见 buildTidyCommand 的说明）；只有这两种后缀会打开它。
  const shell = buildTidyCommand({
    profile: config.profile,
    task: typeof config.taskOverride === 'string' && config.taskOverride.trim().length > 0 ? config.taskOverride : config.task,
    exec: resolved.exec,
    ...(resolved.bootstrap === undefined ? {} : { bootstrap: resolved.bootstrap }),
    ...(config.args === undefined ? {} : { args: config.args }),
  })
  if ('error' in shell) return { ok: false, failure: 'spawn', detail: shell.error }
  /** 提交给 spawn 的命令行形态（两种；批处理那条走 shell 且整条命令已自行引号化）。 */
  const viaShell = 'cmdArg' in shell
  const launch = viaShell
    ? { file: /** @type {{cmdArg: string}} */ (shell).cmdArg, args: /** @type {string[]} */ ([]), shell: true }
    : { file: /** @type {{command: string[]}} */ (shell).command[0], args: /** @type {{command: string[]}} */ (shell).command.slice(1), shell: false }
  const displayCommand = viaShell ? /** @type {string[]} */ ([/** @type {{cmdArg: string}} */ (shell).cmdArg]) : /** @type {{command: string[]}} */ (shell).command
  const logsDir = config.logsDir ?? join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'yammory-tidy-runs')
  let logPath
  try {
    mkdirSync(logsDir, { recursive: true })
    logPath = join(logsDir, `tidy-${new Date(now()).toISOString().replace(/[:.]/gu, '-')}.log`)
    // 清旧要在定下本轮文件名之后：把本轮自己排除在外，否则时间戳最小的一轮会被自己删掉。
    pruneTidyLogs(logsDir, logPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, failure: 'spawn', detail: `log path unavailable: ${detail}` }
  }
  /** @type {Record<string, string | undefined>} */
  const env = { ...(hooks.env ?? process.env) }
  if (typeof config.dsHome === 'string' && config.dsHome.length > 0) env.DSH_HOME = config.dsHome
  if (typeof config.dbPath === 'string' && config.dbPath.length > 0) env.DSH_MEMENTO_DB_PATH = config.dbPath
  if (typeof config.tsconfigPath === 'string' && config.tsconfigPath.length > 0) env.TSX_TSCONFIG_PATH = config.tsconfigPath
  const cwd = typeof config.cwd === 'string' && isAbsolutePath(config.cwd) ? config.cwd : undefined
  /** @type {import('node:child_process').ChildProcess} */
  let child
  /** 日志写入流（管道接住子进程输出再落盘；见下方为何不用 fd 直接给 stdio）。 */
  /** @type {import('node:stream').Writable} */
  let sink = new PassThrough()
  /** @type {import('node:fs').WriteStream | null} */
  let logStream = null
  try {
    logStream = createWriteStream(logPath, { flags: 'a' })
    // 写流自己出错（目录在打开的瞬间被删、句柄被回收…）只放弃日志，绝不让它变成
    // uncaughtException：日志是凭据，不是这一轮的命脉。审计行仍写实。
    logStream.on('error', () => { sink = new PassThrough() })
    sink = /** @type {import('node:stream').Writable} */ (logStream)
    child = spawnFn(launch.file, launch.args, {
      cwd,
      env,
      // 刻意不 detached：Windows 上 `detached: true` 的子进程会连同继承的 fd 与管道一起丢
      // （实测：进程正常退出、stdout 一个字都收不到；去掉 detached 就正常）。父进程是常驻的
      // dsh 宿主，子进程本就活得比一次点击长；到点收口的杀用了**进程树**（见 killTree），
      // 故 shell 那层也一并收掉，不留孤儿。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(launch.shell ? { shell: true, windowsVerbatimArguments: true } : {}),
    })
  } catch (error) {
    try {
      logStream?.end()
    } catch {
      // 空 catch 语义：日志流关不掉不影响失败结论（进程都没起来）。
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, failure: 'spawn', detail }
  }
  try {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue
      stream.pipe(sink, { end: false })
    }
  } catch {
    // 管子接不上（流不可读、或句柄已被回收）时退成丢弃：**日志是凭据，不是这一轮的命脉**——
    // 绝不能因为写日志出问题把「执行体已拉起」这件事改判成失败。审计行仍写实。
    sink = new PassThrough()
  }
  const pid = typeof child.pid === 'number' ? child.pid : null
  active.add(child)
  /** 到点未退出即杀；已到点这个事实要盖过随后的非零退出码（否则「超时」会被报成「跑失败了」）。 */
  let timedOut = false
  const killRound = hooks.killRound ?? killTree
  const timer = setTimeout(() => {
    timedOut = true
    killRound(child)
  }, config.timeoutMs ?? 480000)
  if (typeof timer.unref === 'function') timer.unref()
  child.on('error', (error) => {
    clearTimeout(timer)
    active.delete(child)
    try {
      sink.end()
    } catch {
      // 空 catch 语义：日志流关不掉不影响结论
    }
    try {
      hooks.onFailure?.(timedOut ? 'timeout' : 'spawn', error instanceof Error ? error.message : String(error))
    } catch {
      // 审计回调自己的失败不改判执行体的结论
    }
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    active.delete(child)
    try {
      sink.end()
    } catch {
      // 空 catch 语义：日志流随进程退出释放
    }
    const failure = timedOut ? 'timeout' : (code === 0 ? null : 'exit')
    try {
      if (failure === null) hooks.onExit?.(code, logPath)
      else hooks.onFailure?.(failure, `exit code ${code}`)
    } catch {
      // 同上：回调失败不改判
    }
  })
  return { ok: true, pid, logPath, command: displayCommand }
}

/**
 * 日志目录只留最近 MAX_TIDY_LOGS 个文件（按文件名排序，旧的先删）。
 * 删除失败一律吞掉：清旧日志是维护动作，不该让一整轮整理起不来。
 * @param {string} dir - 日志目录。
 * @param {string} [keep] - 本轮自己的日志路径（绝不删它）。
 * @returns {void}
 */
function pruneTidyLogs(dir, keep) {
  try {
    const keepName = keep === undefined ? null : basename(keep)
    const files = readdirSync(dir).filter((name) => name.startsWith('tidy-') && name.endsWith('.log') && name !== keepName)
    if (files.length < MAX_TIDY_LOGS) return
    files.sort()
    for (const name of files.slice(0, files.length - MAX_TIDY_LOGS + 1)) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // 空 catch 语义：单个旧日志删不掉不影响继续
      }
    }
  } catch {
    // 空 catch 语义：目录读不动（权限/竞态）时不做清理，不阻断整理
  }
}

/** 路径像绝对路径吗（POSIX 的 `/` 或 Windows 的 `X:\` / `\\server`；两平台都要认）。 */
function isAbsolutePath(/** @type {string} */ path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * 日志文件的最后修改时间（面板要报「这一轮的日志在哪、什么时候动过」；读不到即 null）。
 * @param {string} logPath - 日志路径。
 * @returns {number | null} mtime 或 null。
 */
export function tidyLogMtime(logPath) {
  try {
    return statSync(logPath).mtimeMs
  } catch {
    return null
  }
}

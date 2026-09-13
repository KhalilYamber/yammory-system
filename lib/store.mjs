// lib/store.mjs — 本地 SQLite Provider（零 DSH 依赖，仅 node: 内置模块）。
//
// 单文件库（WAL），表结构支撑 双轨 × 双层 × 条目文本 + 元数据（来源、创建/更新
// 时间、会话 id）。replace/remove 用唯一子串匹配（instr，绕开 LIKE 转义问题），
// 不唯一/零命中时报错要求更具体。另有插件自有审计表 audit：每条记忆变更/快照
// 落一行（动作、结果、审批来源、会话 id），与审批 seam 的 approval/asked +
// approval/decided 审计对一起构成完整审计链。
//
// Provider 不做预算裁决（那是 Service 层职责），也绝不静默截断。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SCHEMA_VERSION, DEFAULT_DB_NAME, TRACKS, SCOPES, PROFILE_FACETS, KNOWLEDGE_DOMAINS, KNOWLEDGE_TIERS, tierForLevel, ERROR_CODES, MAX_QUERY_LIMIT, MAX_CONSOLIDATE_MATCHES } from './constants.mjs'
import { findUniqueMatch, requireUniqueMatch } from './match.mjs'
import { StoreError, InvalidInputError, EntryNotFoundError, AmbiguousMatchError, StaleWriteError, ProposalNotFoundError } from './errors.mjs'

/**
 * @typedef {object} EntryRow - entries 表 SELECT 行（toEntry 输入）。
 * @property {string} id
 * @property {'user' | 'agent'} track
 * @property {'user-global' | 'workspace'} scope
 * @property {string} workspace_key
 * @property {string} agent_key
 * @property {string} text
 * @property {string} source
 * @property {string} tags
 * @property {number} version
 * @property {string | null} facet
 * @property {number | null} level
 * @property {'active' | 'superseded'} status
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number | null} last_recalled
 * @property {number} recall_count
 * @property {string | null} session_id
 * @typedef {object} StoreInsertInput
 * @property {string} track
 * @property {string} scope
 * @property {string} [workspaceKey]
 * @property {string} [agentKey]
 * @property {string} text
 * @property {string[]} [tags]
 * @property {number} [version]
 * @property {string} [source]
 * @property {string | null} [facet]
 * @property {number | null} [level]
 * @property {string | null} [sessionId]
 * @typedef {object} StoreMatchInput
 * @property {string} track
 * @property {string} scope
 * @property {string} match
 * @typedef {object} StoreReplaceInput
 * @property {string} track
 * @property {string} scope
 * @property {string} match
 * @property {string} text
 * @property {string[]} [tags]
 * @property {number} [expectedVersion] - 乐观锁前置：省略则不校验（向后兼容）；与当前 version 不符即 STALE_WRITE。
 * @property {string | null} [facet] - 省略 = 保持原值；显式 null = 清空。
 * @property {number | null} [level] - 省略 = 保持原值；显式 null = 清空。
 * @property {string | null} [sessionId]
 * @typedef {object} StoreConsolidateInput
 * @property {string} track
 * @property {string} scope
 * @property {string[]} matches
 * @property {number[]} [expectedVersions] - 乐观锁前置（与 matches 同序）：省略则不校验；任一不符即 STALE_WRITE。
 * @property {string} text
 * @property {string} [source]
 * @property {string} [workspaceKey]
 * @property {string} [agentKey]
 * @property {string[]} [tags]
 * @property {string | null} [facet] - 新条目的面（省略即 null）。
 * @property {number | null} [level] - 新条目的分领域水平（省略即 null）。
 * @property {string | null} [sessionId]
 * @typedef {object} StoreQueryFilter
 * @property {string} [track]
 * @property {string} [scope]
 * @property {string} [text]
 * @property {number} [limit]
 * @property {string} [agentKey]
 * @typedef {object} AuditInput
 * @property {string} action
 * @property {string | null} [track]
 * @property {string | null} [scope]
 * @property {string | null} [entryId]
 * @property {string | null} [text]
 * @property {string | null} [outcome]
 * @property {string | null} [source]
 * @property {string | null} [sessionId]
 * @typedef {object} AuditRow - audit 表 SELECT 行。
 * @property {number} seq
 * @property {number} ts
 * @property {string} action
 * @property {string | null} track
 * @property {string | null} scope
 * @property {string | null} entry_id
 * @property {string | null} text
 * @property {string | null} outcome
 * @property {string | null} source
 * @property {string | null} session_id
 * @typedef {object} ProposalRow - proposals 表 SELECT 行。
 * @property {string} id
 * @property {string} kind
 * @property {string} track
 * @property {string} scope
 * @property {string} workspace_key
 * @property {string} agent_key
 * @property {string} text
 * @property {string} source
 * @property {string | null} session_id
 * @property {string} status
 * @property {number} created_at
 * @property {number | null} decided_at
 * @typedef {object} ProfileRow - profile 表 SELECT 行。
 * @property {string} domain
 * @property {number} level
 * @property {string} tier
 * @property {number} updated_at
 * @typedef {{domain: string, level: number, tier: string, updatedAt: number}} Profile - profile 表对外行（updatedAt 驼峰）。
 * @typedef {object} ProfileInput
 * @property {string} domain
 * @property {number} level
 * @property {string} [tier]
 * @typedef {import('node:sqlite').DatabaseSync} Db
 * @typedef {import('../types.js').MemoryEntry} MemoryEntry
 * @typedef {import('../types.js').MemoryFacet} MemoryFacet
 * @typedef {import('../types.js').MemoryQueryResult} MemoryQueryResult
 * @typedef {object} Store - openMemoryStore 返回的 Provider 句柄。
 * @property {Db} db
 * @property {string} path
 * @property {(input: StoreInsertInput) => MemoryEntry} insertEntry
 * @property {(inputs: StoreInsertInput[]) => MemoryEntry[]} seedEntries
 * @property {(input: StoreReplaceInput) => {previous: MemoryEntry, entry: MemoryEntry}} replaceEntry
 * @property {(input: StoreMatchInput) => MemoryEntry} removeEntry
 * @property {(input: StoreConsolidateInput) => {removed: MemoryEntry[], entry: MemoryEntry}} consolidateEntries
 * @property {(filter?: StoreQueryFilter) => MemoryQueryResult} queryEntries
 * @property {() => MemoryEntry[]} listEntries
 * @property {(ids: string[]) => void} bumpRecall
 * @property {(track: string, scope: string, match: string, opts?: {agentKey?: string, workspaceKey?: string}) => MemoryEntry[]} matchCandidates
 * @property {(track: string, scope: string) => number} usage
 * @property {(row: AuditInput) => object} auditAppend
 * @property {(limit?: number) => object[]} auditList
 * @property {(input: object) => object | null} proposalUpsert
 * @property {(status?: string, limit?: number) => object[]} proposalList
 * @property {(id: string, status: 'approved' | 'dismissed') => object} proposalDecide
 * @property {(input: ProfileInput) => Profile} profileUpsert
 * @property {() => Profile[]} profileList
 * @property {(domain: string) => Profile | null} profileGet
 * @property {() => void} close
 */

/** WAL 之外的 PRAGMA：串行写 + 等待锁上限。 */
const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;'

/**
 * POSIX 上把记忆库主文件与已存在的 WAL/-shm 边车收紧为属主读写（0600）。
 * 边车由 SQLite 惰性创建，因此在 PRAGMA WAL 生效之后调用、只 chmod 已存在的
 * 文件（尽力而为，避免为 chmod 触发边车创建）；Windows 无 POSIX 权限位，跳过。
 * @param {string} dbPath - 主库绝对路径。
 * @param {{platform?: string, chmod?: (path: string, mode: number) => void, exists?: (path: string) => boolean}} [io] - 测试注入用。
 */
export function chmodOwned(dbPath, io = {}) {
  const platform = io.platform ?? process.platform
  const chmod = io.chmod ?? chmodSync
  const exists = io.exists ?? existsSync
  if (platform === 'win32') return
  chmod(dbPath, 0o600)
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (exists(sidecar)) chmod(sidecar, 0o600)
  }
}

/**
 * 解析记忆库绝对路径。
 * - 显式绝对路径：原样规范化。
 * - 显式相对路径：相对 harness 主目录（$DSH_HOME；未导出时回退 ~/.dsh）。
 * - 空值：<harness 主目录>/dsh-memento/memory.db。
 * $DSH_HOME 未导出时回退 ~/.dsh——与官方 harness 的 resolveDshHome() 文档化回退
 * 同语义。dsh 启动不会把解析出的主目录写回 process.env.DSH_HOME，插件自己兜底
 * 才能避免默认 Windows 配置在真实 boot 时整体崩溃（issue #1）。
 * @param {string} [dbPath] - Config.dbPath。
 * @param {string|undefined} [dshHome] - 环境 $DSH_HOME（测试注入）。
 * @returns {string} 绝对路径。
 */
export function resolveDbPath(dbPath, dshHome = process.env.DSH_HOME) {
  const home = typeof dshHome === 'string' && dshHome.length > 0 ? dshHome : path.join(homedir(), '.dsh')
  if (dbPath) {
    return path.isAbsolute(dbPath) ? path.normalize(dbPath) : path.resolve(home, dbPath)
  }
  return path.join(home, 'dsh-memento', DEFAULT_DB_NAME)
}

/**
 * 校验 track/scope 词汇（写路径入口）。非法值响亮失败，绝不落到 SQL。
 * @param {string} track - 轨道。
 * @param {string} scope - 作用域。
 * @returns {{track: 'user' | 'agent', scope: 'user-global' | 'workspace'}} 原值（已校验）。
 */
export function assertScope(track, scope) {
  if (!/** @type {readonly string[]} */ (TRACKS).includes(track) || !/** @type {readonly string[]} */ (SCOPES).includes(scope)) {
    throw new InvalidInputError(`invalid memory scope: track=${JSON.stringify(track)} scope=${JSON.stringify(scope)} (track ∈ ${TRACKS.join('|')}, scope ∈ ${SCOPES.join('|')})`)
  }
  return { track: /** @type {'user' | 'agent'} */ (track), scope: /** @type {'user-global' | 'workspace'} */ (scope) }
}

/**
 * 把 SELECT 行映射为稳定条目形状。
 * @returns {MemoryEntry} 协议条目（facet 词汇在写路径已校验，此处按列语义收窄）。
 */
function toEntry(/** @type {EntryRow} */ row) {
  return {
    id: row.id,
    track: row.track,
    scope: row.scope,
    workspaceKey: row.workspace_key,
    agentKey: row.agent_key,
    text: row.text,
    source: row.source,
    tags: parseTags(row.tags),
    version: row.version,
    facet: /** @type {MemoryFacet | null} */ (row.facet ?? null),
    level: row.level ?? null,
    status: row.status ?? 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalled: row.last_recalled,
    recallCount: row.recall_count,
    sessionId: row.session_id,
  }
}

/** 解析 tags 列（JSON 数组；列是 Provider 自写，损坏即 STORE_CORRUPT 响亮失败）。 */
function parseTags(/** @type {string} */ raw) {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string')) {
      throw new Error(`tags column is not a string array: ${raw}`)
    }
    return /** @type {string[]} */ (parsed)
  } catch (error) {
    throw new StoreError(ERROR_CODES.STORE_CORRUPT, `memory database has a corrupt tags column: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 把 proposals SELECT 行映射为稳定提案形状。 */
function toProposal(/** @type {ProposalRow} */ row) {
  return {
    id: row.id,
    kind: row.kind,
    track: row.track,
    scope: row.scope,
    workspaceKey: row.workspace_key,
    agentKey: row.agent_key,
    text: row.text,
    source: row.source,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }
}

/** 把 profile SELECT 行映射为稳定画像形状。 */
function toProfile(/** @type {ProfileRow} */ row) {
  return {
    domain: row.domain,
    level: row.level,
    tier: row.tier,
    updatedAt: row.updated_at,
  }
}

/**
 * 打开（或创建）记忆库并迁移到当前 schema。库损坏/版本过新在打开点响亮抛出。
 * @param {string} dbPath - 绝对路径。
 * @param {{retentionDays?: number}} [options] - {retentionDays}：>0 时裁剪超过保留天数的审计行。
 * @returns {Store} store：插入/更新/删除/查询/审计/关闭。
 */
export function openMemoryStore(dbPath, options = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (error) {
    throw new StoreError(
      ERROR_CODES.STORE_CORRUPT,
      `cannot open memory database at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      { path: dbPath },
    )
  }
  try {
    db.exec(PRAGMAS)
    // S4：边车（-wal/-shm）在 PRAGMA 生效后才被惰性创建，此处统一收紧权限。
    chmodOwned(dbPath)
    migrate(db, dbPath)
    pruneAudit(db, options.retentionDays ?? 0)
  } catch (error) {
    closeDb(db)
    if (error instanceof StoreError) throw error
    throw new StoreError(
      ERROR_CODES.STORE_CORRUPT,
      `memory database at ${dbPath} failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
      { path: dbPath },
    )
  }

  const store = {
    db,
    path: dbPath,

    /**
     * 新增一条记忆。
     * @param {StoreInsertInput} input - {track, scope, workspaceKey, text, source, sessionId}。
     * @returns {MemoryEntry} 已落盘条目。
     */
    insertEntry(input) {
      return insertOne(db, input)
    },

    /**
     * 批量插入（事务内原子：任一条失败整体回滚，绝无部分写入）。
     * @param {StoreInsertInput[]} inputs - 与 insertEntry 相同的输入数组。
     * @returns {MemoryEntry[]} 已落盘条目（与输入同序）。
     */
    seedEntries(inputs) {
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new InvalidInputError('seed requires a non-empty entry list')
      }
      return withTransaction(db, () => inputs.map((input) => insertOne(db, input)))
    },

    /**
     * 按唯一子串匹配并替换文本（事务内匹配+更新，原子）。版本自增（协议 v1：
     * 每次替换 version = previous.version + 1，审计链据此重建演进史）。
     * @param {StoreReplaceInput} input - {track, scope, match, text, tags?, sessionId}。
     * @returns {{previous: MemoryEntry, entry: MemoryEntry}} 旧条目与更新后的条目。
     */
    replaceEntry(input) {
      const { track, scope } = assertScope(input.track, input.scope)
      if (typeof input.match !== 'string' || input.match.length === 0) {
        throw new InvalidInputError('replace/remove match must be a non-empty string')
      }
      assertStoredText(input.text, 'entry text')
      const expectedVersion = input.expectedVersion
      return withTransaction(db, () => {
        const found = matchEntries(db, track, scope, input.match)
        const target = /** @type {MemoryEntry} */ (requireUniqueMatch(findUniqueMatch(found, input.match), { track, scope, match: input.match }, { EntryNotFoundError, AmbiguousMatchError }))
        // 乐观锁：审批时看到的版本与此刻不符，说明目标已被并发写改动——响亮失败，绝不静默覆盖。
        if (expectedVersion !== undefined && target.version !== expectedVersion) {
          throw new StaleWriteError({ track, scope, match: input.match, expected: expectedVersion, actual: target.version })
        }
        const tags = input.tags === undefined ? target.tags : assertStoredTags(input.tags)
        // facet/level 省略 = 保持原值（改写文本不该顺手抹掉画像坐标）；显式 null = 清空。
        const facet = input.facet === undefined ? target.facet : checkedFacet(input.facet)
        const level = input.level === undefined ? target.level : checkedLevel(input.level)
        const updated = db.prepare('UPDATE entries SET text = ?, tags = ?, facet = ?, level = ?, version = version + 1, updated_at = ?, session_id = ? WHERE id = ? AND version = ?')
          .run(input.text, JSON.stringify(tags), facet, level, Date.now(), input.sessionId ?? null, target.id, target.version)
        // 条件更新兜底（跨进程在定位与写入之间改动）：影响 0 行即视为冲突，绝不静默。
        if (updated.changes === 0) {
          const row = /** @type {{version?: number} | undefined} */ (db.prepare('SELECT version FROM entries WHERE id = ?').get(target.id))
          throw new StaleWriteError({ track, scope, match: input.match, expected: target.version, actual: row?.version ?? -1 })
        }
        return { previous: target, entry: getEntry(db, target.id) }
      })
    },

    /**
     * 按唯一子串匹配并删除（事务内匹配+删除，原子）。
     * @param {StoreMatchInput} input - {track, scope, match}。
     * @returns {MemoryEntry} 被删除的条目。
     */
    removeEntry(input) {
      const { track, scope } = assertScope(input.track, input.scope)
      if (typeof input.match !== 'string' || input.match.length === 0) {
        throw new InvalidInputError('replace/remove match must be a non-empty string')
      }
      return withTransaction(db, () => {
        const found = matchEntries(db, track, scope, input.match)
        const target = requireUniqueMatch(findUniqueMatch(found, input.match), { track, scope, match: input.match }, { EntryNotFoundError, AmbiguousMatchError })
        db.prepare('DELETE FROM entries WHERE id = ?').run(target.id)
        return target
      })
    },

    /**
     * 事务内按多个唯一子串整合：逐一定位（零/多命中响亮报错）→ 全部删除 → 插入新条目。
     * 任一步失败整体回滚（原子，绝无部分写入）。新条目 version 从 1 开始（全新条目）。
     * @param {StoreConsolidateInput} input - 整合方案。
     * @returns {{removed: MemoryEntry[], entry: MemoryEntry}} 被删除的旧条目与新条目。
     */
    consolidateEntries(input) {
      const { track, scope } = assertScope(input.track, input.scope)
      if (!Array.isArray(input.matches) || input.matches.length === 0 || input.matches.length > MAX_CONSOLIDATE_MATCHES) {
        throw new InvalidInputError(`consolidate matches must be an array of 1..${MAX_CONSOLIDATE_MATCHES} non-empty strings`)
      }
      if (typeof input.text !== 'string' || input.text.length === 0) {
        throw new InvalidInputError('entry text must be a non-empty string')
      }
      for (const match of input.matches) {
        if (typeof match !== 'string' || match.length === 0) {
          throw new InvalidInputError(`consolidate matches must be an array of 1..${MAX_CONSOLIDATE_MATCHES} non-empty strings`)
        }
      }
      return withTransaction(db, () => {
        const expected = input.expectedVersions
        const removed = []
        for (let index = 0; index < input.matches.length; index += 1) {
          const match = input.matches[index]
          const found = matchEntries(db, track, scope, match)
          const target = /** @type {MemoryEntry} */ (requireUniqueMatch(findUniqueMatch(found, match), { track, scope, match }, { EntryNotFoundError, AmbiguousMatchError }))
          // 乐观锁（与 replace 同型）：审批时看到的版本若已变，响亮失败而非静默合并新内容。
          if (expected !== undefined && expected[index] !== undefined && target.version !== expected[index]) {
            throw new StaleWriteError({ track, scope, match, expected: expected[index], actual: target.version })
          }
          db.prepare('DELETE FROM entries WHERE id = ?').run(target.id)
          removed.push(target)
        }
        const entry = insertOne(db, {
          track, scope, text: input.text,
          workspaceKey: input.workspaceKey,
          agentKey: input.agentKey,
          tags: input.tags,
          facet: input.facet ?? null,
          level: input.level ?? null,
          source: input.source,
          sessionId: input.sessionId ?? null,
        })
        return { removed, entry }
      })
    },

    /**
     * 查询条目：子串过滤（大小写不敏感，ASCII 折叠；CJK 无大小写不受影响）+ 数量上限。
     * 排序按召回频次（高频即重要）：recall_count DESC, updated_at DESC, id；命中页的条目
     * 召回计数 +1（last_recalled 同步）。快照用 listEntries 保持创建序（冻结块稳定优先）。
     * @param {StoreQueryFilter} [filter] - {track, scope, text, limit, agentKey}。
     * @returns {MemoryQueryResult}。
     */
    queryEntries(filter = {}) {
      // 词汇校验：非法 track/scope 响亮失败，绝不落到 SQL 抛裸 SQLite 错。
      if (filter.track !== undefined && !TRACKS.includes(/** @type {'user'|'agent'} */ (filter.track))) {
        throw new InvalidInputError(`query track must be one of ${TRACKS.join('|')} (got ${JSON.stringify(filter.track)})`)
      }
      if (filter.scope !== undefined && !SCOPES.includes(/** @type {'user-global'|'workspace'} */ (filter.scope))) {
        throw new InvalidInputError(`query scope must be one of ${SCOPES.join('|')} (got ${JSON.stringify(filter.scope)})`)
      }
      const conditions = []
      const params = []
      if (filter.track !== undefined) { conditions.push('track = ?'); params.push(filter.track) }
      if (filter.scope !== undefined) { conditions.push('scope = ?'); params.push(filter.scope) }
      if (typeof filter.text === 'string' && filter.text.length > 0) {
        conditions.push('instr(lower(text), lower(?)) > 0'); params.push(filter.text)
      }
      if (typeof filter.agentKey === 'string') {
        // 会话内读过滤：共享层 + 指定 agent 键（管理面不传该过滤，保持全量视图）。
        conditions.push("(agent_key = '' OR agent_key = ?)"); params.push(filter.agentKey)
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const total = /** @type {number} */ (db.prepare(`SELECT COUNT(*) AS n FROM entries ${where}`).get(...params).n)
      const requested = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : MAX_QUERY_LIMIT
      const limit = Math.min(requested, MAX_QUERY_LIMIT)
      const rows = /** @type {EntryRow[]} */ (db.prepare(`SELECT * FROM entries ${where} ORDER BY recall_count DESC, updated_at DESC, id LIMIT ?`)
        .all(...params, limit))
      if (rows.length > 0) {
        const placeholders = rows.map(() => '?').join(', ')
        db.prepare(`UPDATE entries SET recall_count = recall_count + 1, last_recalled = ? WHERE id IN (${placeholders})`)
          .run(Date.now(), ...rows.map((row) => row.id))
      }
      return { entries: rows.map(toEntry), total, truncated: total > rows.length }
    },

    /** @returns {MemoryEntry[]} 全部条目（快照/报表用）。 */
    listEntries() {
      return /** @type {EntryRow[]} */ (db.prepare('SELECT * FROM entries ORDER BY created_at, id').all()).map(toEntry)
    },

    /**
     * 给指定条目召回计数 +1（last_recalled 同步落地）。语义召回路径
     * （memory_recall 走 vector 检索器）复用此面，与 queryEntries 的命中页计数一致。
     * @param {string[]} ids - 命中条目 id 列表（空数组为无操作）。
     * @returns {void}。
     */
    bumpRecall(ids) {
      if (ids.length === 0) return
      const placeholders = ids.map(() => '?').join(', ')
      db.prepare(`UPDATE entries SET recall_count = recall_count + 1, last_recalled = ? WHERE id IN (${placeholders})`)
        .run(Date.now(), ...ids)
    },

    /**
     * 无界候选匹配（replace/remove/consolidate 的定位语义；大小写不敏感）。
     * 可选隔离过滤（写定位 = 会话可见集）：agentKey 限制共享层 + 指定键；
     * scope='workspace' 且给出 workspaceKey 时按会话 cwd 键精确过滤。
     * 不带 limit——定位必须覆盖该层全部可见条目，绝不静默截断。
     * @param {string} track - 轨道。
     * @param {string} scope - 作用域。
     * @param {string} match - 目标子串。
     * @param {{agentKey?: string, workspaceKey?: string}} [opts] - 隔离过滤（缺省不过滤，向后兼容）。
     * @returns {MemoryEntry[]} 候选条目（创建序）。
     */
    matchCandidates(track, scope, match, opts = {}) {
      return matchEntries(db, track, scope, match, opts)
    },

    /**
     * (track, scope) 当前字符用量（JS 字符数，与 lib/budget.mjs 一致）。
     * @param {string} track - 轨道。
     * @param {string} scope - 作用域。
     * @returns {number} 用量。
     */
    usage(track, scope) {
      let used = 0
      const rows = /** @type {Array<{text: string}>} */ (db.prepare('SELECT text FROM entries WHERE track = ? AND scope = ?').all(track, scope))
      for (const row of rows) {
        used += row.text.length
      }
      return used
    },

    /**
     * 追加一条审计记录（插件自有审计账本，独立于会话日志）。
     * @param {AuditInput} row - {action, track, scope, entryId, text, outcome, source, sessionId}。
     * @returns {object} 审计行（含 seq 与 ts）。
     */
    auditAppend(row) {
      const ts = Date.now()
      db.prepare(`INSERT INTO audit (ts, action, track, scope, entry_id, text, outcome, source, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ts, row.action, row.track ?? null, row.scope ?? null, row.entryId ?? null,
          row.text ?? null, row.outcome ?? null, row.source ?? null, row.sessionId ?? null)
      return { seq: Number(db.prepare('SELECT last_insert_rowid() AS seq').get().seq), ts, ...row }
    },

    /**
     * 最近审计行（面板/审计用）。
     * @param {number} [limit] - 上限。
     * @returns {object[]} 按时间倒序。
     */
    auditList(limit = 100) {
      return /** @type {AuditRow[]} */ (db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit))
        .map((row) => ({
          seq: row.seq,
          ts: row.ts,
          action: row.action,
          track: row.track,
          scope: row.scope,
          entryId: row.entry_id,
          text: row.text,
          outcome: row.outcome,
          source: row.source,
          sessionId: row.session_id,
        }))
    },

    /** 关闭连接（幂等）。 */
    close() {
      closeDb(db)
    },

    /**
     * 幂等插入提案：同 (session_id, kind) 已存在则跳过并返回 null（INSERT OR IGNORE）。
     * @param {{kind: string, track: string, scope: string, workspaceKey?: string, agentKey?: string, text: string, source?: string, sessionId?: string | null}} input - 提案内容。
     * @returns {object | null} 已落盘提案；幂等命中返回 null。
     */
    proposalUpsert(input) {
      const { track, scope } = assertScope(input.track, input.scope)
      assertStoredText(input.text, 'proposal text')
      const id = randomUUID()
      const ts = Date.now()
      const result = db.prepare(`INSERT OR IGNORE INTO proposals
        (id, kind, track, scope, workspace_key, agent_key, text, source, session_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, input.kind, track, scope, input.workspaceKey ?? '', input.agentKey ?? '', input.text,
          input.source ?? 'dsh-memento', input.sessionId ?? null, ts)
      if (result.changes === 0) return null
      return toProposal(/** @type {ProposalRow} */ (db.prepare('SELECT * FROM proposals WHERE id = ?').get(id)))
    },

    /**
     * 提案列表（按创建时间升序；可按状态过滤）。
     * @param {string} [status] - pending/approved/dismissed；省略返回全部。
     * @param {number} [limit] - 上限（默认 100）。
     * @returns {object[]} 提案数组。
     */
    proposalList(status, limit = 100) {
      const where = status === undefined ? '' : 'WHERE status = ?'
      const params = status === undefined ? [limit] : [status, limit]
      const rows = /** @type {ProposalRow[]} */ (db.prepare(`SELECT * FROM proposals ${where} ORDER BY created_at, id LIMIT ?`).all(...params))
      return rows.map(toProposal)
    },

    /**
     * 裁决提案：pending → approved/dismissed（事务内定位+更新原子执行；
     * 非 pending 响亮报错，approve 与 dismiss 并发时先到者赢、后到者报错）。
     * @param {string} id - 提案 id。
     * @param {'approved' | 'dismissed'} status - 目标状态。
     * @returns {object} 已裁决提案。
     */
    proposalDecide(id, status) {
      if (status !== 'approved' && status !== 'dismissed') {
        throw new InvalidInputError(`proposal decision must be approved or dismissed, got ${JSON.stringify(status)}`)
      }
      return withTransaction(db, () => {
        const row = /** @type {ProposalRow | undefined} */ (db.prepare('SELECT * FROM proposals WHERE id = ?').get(id))
        if (row === undefined) throw new ProposalNotFoundError(id)
        if (row.status !== 'pending') throw new ProposalNotFoundError(id, `already ${row.status}`)
        db.prepare('UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?').run(status, Date.now(), id)
        return toProposal(/** @type {ProposalRow} */ (db.prepare('SELECT * FROM proposals WHERE id = ?').get(id)))
      })
    },

    /**
     * 幂等写入一条分领域知识水平：领域 × level × tier（domain 主键，覆盖旧值）。
     * tier 缺省时由 level 推导（tierForLevel）；domain/level/tier 非法响亮失败。
     * @param {ProfileInput} input - {domain, level, tier?}。
     * @returns {Profile} 已落盘的画像行。
     */
    profileUpsert(input) {
      if (typeof input.domain !== 'string' || !KNOWLEDGE_DOMAINS.includes(input.domain)) {
        throw new InvalidInputError(`profile domain must be one of the ${KNOWLEDGE_DOMAINS.length} knowledge subdomains (got ${JSON.stringify(input.domain)})`)
      }
      if (!Number.isInteger(input.level) || input.level < 1 || input.level > 10) {
        throw new InvalidInputError(`profile level must be an integer 1..10 (got ${JSON.stringify(input.level)})`)
      }
      const tier = input.tier ?? tierForLevel(input.level)
      if (!/** @type {readonly string[]} */ (KNOWLEDGE_TIERS).includes(tier)) {
        throw new InvalidInputError(`profile tier must be one of ${KNOWLEDGE_TIERS.join('|')} (got ${JSON.stringify(tier)})`)
      }
      db.prepare(`INSERT INTO profile (domain, level, tier, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET level = excluded.level, tier = excluded.tier, updated_at = excluded.updated_at`)
        .run(input.domain, input.level, tier, Date.now())
      return getProfile(db, input.domain)
    },

    /** @returns {Profile[]} 全部画像行（按 domain 升序）。 */
    profileList() {
      return /** @type {ProfileRow[]} */ (db.prepare('SELECT * FROM profile ORDER BY domain').all()).map(toProfile)
    },

    /**
     * 按领域取单条画像行。
     * @param {string} domain - 子领域名。
     * @returns {Profile | null} 画像行；未记录返回 null。
     */
    profileGet(domain) {
      return getProfile(db, domain)
    },
  }
  return store
}

/** 按 id 读取单条。 */
function getEntry(/** @type {Db} */ db, /** @type {string} */ id) {
  const row = /** @type {EntryRow | undefined} */ (db.prepare('SELECT * FROM entries WHERE id = ?').get(id))
  if (row === undefined) throw new StoreError(ERROR_CODES.STORE_CORRUPT, `entry ${id} vanished mid-transaction`)
  return toEntry(row)
}

/** 按领域取单条画像行。 */
function getProfile(/** @type {Db} */ db, /** @type {string} */ domain) {
  const row = /** @type {ProfileRow | undefined} */ (db.prepare('SELECT * FROM profile WHERE domain = ?').get(domain))
  return row === undefined ? null : toProfile(row)
}

/**
 * facet 列值校验（insertOne / replaceEntry 共用）：undefined/null → null；非七面词汇响亮失败。
 * @param {unknown} facet - 输入 facet。
 * @returns {MemoryFacet | null} 校验后的列值。
 */
function checkedFacet(facet) {
  if (facet === undefined || facet === null) return null
  if (typeof facet !== 'string' || !PROFILE_FACETS.includes(facet)) {
    throw new InvalidInputError(`entry facet must be one of ${PROFILE_FACETS.join('|')} (got ${JSON.stringify(facet)})`)
  }
  return /** @type {MemoryFacet} */ (facet)
}

/**
 * level 列值校验（insertOne / replaceEntry 共用）：undefined/null → null；非 1..10 整数响亮失败。
 * @param {unknown} level - 输入 level。
 * @returns {number | null} 校验后的列值。
 */
function checkedLevel(level) {
  if (level === undefined || level === null) return null
  if (!Number.isInteger(level) || /** @type {number} */ (level) < 1 || /** @type {number} */ (level) > 10) {
    throw new InvalidInputError(`entry level must be an integer 1..10 (got ${JSON.stringify(level)})`)
  }
  return /** @type {number} */ (level)
}

/**
 * 条目/提案正文校验：非空字符串且不含 NUL。node:sqlite 的 TEXT 列在 U+0000 处静默
 * 截断（写 511 字读回 10 字、零报错），所以 NUL 必须在落盘前响亮拒绝。
 * @param {unknown} text - 输入正文。
 * @param {string} label - 报错前缀（entry text / proposal text）。
 * @returns {string} 原文本（已校验）。
 */
function assertStoredText(text, label) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new InvalidInputError(`${label} must be a non-empty string`)
  }
  if (text.includes('\u0000')) {
    throw new InvalidInputError(`${label} must not contain U+0000 (NUL): the store column silently truncates it`)
  }
  return text
}

/**
 * 标签列值校验（insertOne / replaceEntry 共用）：undefined/null → []；否则必须是
 * 全为非空、无控制字符字符串的数组——任一脏元素都会在读取时毒化整库（STORE_CORRUPT）。
 * @param {unknown} tags - 输入标签。
 * @returns {string[]} 原数组（已校验）。
 */
function assertStoredTags(tags) {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) {
    throw new InvalidInputError('entry tags must be an array of strings')
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new InvalidInputError('entry tags must be an array of non-empty strings')
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(tag)) {
      throw new InvalidInputError('entry tags must not contain control characters')
    }
  }
  return /** @type {string[]} */ (tags)
}

/**
 * 校验并插入单条（insertEntry 与 seedEntries 共用；调用方决定是否在事务内）。version 缺省从 1 开始。
 * @returns {MemoryEntry} 已落盘条目。
 */
function insertOne(/** @type {Db} */ db, /** @type {StoreInsertInput} */ input) {
  const { track, scope } = assertScope(input.track, input.scope)
  assertStoredText(input.text, 'entry text')
  const tags = assertStoredTags(input.tags)
  const version = input.version ?? 1
  if (!Number.isInteger(version) || version < 1) {
    throw new InvalidInputError('entry version must be an integer >= 1')
  }
  const facet = checkedFacet(input.facet ?? null)
  const level = checkedLevel(input.level ?? null)
  const entry = {
    id: randomUUID(),
    track,
    scope,
    workspaceKey: input.workspaceKey ?? '',
    agentKey: input.agentKey ?? '',
    text: input.text,
    source: input.source ?? 'dsh-memento',
    tags,
    version,
    facet,
    level,
    status: /** @type {'active'} */ ('active'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastRecalled: /** @type {number | null} */ (null),
    recallCount: 0,
    sessionId: input.sessionId ?? null,
  }
  db.prepare(`INSERT INTO entries (id, track, scope, workspace_key, agent_key, text, source, tags, version, created_at, updated_at, session_id, facet, level, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.id, entry.track, entry.scope, entry.workspaceKey, entry.agentKey, entry.text, entry.source,
      JSON.stringify(tags), version, entry.createdAt, entry.updatedAt, entry.sessionId, facet, level, entry.status)
  return entry
}

/** 子串匹配候选（instr + lower，大小写不敏感；CJK 无大小写不受影响；可选隔离过滤）。 */
function matchEntries(/** @type {Db} */ db, /** @type {string} */ track, /** @type {string} */ scope, /** @type {string} */ match, /** @type {{agentKey?: string, workspaceKey?: string}} */ opts = {}) {
  const conditions = ['track = ?', 'scope = ?', 'instr(lower(text), lower(?)) > 0']
  const params = /** @type {Array<string | number>} */ ([track, scope, match])
  if (typeof opts.agentKey === 'string') {
    conditions.push("(agent_key = '' OR agent_key = ?)")
    params.push(opts.agentKey)
  }
  if (scope === 'workspace' && typeof opts.workspaceKey === 'string') {
    conditions.push('workspace_key = ?')
    params.push(opts.workspaceKey)
  }
  return /** @type {EntryRow[]} */ (db.prepare(`SELECT * FROM entries WHERE ${conditions.join(' AND ')} ORDER BY created_at, id`)
    .all(...params))
    .map(toEntry)
}

/** 事务包装：失败回滚并原样重抛（空 catch 语义：只回滚，不回吞）。 */
function withTransaction(/** @type {Db} */ db, /** @type {() => any} */ fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 连接已坏时 ROLLBACK 无意义，保留原错误 */ }
    throw error
  }
}

/**
 * 建表 + 版本迁移。每一步 DDL 都幂等（表用 IF NOT EXISTS，列按存在性补齐），
 * 因此 schema_version 行丢失时也能自愈：按梯子补齐后回填，而不是从 0 重建把库炸开。
 * 新库直接建到当前版本；旧库逐级迁移；版本高于当前 → 响亮拒绝（防降级读坏数据）。
 */
function migrate(/** @type {Db} */ db, /** @type {string} */ dbPath) {
  // 新库先探测表存在性再 prepare：对不存在的表 prepare 会直接抛错。
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined
  let start = 0
  if (hasMeta) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    // 行缺失（version 视作 0）不再等同坏库：下面的幂等 DDL 补齐后用 Upsert 回填，死胡同在这里打开。
    const version = row === undefined ? 0 : Number(row.value)
    if (!Number.isInteger(version) || version < 0) {
      throw new StoreError(ERROR_CODES.STORE_CORRUPT, `memory database at ${dbPath} has invalid schema_version ${JSON.stringify(row?.value)}`, { path: dbPath })
    }
    if (version > SCHEMA_VERSION) {
      throw new StoreError(
        ERROR_CODES.STORE_UNSUPPORTED_VERSION,
        `memory database at ${dbPath} has schema_version ${version} > supported ${SCHEMA_VERSION}; upgrade yammory_system instead of downgrading`,
        { path: dbPath },
      )
    }
    start = version
  } else {
    db.exec(BASE_SCHEMA_SQL)
  }
  let current = start
  if (current < 2) {
    db.exec(PROPOSALS_SCHEMA_SQL)
    current = 2
  }
  if (current < 3) {
    applyAddColumns(db, V3_ADD_COLUMNS)
    current = 3
  }
  if (current < 4) {
    applyAddColumns(db, V4_ADD_COLUMNS)
    current = 4
  }
  if (current < 5) {
    applyAddColumns(db, V5_ADD_COLUMNS)
    db.exec(PROFILE_SCHEMA_SQL)
    current = 5
  }
  // Upsert：新库插入、旧库回填、schema_version 行丢失时写回（三态合一）。
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(current))
}

/**
 * 按列存在性逐列补齐（幂等迁移）：列已在就跳过，绝不因重复 ALTER 让库打不开。
 * @param {Db} db - 连接。
 * @param {Array<[string, string, string]>} columns - [表, 列, DDL 定义] 清单。
 */
function applyAddColumns(/** @type {Db} */ db, /** @type {Array<[string, string, string]>} */ columns) {
  for (const [table, column, definition] of columns) {
    const present = /** @type {Array<{name: string}>} */ (db.prepare(`PRAGMA table_info(${table})`).all())
      .some((info) => info.name === column)
    if (present) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/** v1 基础表（meta/entries/audit）——新库建库与逐级迁移共用同一梯子（BASE → v2 → v3）。 */
const BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    track TEXT NOT NULL CHECK (track IN ('user', 'agent')),
    scope TEXT NOT NULL CHECK (scope IN ('user-global', 'workspace')),
    workspace_key TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS entries_track_scope ON entries (track, scope);
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    track TEXT,
    scope TEXT,
    entry_id TEXT,
    text TEXT,
    outcome TEXT,
    source TEXT,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
`

/** v2 proposals 提案表（auto-capture 的压缩记忆提案；(session_id, kind) 幂等；v2 形状无 agent_key）。 */
const PROPOSALS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    track TEXT NOT NULL,
    scope TEXT NOT NULL,
    workspace_key TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    UNIQUE (session_id, kind)
  );
  CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status);
`

/** v3 增量列：per-agent 作用域与召回排序列（幂等——按列存在性逐列补齐）。 */
/** @type {Array<[string, string, string]>} */
const V3_ADD_COLUMNS = [
  ['entries', 'agent_key', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'last_recalled', 'INTEGER'],
  ['entries', 'recall_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['proposals', 'agent_key', "TEXT NOT NULL DEFAULT ''"],
]

/** v4 增量列：协议 v1 条目规范——tags（JSON 数组）与 version（每次替换自增）。 */
/** @type {Array<[string, string, string]>} */
const V4_ADD_COLUMNS = [
  ['entries', 'tags', "TEXT NOT NULL DEFAULT '[]'"],
  ['entries', 'version', 'INTEGER NOT NULL DEFAULT 1'],
]

/** v5 增量列：七面多边形 facet + 分领域知识 level + soft delete 预留 status。 */
/** @type {Array<[string, string, string]>} */
const V5_ADD_COLUMNS = [
  ['entries', 'facet', 'TEXT'],
  ['entries', 'level', 'INTEGER'],
  ['entries', 'status', "TEXT NOT NULL DEFAULT 'active'"],
]

/** v5 profile 表（分领域知识水平；CREATE IF NOT EXISTS 保证迁移幂等）。 */
const PROFILE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS profile (
    domain TEXT PRIMARY KEY,
    level INTEGER NOT NULL,
    tier TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

/** 关闭连接（幂等，吞掉二次关闭的报错）。 */
function closeDb(/** @type {Db} */ db) {
  try { db.close() } catch { /* 已关闭或关闭失败：disposer 里不抛出，避免遮蔽卸载主错误 */ }
}

/** 审计保留裁剪：retentionDays > 0 时删除早于截止时间的审计行（audit_ts 索引已存在）。 */
function pruneAudit(/** @type {Db} */ db, /** @type {number} */ retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return
  const cutoff = Date.now() - retentionDays * 86400000
  db.prepare('DELETE FROM audit WHERE ts < ?').run(cutoff)
}

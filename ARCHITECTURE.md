# ARCHITECTURE

`yammory_system` 的架构文档：三角色 seam、数据流、以及每个关键设计决策的理由。面向对象：插件维护者与想接入 `ctx.memory` 的其它插件作者（如 dsh-claude-move 的 seed 集成）。

## 三角色 seam

本插件是完整的能力接缝（Service Definition / Provider / Consumer 三角色齐全），与"只做记忆仓库"的插件有本质区别：

```
┌─────────────────────────────────────────────────────────────────────┐
│  Consumer：memory 工具（F5）          Consumer：预热段注入（F6/S2）      │
│  - add/replace/remove/query           - systemPrompt 段，order=-50    │
│  - 规范 JSON + 纯 render              - 会话首 assemble 时同步读库     │
│  - 尊重 exec.signal                   - WeakMap 按 Session 冻结       │
│  Consumer：memory_recall（按需那半）  - = 表达约束 + 常驻画像 + 提案块 │
└───────────────┬──────────────────────────────┬──────────────────────┘
                │ 写（带 exec.agent/callId）      │ 读（同步，session cwd）
                ▼                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Service Definition：ctx.memory（F1，index.mjs MemoryService）        │
│  budgets()  add()  replace()  remove()  query()  seed()              │
│                                                                     │
│  写路径（不可绕过的审批门，S3）：                                      │
│    预算预检 ──▶ ctx.approval.request ──▶ 预算复审 ──▶ 落盘 ──▶ 审计    │
│              （审批对 approval/asked+decided 自动入会话日志）           │
│  读路径：无审批；query 带 sessionId 时记 recalled 审计行               │
└───────────────┬─────────────────────────────────────────────────────┘
                │ 同步 SQL（node:sqlite，单连接串行）
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Provider：lib/store.mjs（F2，本地 SQLite，WAL，零依赖）               │
│  entries：双轨×双层×文本 + 元数据（来源/时间/会话 id/workspace_key）    │
│  audit：  插件自有审计账本（动作/结果/审批来源/会话 id）                │
│  唯一子串匹配用 instr()；零/多命中报错；事务内 replace/remove 原子      │
└─────────────────────────────────────────────────────────────────────┘
```

设计目标：将来任何插件（包括 dsh-claude-move 的 `seed(source:'claude')`）都能向同一个 store 喂数据、读数据——store 是同一份，信任门在 Service 层统一把守。

## 数据流（一次写 → 下次会话可见）

```
memory 工具(add)
  → MemoryService.add（预算预检：store.usage + checkBudget）
  → ctx.approval.request（toolName:'memory'，reason 携带完整载荷 [yammory_system] 前缀）
      ├─ 审批服务先裁决会话级 policy（never 不可绕过）
      └─ waterfall：本插件 answerer（prepend）按 writePolicy 裁决
           ask → 委托 UI answerer（人类批准/拒绝）
           auto → allowed-once；off → rejected
  → outcome === allowed-once 才继续（否则 WriteDeniedError + <action>-denied 审计行，零落盘）
  → 预算复审（审批等待期间用量可能变化，此刻为权威）
  → store.insertEntry + audit 行（outcome 含 policy 来源）
  → 会话日志（已知事件类型）已有 approval/asked+decided 审计对
  → 下一会话首个 assemble：渲染预热块（表达约束 + 常驻画像，带用量头）注入 systemPrompt 段
     └ 同一文本也写入 audit(snapshot) 行 + system/message（S2 可重建）
     └ 工作区层 / agent 轨条目刻意不入预热块，走 memory_recall 按需取
```

## 关键设计决策

1. **快照注入走 systemPrompt 段（而非 pre-step sourced message）**。
   - `snapshotOrder` 直接映射段顺序语义（默认 -50：harness identity(-100) 之后、persona(0) 之前）；
   - rc.6 已证明的路径：`assemble.agent.session.header.cwd` 提供工作区作用域（dsh-claude-move 同款）；
   - 渲染文本随 `request/header` 事件逐字落会话日志（system 字段），加上 `audit(snapshot)` 行，S2 可重建有两条独立证据链；
   - 冻结语义 = systemPrompt 全文会话内不变 = 前缀缓存稳定（这正是"冻结"的设计目的）。
   代价与约束：提供者必须同步（rc.6 不 await），SQLite 同步读 + WeakMap 冻结满足 N1。

   **S2 分路：预热段 + 按需**（冻结机制不变，只改内容构成）。
   - 预热段（`renderWarmup`）=【表达约束】（profile 表分领域知识水平 → 四档说话要求，`lib/constraint.mjs`）+【常驻画像】（user 轨 × scope=user-global 条目）+ 待审批提案块（有则追加）；
   - 按需那半沿用既有 `memory_recall` 工具 + retrieval seam，不进开场：工作区层（scope=workspace）与 agent 轨（环境事实/约定/教训）刻意不入预热段；
   - 表达约束按 profile 表生成，仍在会话首次 assemble 时冻结——会话内新写入的 level 不改已注入文本；
   - 常量纪律：`KNOWLEDGE_TIERS`（S1 常量）与 `TIER_RULES`（`lib/constraint.mjs`）的分档边界必须一致，`assertTierRules()` 在模块加载期逐值比对 `tierForLevel`，漂移即响亮抛出。

2. **审批门做在 Service 写方法内部，不在工具层**（对应 Hermes issue #48181 教训）。
   - 任何路径（memory 工具、其它插件、未来 /memory 命令）只要调 `ctx.memory.add/replace/remove/seed` 就必然经过 `ctx.approval.request`；
   - `writePolicy` 是 Config（ask/auto/off，默认 ask），模型不可见、不可改；
   - 本插件在 `approval/request` 上注册 prepend answerer：只认领 toolName='memory' 且 reason 带 `[yammory_system]` 前缀的请求；ask 委托续链（人类 answerer），auto/off 直接裁决；
   - 会话级 `approval/never` 由审批服务在 answerer 之前裁决，任何 answerer（含 prepend）都无法绕过——本插件遵从该硬不变量。
   - **审批载荷完整化（approve-what-you-see）**：add/seed 载荷 = 新文本全文；replace 载荷 = `from:\n<旧条目全文>\n\nto:\n<新文本>`；remove 载荷 = 被删条目全文（不再是裸子串）；consolidate 载荷 = 每个目标的定位原文（单条 >300 字截断标注）+ 新文本。人批准的是具体变更而非抽象动作，approval/asked 的 reason 因此携带可重建变更的完整信息。
   - **被拒写也留痕**：`rejected/cancelled/unavailable` 一律在抛出 WriteDeniedError 前落 `<action>-denied` 审计行（outcome 标注真实裁决来源）。turn 内路径另有 approval/asked+decided 审计对；turn 外 gate 路径（/memory 命令）没有审计对可落，denied 行是拒绝的唯一证据链。

3. **预算 = 软预警线，Provider 层绝不截断（v2 拆上限）**。
   - 写入永不因容量被拒：越线只做提示，不拦写、不报错；`checkBudget` 只报「是否越线」；
   - `Config.budgets` 语义由「硬上限」改「软预警线」（值不变：user 2000 / agent 4000）；`BUDGET_EXCEEDED` 保留码位但不再产生；
   - 计数单位是 JS 字符（UTF-16 code unit）：中文场景一个汉字计 1，可预测；真正的收敛回路是整理机（F6）。

4. **memory/* 会话事件：词汇已声明，运行时自适应派发（rc.6 约束）**。
   - `types.d.ts` 声明合并了 `memory/added|updated|removed|recalled|snapshot` 的 SessionEventMap 词汇与载荷形状；
   - rc.6 无插件事件注册面：`KNOWN_SESSION_EVENT_TYPES` 不含 memory/*，且 `Session.append` 无法标记 `ignorable`——append 未注册类型会让该会话下次加载被持久化层整体拒绝（read 路径 enforce，见 session-persistence coordinator）；
   - 因此运行时只在 `KNOWN_SESSION_EVENT_TYPES.has(type)` 时才 append（未来 harness 收录后自动开启）；当前审计链 = approval/asked+decided（已知类型，reason 携带完整写载荷）+ 插件审计表 audit。这是与官方机制对齐后的必然选择，不是偷工减料。rc.1 / 0.1.3-alpha.1 复核（2026-09-04）：append 第三参仍为 surface-only SurfaceIntent、仍无 ignorable 写入通道，本决策不变。

5. **审计 = 审批对 + 审计表 + 快照三条链**。
   - 每次写：approval/asked（reason 全文载荷）→ approval/decided（结果）→ audit 行（outcome 含 policy 来源、entry id、会话 id）；
   - 每次被拒写：`<action>-denied` audit 行（turn 外 gate 路径无审批审计对，这是拒绝证据链）；
   - 每次 recall：audit(recalled) 行；每次快照：audit(snapshot) 行（与注入文本逐字一致）；
   - 卸载插件后：记忆库与会话日志保留，旧会话可正常加载（因为从不 append 未注册事件类型）。

6. **替换/删除的并发与回滚**。
   - replace/remove 在 Provider 层事务内"定位+变更"原子执行；Service 层审批前先定位（零/多命中不打扰用户）；
   - 审批期间条目被并发写移除：审批后重定位失败即结构化报错（响亮，不静默）。
   - seed 整批先全量预算预检，通过后同步插入（无 await 间隔），不存在部分写入。
   - **写定位 = 会话可见集**（决策 11 的可见性语义扩展到写路径）：replace/remove/consolidate 的匹配只命中共享层 + 写方会话 agent 键的条目（显式 `input.agentKey` 覆盖），`workspace` 层再按写方会话 cwd 键过滤——跨 agent、跨工作区条目对会话不可见，也就不可能被误改。
   - 提案裁决（`proposalDecide`）同样在事务内"定位+更新"原子执行：approve 与 dismiss 并发先到者赢；`/memory proposals approve` 在写成功后容忍提案已被并发裁决（不掩盖成功写）。

7. **工作区键**：workspace 条目按会话 cwd 的规范化绝对值隔离；Windows 下大小写不敏感（同一项目以不同大小写路径打开仍命中同一 workspace 层）。两个进程共用一个 `$DSH_HOME` 时，SQLite 以 busy_timeout 串行写，但"谁先写谁赢"，跨进程一致性不保证（学 Hermes 的官方警告，见 README 安全边界）。

8. **V2 观察面的命令写路径（turn 外审批门）**：`/memory` 命令在模型回合之外执行，而审批服务 `ctx.approval.request` 要求 open turn（`approval/asked + approval/decided` 审计对必须被 turn 包围，这是 DSH 持久化日志的 commit/replay 硬边界）。命令写因此走**同一** `approval/request` waterfall（同一 answerer 链、同一 `writePolicy` 裁决），差异只在审计落点：turn 内路径落审批审计对，命令路径落插件审计表 + `command/done`；被拒的命令写落 `<action>-denied` 行（见决策 2）。会话级 `never` 策略按公开 API（`approval.overrideOf`）在派发前预检，与审批服务同语义、不可绕过。这是对审批 seam 约束（审计对需 turn 包围）的最小偏离，已文档化并测试（`test/v2.test.mjs`）。
   - **export/import 备份迁移对**：`/memory export` 是纯只读路径（条目 + 预算的 JSON 导出，schema 标记 `memory-export-v1`，不落审计、不走审批门）。`/memory import <路径>` 或 `import '{...}'`（内联 JSON）读回该文档：校验 plugin/schema 标记与条目形状（未知 schema 版本响亮拒绝），条目数上限 `MAX_IMPORT_ENTRIES`（1000），然后经 `service.seed` 单次审批 + 全量预算预检 + 单事务原子落盘；source/workspaceKey/agentKey 随文档保留，条目获得新 id 与新时间戳、召回计数归零，提案/审计行不迁移（预算仍由 Config 决定）。

9. **V2 面板只读**：Web 面板（`dsh.client` 零构建抽屉）对记忆内容只读：条目浏览/搜索/预算条/可观测三数/审计尾；审批与写操作一律发生在 DSH 内置审批 UI + `memory` 工具（否则会与内置审批呈现重复并产生分歧）。唯一的非只读动作是「整理全库」按钮（决策 21）：它只登记一条待整理标记。
    - **控件与颜色都借官方的（前端优化方案）**：控件一律 `require('@deepseek-ai/dsh-client-ui-primitives')`（宿主浏览器侧平台种子表：`Button`/`Input`/`Tag`/`StateDot`/`Switch`/`Tooltip`），抽屉经 `react-dom/client` 的 `createRoot` 渲染（`react.createElement`，不用 JSX——**零构建不变**：无打包器、无新依赖，`exports["./client"]` 仍指向手写 `client.js`）。色值一律 `--dsw-alias-*` / `--dsw-static-*` / `--dsw-elevation-*` 令牌，亮暗主题自动跟随；插件自造 CSS 只剩定位、滚动与排布。
    - **抽屉挂官方通栏浮层（`shell.overlay`）**：与 `dsh-tidewatch` 同一席位（`kind: 'list'; scope: 'root'`，框架级悬浮层，条目自己 opt-in 指针事件）。插件注册一个只交容器的条目，抽屉按需渲染进去。**由此删掉了 `placeOpenButton` 那段「量 tidewatch 徽章高度、把按钮抬到它之上」的让位逻辑——两插件之间唯一的硬耦合解除**；入口按钮留在自建 fixed 层（定位与 id 不变）。

10. **检索引擎 = 大小写不敏感 instr + 召回计数排序，不用 FTS5**。
    - 实测（Node 22 内置 SQLite，FTS5 可用）：trigram 分词器无法索引单字 CJK 字符——`'中文测试'` 中查 `'中文'` 零命中；unicode61 把 CJK 连续段当一个 token，仅前缀可查。本插件语料以中文记忆为主，子串语义必须对 CJK 成立，instr 是唯一正确的内置引擎。
    - query 大小写不敏感（lower() 折叠 ASCII；CJK 无大小写不受影响），与面板过滤、sessionQuery 文本检索语义一致；replace/remove/consolidate 定位同语义（`lib/match.mjs` 的 `findUniqueMatch` 统一折叠，store 层 lower(instr) 与之一致）。
    - 召回排序：query 命中页的条目 `recall_count` +1、`last_recalled` 落地（SCHEMA v3 列）；排序 `recall_count DESC, updated_at DESC`（高频即重要）。快照仍走 `listEntries` 创建序（冻结块稳定优先）。
    - 未来真正的升级路径是 harness 出现 embedding seam 后的语义召回（Provider 角色天然兼容），不是 FTS5——本仓库已按决策 16 落地检索/嵌入 seam 的最小接入。

11. **第三维 agentKey（per-agent 作用域，SCHEMA v3）**。
    - 写方 session 的 `header.agentPreset` 经 `agentKeyOf` 规范化（缺失→'' 共享层）；条目与提案落 `agent_key`。
    - 可见性：`agent_key === '' || === 会话 agentKey`，且 scope 规则不变；预算仍按 track×scope 计（agentKey 不新增预算维度）。
    - **可见性对读与写定位一致生效（0.3.0）**：快照/提案沿用会话可见集；`memory` 工具与 `memory_recall` 的 query 按会话 agentPreset 过滤（`service.query` 的 `opts.agentKey`，显式给定才过滤）；replace/remove/consolidate 的匹配同样按可见集过滤（见决策 6）。管理面（`/memory` 命令、Web 面板）与未传 agentKey 的插件调用保持全量视图（向后兼容），面板与命令列表渲染非共享条目的 agent 键以便管理。
    - 工具不暴露 agentKey 参数——由写方 session 自动决定，模型不可选，避免污染。
    - **可见性对读与写定位一致生效（0.3.0）**：快照/提案沿用会话可见集；`memory` 工具与 `memory_recall` 的 query 按会话 agentPreset 过滤（`service.query` 的 `opts.agentKey`，显式给定才过滤）；replace/remove/consolidate 的匹配同样按可见集过滤（见决策 6）。管理面（`/memory` 命令、Web 面板）与未传 agentKey 的插件调用保持全量视图（向后兼容），面板与命令列表渲染非共享条目的 agent 键以便管理。

12. **语言面（Config.language，en/zh）与错误文案的分界**。
    - 随语言切换的只有**模型可见/命令/面板**文案：`memory`/`memory_recall` 工具描述与参数说明、预热段（含表达约束，`lib/strings.mjs` 词表）、`/memory` 命令输出、Web 面板标签（语言经 `/api/memento/*` 响应的 `language` 字段下发）。en 为源文，zh 为对应译文；未知语言回退 en。
    - **错误信息保持英文**：结构化错误码（`INVALID_INPUT`、`BUDGET_EXCEEDED`…）与 message 是跨语言的审计契约，模型按 code 分支（整合后重试等），不受 language 影响。
    - 非法 `language` 值在加载期响亮失败（schema 层 union + apply 直调路径双保险）。默认 `en` 与 DSH 核心提示一致。
    - `/memory export` 是纯只读路径（条目 + 预算的 JSON 导出，备份/迁移/透明性），不落审计、不走审批门——与 Claude Code/Codex"记忆是用户可读的纯文本"精神对齐。

13. **会话级记忆开关：关闭 = 注入停 + 召回禁 + 写入停 + 观察不碰（SCHEMA v6）**。
    - **状态存哪**：插件自有 SQLite 新表 `session_switch(session_id PK, enabled, updated_at)`（v5 → v6）；**只保留「关」的行**，重开即删行，所以「无行即开」既是缺省语义也是唯一写入语义（常量锚点 `SESSION_DEFAULT_ENABLED`）。三个方法：`sessionEnabled`（无行/空 id/非字符串 → 开）、`sessionSetEnabled`（关→upsert 0 行；开→删行）、`disabledSessionIds`（观察选区过滤用）。
    - **写入拦截在协议核心内部**（与决策 2 的审批门同级、在 gate 与任何落盘之前）：`MemoryProtocolCore.#assertSessionOn(action, write)`，挂载点是 `#validateEntry`（覆盖 add/replace/consolidate）与 `remove`/`seed`/`setProfile` 各自开头。因此工具路径、`/memory` 命令路径、`import`、提案 approve——任何调用路径都绕不过。拒绝时先落一行 `outcome='session-off'` 的审计（`text: null`）再抛 `SessionMemoryOffError`：**「这个会话不留痕」连被拒的正文也不留**。
    - **注入拦截在预热段回调**，且**开关优先于会话内冻结**：开关关掉时删除该 Session 的 WeakMap 冻结快照并返回空串——已冻结的段立刻失效，后续 assemble 一律空段，且不落 `snapshot` 审计（关了就不再留痕）。已进历史轮次的文本不追溯清除（那是本期明确不做的边界）。
    - **读侧拦截**：`memory_recall` 与 `memory` 工具的 `query` 动作属模型面读记忆，关则 `SESSION_MEMORY_OFF`，不检索、不 `bumpRecall`、不落 `recalled` 审计。管理面只读子命令（`/memory list|query|budgets|audit|adapters|export|proposals`）**不受影响**——它们是用户动作，开关管的是模型与会话，不是用户的检查权。
    - **观察通道（规格 3.6）**：当前会话关闭 → `memory_observe.scan` 直接拒（「当下」半边）；选区先把 `disabledSessionIds` 命中的历史会话滤掉再截断（「历史」半边），被滤条数计入账单 `scanned.skippedOff`——少看了几个会话必须让人看见。
    - **开关状态零会话事件**：决策 4 的自适应门不变，`/memory session` 与面板切换只落插件审计表（`session-switch`，`outcome='on'|'off'`，`text: null`）。UI 注册在 `conversation.session.header.actions`（session scope，`sessionId` 取 standard props；挂会话标题栏，Agent 预设占 order -10 的负序带、本钮取 0），`GET`/`POST /api/memento/session` 两条能力由**一条** `connection.fetch` 路由按 method 分派承载（注册表以 path 为键），与面板路由同栅栏（决策 9 的只读纪律不管这个开关：它改的是「本会话要不要记忆」，不是记忆内容）。
    - **不新增 Config 项**：守「策略集中、不做开关」纪律；开关是会话级用户动作，不是部署策略。

## V3 协同（F12/F13，接口已就位，文档对齐）

### F12：seed 与 dsh-claude-move 的对接方式

`ctx.memory.seed(entries, write)` 已在 V1 实现：一次 `ask` 审批整批、任一条超预算整批拒绝、逐条落审计（source 透传）。dsh-claude-move 接入时的对齐约定：

- 把 Claude `memory/*.md` 解析为条目数组，每条 `{ track: 'agent', scope: 'workspace', text, source: 'claude', workspaceKey }`（workspaceKey 用会话 cwd 规范化键，缺省时取写方 agent 的会话 cwd）；
- 以 `ctx.get('memory')` 可选依赖读取服务（dsh-claude-move 已有 `withService` 同款模式），服务缺失时优雅跳过——**不破坏其现有行为**；
- seed 的 `write.agent` 必须存在（审批路由），dsh-claude-move 的导入命令/工具有 invocation/exec agent 可传入；
- v2 起 seed 不再因预算整批失败；越预警线照常落盘。

### F13：auto-review hook 点（不实现第二模型）

本插件暴露的接缝：`write.gate`（写上下文里的可选函数）。默认走 `ctx.approval.request`（turn 内、落审批审计对）；`/memory` 命令在 turn 外以 `makeCommandGate` 注入同一 waterfall 的无审计对变体。未来的 dsh-auto-review 若想接管记忆写审批，可在 `approval/request` 上注册自己的 answerer（先于/取代人类 answerer），无需改本插件一行——审批 answerer 链本身就是 hook 点；`writePolicy` 为 `ask` 时 `applyWritePolicy` 委托 `next()`，任何挂链的第二模型 answerer 都能接管。

## 配置面（无硬编码 tunable）

全部字段可 cordis.yml 覆盖，schema 见 `index.mjs` 的 `Config`；完整字段表（`enabled` / `dbPath` / `budgets` / `writePolicy` / `writePolicies` / `language` / `snapshotOrder` / `maxEntriesPerQuery` / `commandListLimit` / `commandAuditLimit` / `recall.*` / `panelEntriesLimit` / `panelAuditLimit` / `auditRetentionDays` / `proposals.*`）以 README 配置表为准，本文件不再逐项复制以免漂移。非法值加载期响亮失败。
- **harness 主目录回退（0.3.1）**：`dbPath` 为空或相对路径时，基准目录取 `$DSH_HOME`；`dsh web` 启动不会把官方 `resolveDshHome()` 解析出的主目录写回 `process.env.DSH_HOME`，因此未导出时回退 `~/.dsh`（与官方回退同语义）——否则默认 Windows 配置会在真实 boot 时整体崩溃（issue #1）。`lib/` 零 DSH 依赖的红线不允许 import `@deepseek-ai/dsh-home-paths`，用 `os.homedir()` 复刻同一回退。
- **宿主设置面板接入（settings namespace）**：settings 服务挂载时经 `installSection` 注册 `yammory-system` namespace（`SettingsSchema` = `Config` 去 `enabled` 加 `panel`，base = 组合配置，validate 复用同一业务校验）。真 cordis 下 `ctx.inject` 回调恒为异步 fiber——apply 同步段先按组合值开库，回调（启动早期或运行期变更）再应用差异：热字段（writePolicy(s)/language/budgets/各 limit/proposals/panel）即时生效（answerer 与命令门每次读 live 容器，service 实例属性同步更新）；`dbPath`/`auditRetentionDays` 差异重开 store 并关旧库；`retrieval.vector` 差异拆旧装新检索器（`live.retriever` 供 recall 工具按调用读取）；`snapshotOrder` 因 section 注册期固定无法热改，响亮写 `settings-startup-fields` 审计并要求重载。`enabled` 不进 namespace：false 时插件整体卸载、卡片随 namespace 消失，从 UI 上无法恢复。settings 缺失（headless）时 live 保持组合值，行为与未接入前一致。
- **设置一级项（零构建）**：`client/client.js` 同时注册第二个客户端模块 `yammory_system/settings-section`（factory 经宿主模块系统 require 平台内置 react 与官方控件库，无构建步骤），向 `settings.section` slot 注册 id 为 `yammory-system` 的一级设置项（宿主设置弹窗左侧菜单即该 slot 账本渲染，无白名单；`label` 即插件名，`order` 用普通值不抢内置位置）。页面内容走统一暂存—保存/放弃/单字段重置语义（对齐宿主 CardForm）；保存落盘后若涉及 `panel.enabled` 则同帧切换入口显隐（无需刷新）；界面语言跟随所选（含草稿）语言。写入按顶层字段聚合（`scope.set(top, 合并值)`），不依赖点路径写入面。面板入口开关经 `/api/memento/entries` 响应的 `panel` 字段贯通到面板启动探测——host 与面板同源，不依赖浏览器读 settings。

## 协议 v1（0.4.0：dsh-memory-protocol 社区预演）

### 13. 协议与实现分离：写语义抽进 lib/protocol.mjs（零 DSH 依赖）

0.4.0 把 MemoryService 的写语义整体抽进 `lib/protocol.mjs` 的 `MemoryProtocolCore`：预算预检 →
gate → 预算复审 → 落盘 → 审计的完整流水线、唯一子串定位、`<action>-denied` 审计行、协议级
校验（`validateMemoryEntry` / `validateExportEnvelope` / `validateAuditRow` / `normalizeTags`）。
`index.mjs` 的 `MemoryService` 变成薄子类，只注入两件 DSH 专属物：审批传输（ctx.approval）与
会话事件派发（memory/* 已知类型自适应门，见决策 4）。一致性套件的黄金参考 = 同一 core +
自动放行 gate——协议声称与实现同源，不存在"套件通过、实现另写一份"的漂移空间。协议常量
（`PROTOCOL_URI`、标签上限等）在 protocol.mjs；错误码语义进协议文档（docs/protocol-v1.md §7）。

### 14. store schema v4：条目 tags + version（协议 v1 条目规范）

- `tags`：JSON 数组列；协议常量上限 16 个 × 每标签 32 字符，trim/去重/禁控制字符，
  协议层 `normalizeTags` 校验（预算只计 text，tags 不计）。
- `version`：整数列，新条目 1；每次 `replace` 在 Provider 事务内 `version = version + 1`；
  consolidate/seed/导入产生全新 version 1 条目。审计链可经 entryId + 逐次审计行重建同一 id 的
  演进史。
- 迁移：SCHEMA_VERSION 3 → 4 走既有逐级迁移梯子（`V4_SCHEMA_SQL`），旧库无损升级；
  过新版本照旧响亮拒绝。

### 15. 适配器注册表（ctx.memoryAdapters）与一致性套件

- `lib/registry.mjs` 的 `MemoryAdapterRegistry`：`register`（返回 disposer，id 冲突响亮）/
  `list` / `adapt` / `export`；index.mjs 经 `ctx.effect` 注册三个参考适配器
  （`lib/adapters.mjs`：mem0 / hermes-memory-md / claude-code-memory-md），随插件生命周期可逆。
  适配器是纯数据转换器——只转换、绝不调模型抽取（载荷无事实条目时 `ADAPTER_PAYLOAD` 响亮失败）。
- 命令面：`/memory adapters`、`export --adapter=<id>`（只读 stdout 转换）、
  `import --adapter=<id> <路径|内联 JSON>`（转换 → `service.seed`：一次审批 + 全量预算预检 +
  单事务 + 逐条审计）。
- `test/protocol-conformance/`：可对外分发的用例集（suite/golden/run + Provider 契约 README），
  仓库 CI 以黄金参考全绿；第三方 Provider 拷贝目录即可跑同一套用例。协议文档：
  `docs/protocol-v1.md`（双语）、`docs/schemas/dsh-memory-protocol-v1.schema.json`、
  `docs/adapters-guide.md`（双语）、`docs/upstream-proposal.md`（双语，官方 seam 采纳论证与迁移路径）。

## P0：检索与嵌入 seam（可插拔检索 + 伪嵌入向量召回）

### 16. 检索 Provider seam（lib/retrieval.mjs）与嵌入 Provider seam（lib/embedding.mjs）

把 memory recall 的"检索"抽成可插拔检索器，并新增嵌入 Provider 接口，两者都是完整的
三角色 seam（Service Definition / Provider / Consumer），零 DSH 依赖、零重依赖：

- **检索 seam**（`ctx.memoryRetrieval`，`lib/retrieval.mjs`）：`RetrievalProvider` 契约 +
  `RetrievalProviderRegistry`（register 可逆 / list / get / resolve）。默认主路径是
  `KeywordRetriever`（F2 层 A ＋ 层 B 零依赖半边，零依赖：CJK 相邻二字 bigram ＋ 拉丁整词切出词元
  → 命中正文、或只在 `tags` 命中（折权 `tagDiscount`）即召回 → 相关度 = 0.5×覆盖率 ＋
  0.3×词元长度权重 ＋ 0.2 整串精确加成，`min(1, …)` 封顶 → 再加权 **热度**（召回次数封顶 ×
  距上次召回的半衰期衰减）与 **新旧**（`updatedAt` 半衰期衰减）→ 排序 = 加权分 DESC →
  相关度 DESC → `rankOrder`。加权表 `recall.weighting` 是 Config 字段（设置页可改、热生效，
  改后重建检索器）；缺 `lastRecalled`／`updatedAt` 一律取基线（不加成）——把「没时间戳」当成
  「最新」会倒转旧口径）；`SubstringRetriever` 是整串字面命中的对照件
  （语义与 `store.queryEntries` 的 instr 一致），仍注册供对照、MCP 与第三方显式选用；
  `VectorRetriever` 是可选后端，消费嵌入 provider 做内存内暴力余弦排序（小语料，与决策 10 一致）。
- **嵌入 seam**（`ctx.memoryEmbedding`，`lib/embedding.mjs`）：`EmbeddingProvider` 契约 +
  `EmbeddingProviderRegistry`。默认 `FakeEmbeddingProvider` 是确定性的 token 哈希分桶计数 +
  L2 归一化（固定 256 维单位向量）——它不做语义建模，只验证 seam 接线与余弦召回路径可复现，
  且**显式声明 `semantic: false`**；真实嵌入由可选 provider 注册（本地模型 / peer，缺省视为语义），
  本仓库不引入 sqlite-vec / ONNX / 本地模型。
- **Consumer 接线**：`memory_recall` 的记忆段恒走检索器路径（`live.retriever` 初值即
  `KeywordRetriever`，非空；可见集 = `visibleEntries` + 检索器排序 + `store.bumpRecall` +
  `recalled` 审计）。`Config.retrieval.vector`（默认 `false`）开启且探测到**声明为语义**的嵌入
  provider（`semantic !== false`，取 id 升序首名）时换装 `VectorRetriever`；vector 关闭、无 provider、
  或只有伪嵌入时一律回落 `KeywordRetriever`（不再回落 null / `service.query`）。伪嵌入**刻意不算可用**：
  它按「连续字母/数字段」切词，中文整句即一段，拿它做语义召回等于用一个名为「语义召回」的开关
  **静默关掉中文召回**——这正是本仓最不想要的那种失效。
  keyword 检索器**不进注册表**（`live.retriever` 持单例），`retrievers.get('keyword')` 为空属预期。
- **探测 → 使用 → 优雅降级**：`detectVectorBackend` 要求 provider 存在**且声明为语义**（伪嵌入返回
  `available: false` ＋ `reason: 'embedding provider is not semantic'`）；sqlite-vec 是
  可选 loadable 扩展、恒不在本仓库打包（`sqliteVec: false`），P0 向量召回走内存内暴力余弦。
  缺语义 provider / vector 关闭时优雅降级回 keyword，绝不响亮失败（可选后端缺失不是配置错误）。
- **层 A 的已知边界**（层 B 再议，见 `docs/F2检索升级方案.md`）：词元按「连续字母/数字段」切，
  CJK 与拉丁同段书写（无空格，如「用户偏好abc」）时整段走 bigram，拉丁部分不再以整词形态成为
  词元；相邻二字滑窗会产生跨词 bigram（「用户偏好英文」切出「好英」），因此长查询的排序由
  覆盖率与整串加成共同主导。召回面是旧路径的超集（放宽为「命中任一词元」），代价是好坏参半：
  多词查询从零命中变为可召回，代价是弱关联条目也会占位（如 `mode` 命中 WAL 条目）。
- **层 B 的零依赖半边（2026-09-14）**：加权（相关度 × 热度 × 新旧；热度带半衰期衰减以断「被召回→分更高→更常被
  召回」的增强回路）＋ 匹配面扩到 `tags`（折权）＋ 六个加权值经 Config `recall.weighting` 下发（设置页可改、
  热生效）＋ `retrieval.vector` 收口。真语义嵌入仍缺「嵌入源」——本机 DSH 没有可用的嵌入端点，
  `retrieval.vector` 因此在只有伪嵌入时等于没开（刻意的：比「开了更糟」强）。见 `docs/检索加权方案.md`。

### 17. 观察通道（S4b）：读历史 → 让当前会话的模型推断 → 过审批门落库

画像采集的第二条腿。问卷问「你想要什么」，观察看「你实际怎么做」；五个仅观察面（思维方式与思辨 /
人格特质 / 情绪模式与心理强度 / 自我认知 / 决策与行动风格）自陈最不可靠，只由观察覆盖。方案与
实测校准见 `docs/观察通道方案.md`、`施工清单.md` 的 S4b-0 行。

- **落点：一个工具 ＋ 一个 skill，不新增基础设施。** `memory_observe`（`index.mjs`）负责「取切片」
  与「批量落库」；`skills/yammory-observe/` 承载推断提示词与克制纪律。推断由**当前会话里已经在跑的
  模型**做——不新增模型调用通道（`ctx.llm` 直调会让推断这段变成会话日志之外的黑箱，撞「模型可见 ⟺
  落盘」的红线）、不新增后台进程、定时器与数据库。
- **读通道走公开服务 `ctx.sessionQuery`**（`ctx.get('sessionQuery')`，只读；精确读取/过滤/title 可用，
  全文搜索在 base 里默认关闭、观察不需要它）。缺失时抛 `SessionQueryUnavailableError` 并由工具层转成
  「响亮降级」（`ok:false` ＋ `SESSION_QUERY_UNAVAILABLE`），绝不假装「没有历史」。
- **闸一（授权收窄，最关键）**：内核把「调用方授权」明确甩给调用方（其 README 原文：No caller
  authorization）。`sessionScope` 因此只允许两种读法——有 `cwd` 时只读 `cwd` **精确相等**的会话；
  没有 `cwd` 时只读当前会话自己（`id` 精确相等，结果里 `selfOnly: true`）；两者都没有则响亮拒绝。
  工具参数面**不给任何 sessionId 入参**，模型只能说「最近 N 天」，不能点名某个会话。
- **闸二（事件过滤）**：白名单 `{user, user-rpc}`。本机实测（273 份日志 / 1892 条 `user/message`）
  `source.kind` 实有 9 种，未过滤时 **910 条（48.1%）是系统注入的伪发言**（AGENTS.md、skill 目录、
  runtime context、goal 轮次、子代理通知）；白名单保住了全部 982 条真人发言。残余边界已登记：16 条
  无 `rpcId` 的 `user` 里混有外部桥接注入，仅凭 kind 无法与真人发言区分。
- **预算与诚实账单**：`lib/observe.mjs` 逐行记账（`buildObservationSlice`），到顶即停并把「没看到的
  会话数 / 条数 / 天数」写进 `uncovered`——与项目「绝不静默截断」同纪律。参数由 `resolveObserveOptions`
  在 Provider 层钳到 `OBSERVE_LIMITS`（硬上限），模型传 `days=99999` 也放大不了预算。
- **写入口径**：`commit` 走 `service.seed`（写路径的强制点在 `MemoryProtocolCore` 内部，工具层绕不过），
  一次 commit 一次审批 ＋ 一次原子写；`source` 锚死 `'observation'` 不由模型传；条目落
  `user/user-global`，`facet` 取七面值（子板块进 `tags`，零 schema 改动），文本自带 `[观察 日期]` 前缀
  与证据片段——审批时人看到的就是证据。粒度键 `source:observation` 让用户单独把观察设成 `auto` / `off`；
  为此 `seed` 会把同源批次的 `source` 带进审批载荷（混源批次不带，回退 `track/scope` 与全局策略）。
- **v1 只做「并存 ＋ 标注」**：不 supersede、不删旧条目（回滚与仲裁语义留给 S5），观察与自陈的落差
  本身就是最值钱的画像。
- **命令面 `/memory observe`**：只读打印同一份切片与账单，末行指向模型推断路径。它不叫模型、不写库，
  是「用户想先看看要花多少上下文」的那一档。
- **预热段末行的一行目录**（S4b-6）：把不进预热的那半边（workspace 层 ＋ agent 轨）折成一个条数写在
  预热块末尾，让模型知道有东西在等着按需取；只报条数，正文仍只在 `memory_recall` 里出现。

### 18. 整理机（F6）：合并 ＋ 降级留痕，语义判断归当前会话的模型

拆掉硬上限之后（决策 12 / v2 规格 3.1），记忆只增不减。整理机就是那条**负反馈回路**：把散落各处、
其实在讲同一件事的条目并成一条，旧条目**降级留痕**而不是物理删。方案见 `docs/F6F7施工方案.md`。

- **载体：模型面工具 ＋ 原生 skill，不新增基础设施。** 与决策 17 同款范式——`memory` 工具新增两个
  动作（`tidy` 只读取计划、`supersede` 过门落写），`skills/yammory-tidy/` 承载判断纪律。判断由
  **当前会话的模型**做：后台 `ctx.llm` 直调会让「哪几条该并」这段成为会话日志外的黑箱，撞「模型可见
  ⟺ 落盘」的红线。不新增定时器、不新增后台进程、不新增数据库。
- **降级不删（规格 3.5.5）**：`store.supersedeEntries({ids, text?})` 在一个事务里把目标置
  `status='superseded'`，可选同时落一条合并后的新条目。`entries.status` 列自 v5 建表起「有列无行为」，
  本轮接通了写入语义：**只从 active → superseded**，回滚（superseded → active）留给 S5。
- **读路径只谈在场条目**：`listEntries` / `queryEntries` / `matchCandidates` / `usage` 一律排除已降级行，
  于是降级一次即同时退出预热段、召回、查库、写定位与预警线用量；管理与统计面走 `allEntries()`，
  `entryById(id)` 仍能按 id 读到留痕条目（审计与将来的回滚靠它）。
- **桶内不跨（规格 3.5.8）**：`track × scope × agentKey`，`scope=workspace` 时追加 `workspaceKey`。
  跨桶混装被协议层响亮拒绝（`INVALID_INPUT`）——不同桶语义不同，跨桶合并会把 A 桶的正文搬进 B 桶。
- **合并条目继承源桶（红队②高 1）**：落桶键取自 `targets[0]`（`assertSameBucket` 已保证同桶），
  写方会话的 `agentKey` / `workspaceKey` **只用于判断可见集**。拿会话键当落桶键的代价见决策 22：
  带 preset 的会话整理一次共享条目，就把共享记忆静默收进该 agent 专属。显式 `input` 仍以显式为准。
- **只动会话可见集**：与写定位同语义（agentKey 共享层或本 agent；workspace 层匹配本会话 cwd 键）。
  别的工作区/别的 agent 的条目看不到、也合不了。
- **审计形状**：降级行 `action='supersede'`，**`text` 恒为 null、只记 id**（降级是元数据动作，审计不
  复制正文，时间线由行的 `ts` 承担）；合并产出的新条目照常记 `supersede-add`（带正文）；每批收尾落
  一行 `action='consolidation'` 变更摘要——它同时是开工线读取的「上次整理」时间锚。
- **收益判据由标机械判出（规格 3.5.11）**：整理产出的条目恒带 tag `merged`；下次整理见到就跳过，
  不必每次靠模型重新认。标是「已整理」的信号，不等于「永不整理」。
- **触发只提示、不自动跑（规格 3.5.1 的 v1 裁剪）**：`agent/turn-stopping` 挂点**只读**算一次积压
  （自上次整理以来 ≥2000 字符或 ≥10 条，另加 12 小时兜底），过线时落一行 `tidy-due` 审计（同进程
  按小时节流）并让下一个会话的预热段末行带一句提示；真整理由 `/memory tidy` 或用户开口显式发起。
  监听器整体吞住异常——该事件是串行派发，抛错会以错误收尾该轮，只读检查不该有这个权力。
- **v1 不做**：跨桶合并、Dream、回滚（S5）。全库整理的**排队式登记**由决策 21 补上（登记是标记表，整理仍由模型在会话内显式跑）。已降级条目不进
  `/memory export`（导出信封没有 `status` 字段，导回来会变成在场条目）。

### 19. 可观测三数（F7）：重复率 / 召回命中率 / 注入量

「更懂你」这件事要能被测量，否则调优全靠感觉。三个数都由**纯函数**从库里现成数据算出，零模型、
零新表、不落审计（`/memory stats` 与 `GET /api/memento/stats` 同源，`lib/stats.mjs`）。

- **① 重复率**：条目两两相似度超阈值的对占比（`tokenize` ＋ Jaccard，O(n²)；语料小，可接受）。
  只算在场条目；超过比较上限时如实标 `truncated`，不静默截断。
- **② 召回命中率**：有命中的召回次数 ÷ 总召回次数。供数靠 `recalled` 审计行的 `outcome`
  （`ok` = 命中，`empty` = 零命中）。为此两个召回路径都补记了零命中行：`memory_recall`（检索器路径）
  与 `query`（协议路径）——少了这一步，分母只剩成功样本，命中率天然虚高。F7 之前的旧行无法区分，
  故措辞里注明「旧窗口偏高一点」。
- **③ 注入量**：预热段的字符数与条目行数（数据源 = `snapshot` 审计行的冻结文本）。条数按 `- ` 行数
  估算，措辞里照说「约」。
- **成功率刻意留白**：它的本义是「注入之后对方是否真的听懂了」，本仓库没有这条信号源。`buildStats`
  恒返回 `successRate: null`，`/memory stats` 明写「需反馈通道，待定义」——拿命中率或别的数冒充，
  比留白更坏。

### 20. 治理（S5）：回滚是单向逆运算，裁决方向是代码不变量

F6 让记忆有了负反馈回路，但那条回路当时只能往一个方向走：`active → superseded` 有写入路径，
反方向没有。S5 补上这一条，并把「观察与自陈打架时听谁」从 skill 里的软口径变成表驱动的机制。
方案见 `docs/S5治理方案.md`。

- **回滚严格互逆**：`store.restoreEntries({ids})` 只把 `superseded → active`，目标是 active 或未知 id
  一律响亮失败并整批回滚。它不是「改状态」的通用口子——回滚有且只有一个语义，方向也只有一个。
  协议层 `restore(input, write)` 与其它写方法同门：`#assertSessionOn` → 桶内与可见集校验 → 审批门 →
  事务 → 审计 `action='restore'`。恢复的条目 `version` 与 `updated_at` 都不动（它没被改写），
  回到会话可见集后重新计入预热段、召回、写定位与预警线用量。
- **方向由表决定，调用方没有反向参数**：`ARBITRATION_BY_FACET`（`lib/constants.mjs`）把七面映射到
  三个方向——能力与技能听观察、价值与意愿听自陈、其余五面 coexist。`arbitrate(input, write)` 只接受
  `ids`，方向从表里查。「能力听观察」因此不是提示词纪律，是代码不变量：模型想反着来也没有入口。
  表与七面在加载期由 `assertArbitrationTable()` 校验，脱节即抛。
- **一组里保留谁也是规则**：同组多条取 `updatedAt` 最新者，其余同组条目一并降级；`updatedAt` 相同
  按 id 稳定决胜。规则可复核，不给模型挑的机会。
- **方向表管的是裁决动作，字段可写性不在它管辖内（登记为设计边界，红队②中 1）**：`facet` 仍是普通
  可写字段，改写它需要一次显式 `replace` ＋ 一次审批 ＋ 一条审计。于是「把能力类改成意愿类再裁决」
  这条路是**通的**——它是被审计留痕的显式路径，不是静默越权。硬堵需要把 `facet` 变成只能经受控通道
  写的字段（从 `replace` 的入参里拿掉），代价是问卷与观察两条采集腿的正常改写也要另开通道；本轮
  按方案只在文档登记，代码不设卡。
- **保留者在审批后复检（红队②高 2）**：`kept` 在审批前算好，审批窗口里 champion 可能已被降级。落盘
  之前用 `entryById` 复检它仍是 `active`，否则 `INVALID_INPUT` 响亮失败、零落盘、**不写那行「kept X」
  摘要**——审计宁可失败重来，也不说一句与库况相反的话。回带条目换成库里当下的快照（审批期间它可能
  被 `replace` 过）。`coexist` 面没有保留者，跳过这一步。
- **落差两条都留**：coexist 面一条都不降级，两组各打一枚 `gap` 标（`store.tagEntries`，幂等、越标签
  上限响亮失败）。落差是证据，抹掉它才是失真。
- **一次审批，两次落盘**：审批载荷写清「按面裁决：保留谁、降级谁、理由」（approve-what-you-see），
  审批在两次落盘之前完成——所以不存在「没批就写」的旁路。落盘本身是**两次各自原子的 store 事务**
  （降级一批、打标一批），跨这两个动作不具备单一事务的原子性；这是方案「一批一事务」未言明的一处
  口径细化。降级与打标都属 coexist 面的相反走向，同一批里不会同时发生（降级时无标、打标时不降级）。
  审计形状对齐 F6：每条降级一行 `action='arbitrate'`，**`text` 恒为 null**
  只记 id；打标一行 `arbitrate-tag`（带正文，它是注记不是降级）；每批收尾一行 `arbitrate` 摘要
  （`entryId` 为 null），写清保留谁、降级谁、方向是什么。
- **失败的边界**：facet 不一致、facet 为空、只有单一来源、跨桶、重复 id、状态不符，全部在审批门
  之前响亮拒绝，零落盘。跨桶校验刻意排在面校验之前，报出来的病因才对得上。
- **与 F6 的分工**：`supersede` 管「同一来源的重复合并」，`arbitrate` 管「不同来源的冲突裁决」。
  两者复用同一套 store 面、审批门、审计形状与桶内边界；**都不新增 Config / 依赖 / 定时器 / 后台模型
  通道**。置信门槛（多高的把握才允许覆盖）刻意留 v2——它需要真实观察数据攒够才定得出线。

### 21. 收边（面板两处 ＋ 门牌）：三数上屏，全库整理排队

数据面早已就绪、界面上还空着的两处补上：面板读三数，面板按钮**排队**全库整理。方案见
`docs/收边方案.md`。

- **三数行由服务端渲染，面板照抄**：`GET /api/memento/stats` 返回 `stats` 与渲染好的 `lines`
  （`statsLines` 与 `/memory stats` 同源）；`client/client.js` 把 `lines` 逐行贴进抽屉的「可观测三数」
  区，语言跟随响应的 `language`。措辞只有一处出处，命令面与面板不会漂移；面板不重算任何数。
- **按钮是排队，不是动作**：点击 → `POST /api/memento/tidy-request` → 新表
  `tidy_requests(id, created_at, status)`（SCHEMA v6 → **v7**）落一条 `pending` 标记 → **下一个会话**
  的预热段末行追加一句「用户点过全库整理，请跑一次 memory tidy（全库）」→ 模型在会话内跑完落写
  （`supersede`）时标记转 `done` 并落一行 `tidy-request`/`cleared` 审计。登记只写标记：不调模型、
  不碰条目、不经后台通道；整理动作永远是会话内、过审批门的显式写。
- **登记幂等**：已有 `pending` 就原样返回它（`created: false`），重复点击不堆行；`done` 行保留在库里，
  作为「用户点过、模型跑过」的痕迹（清除只改状态，绝不物理删）。
- **面板动作没有会话，因此走 turn 外 gate**：`connection.fetch` 路由没有 agent，审批服务那条
  「必须有 open turn」的路（决策 8）不参与。登记因此与 `/memory 命令` 同一条 `approval/request`
  waterfall（同一 answerer 链、同一 `writePolicy`：`auto` 静默放行、`ask` 交给 UI answerer、`off` 拒绝），
  写上下文里的 agent 不含 session——审计行 `sessionId` 恒为 `null`，如实记「这个动作不属于任何会话」，
  不编造归属。审批载荷的 `track/scope` 写 `library/all`：全库范围不是任何真实桶，且它不是合法的
  写策略键，策略解析自然落到全局或 `source:panel`。
- **空块也带提示**：预热段有一条「无可渲染内容就返回空串」的纪律，排队提示是例外——它是用户点过的
  动作，模型必须看见；块因此非空时照常落 `snapshot` 审计行（模型可见 ⟺ 落盘）。会话开关关掉的会话
  仍然整段不注入，提示也不会出现（那种会话本来就不该替用户整理记忆）。
- **不越界**：不新增 Config / 依赖 / 定时器 / 后台模型通道；不往会话日志 append 新事件类型；
  面板不做任何写记忆操作。

### 22. 红队第二轮修复（0914-18 战报的 6 条）：静默不一致的收口

一轮敌对视角的只读红队（真 WebServer ＋ 真 `client-connection` ＋ 真 store 临时库）在 F5 / F6 / S5 /
收边 / v7 迁移五个重点面上撬出 2 条高危、4 条中危。六条的病灶同型：**库、审计、会话可见集三处的
说法对不上**——防线没有被绕过，是防线两侧的口径不同步。方案见 `docs/红队2修复方案.md`，
回归用例见 `test/redteam2.test.mjs`。

- **高 1 · 合并条目继承源桶**：`supersede` 的合并产出原先取写方会话的 `agentKey` / `workspaceKey`，
  于是带 preset 的会话整理一次**共享**条目，就把共享记忆静默收进该 agent 专属（单向、不可逆）。
  现在落桶键取自 `targets[0]`，会话键只用于可见集判断；显式 `input` 仍以显式为准。详见决策 18。
- **高 2 · 保留者审批后复检**：详见决策 20。
- **中 2 · `enabled` 严格布尔**：`POST /api/memento/session` 原先只认 `=== true`，字符串 `"true"` 会被
  静默当成 `false` 落库（用户以为开了、库里记的是关）。现在非布尔一律 `400`，不落库、不回显假值。
- **中 3 · 会话开关的归属校验（如实登记为未闭合）**：先按 DSH 源码核实能力——`connection.fetch` 的
  exact route handler 签名是 `(request: Request) => Promise<Response>`，分发链（`client-connection`
  的 `createSharedFetchHandler`）只按 path 匹配后把 Request 原样递给 handler，**不注入任何会话上下文**；
  Request 的 headers 全部由页面自己写，同源页面可伪造；DSH 的 browser-auth 是**进程级**凭据
  （区分「是不是本进程的浏览器」），不区分会话。**结论：没有服务端可校验的会话归属**，归属校验因此落
  「退化档」——id 必须能在 `session-query` 的逻辑会话语料里查到（查不到 `400`，挡掉「凭空造 id 关灯」），
  审计来源写实为 `source:panel`。`sessionQuery` 未装配时如实放行：那是「无从校验」，不是「校验通过」。
  **这一层是同源内的纵深防御，不是闭合的授权边界**——同源页面 A 仍能改会话 B 的开关。不硬造机制
  （让页面自证一个归属头不构成校验）。
- **中 4 · `export → import` 保真**：导出投影补 `facet` / `level`，导入映射搬 `tags` / `facet` / `level`
  （逐个过 `normalize*`，非法值在落盘前响亮拒绝、整批不写）；旧导出文档（缺这三个字段）照常可导入，
  缺省 = 空标签 / 无坐标。
- **中 1 · `facet` 可写是登记在案的设计边界**：详见决策 20。

### 23. 无头执行体与调度（F8）：机械硬杠定「够不够确定」，后台轮只走够确定那一档

- **判定归代码，语义归模型，两者不许互相顶替。** 合并提议仍由当前会话的模型给出（哪几条在讲同一件事），
  但**能不能不经人眼落写**由 `lib/consolidate.mjs` 的 `gradeMerge` 用五根硬杠判定：`same-bucket` /
  `member-count` / `verbatim`（去空白与标点后逐字一致）/ `similarity` / `coverage`，阈值在
  `lib/constants.mjs` 的 `MERGE_GRADE_LINES`，三档 `auto` / `review` / `skip` 在 `MERGE_VERDICTS`。
  **`verbatim` 是 auto 档的独立必要条件**——相似度再高也换不来自动合：`「…自动遵守它」`与
  `「…自动不遵守它」`相似度 0.9（在 auto 线以上），一字之差翻转语义。代价如实说：`auto` 的可达面
  因此很窄（去过空白、标点**与符号**后逐字一致，含「成本 20%」／「成本 +20%」这类符号差异）。
  两档不自动合的下场不同：**改写过的同义句落 `skip`**（相似度 0.1 量级，连 review 线都够不着，
  原地不动），**一字之差落 `review`**（过线但非逐字一致，等人过目）。这是刻意的保守取值。
- **整批账目与条目同事务（一次结构重做）。** 起初的做法是「事务内改条目、事务外补审计、失败再补偿」，
  六轮红队逐轮撬出补偿覆盖不到的失败组合（补偿不还原队列标记、账目说谎、回填打到别的行……）。
  根因不是补偿写得不够多，而是**把「新条目要有新 UUID」误当成「UUID 必须在插入那一刻生成」**：
  产出条目的 id 一旦推迟到插入时才生，引用它的摘要行就只能留在事务外。现在 id 由协议层**提前铸出**
  并一路送进插入口，条目、降级行、产出行、摘要行、队列标记收边在**同一个提交**里落地，补偿机制整段删除
  （`#compensate` / `demoteEntries` 零残留）。
- **后台执行体在插件之外，插件只提供入口与放行口。** 到点唤起由**系统计划任务**（Windows 计划任务）
  负责，执行体是 DSH 自带的 `headless` profile；插件本体不新增定时器、后台进程或后台模型通道
  （静态可核：`setInterval` / `setTimeout` / `child_process` / `ctx.llm` 全零）。插件给的是两样：
  入口 `action=auto-tidy`（**只接受 auto 档**，非 auto 一律结构化拒绝、零落盘）与放行口——写入来源由
  动作自己钉死为 `AUTO_TIDY_SOURCE`（`tidy-auto`），于是粒度写策略 `source:tidy-auto` 可以**只**放行
  这一条路（`auto` / `ask` / `off`，默认由 profile 显式给出；未命中键回落到全局 `writePolicy`，是
  fail-closed 取向）。停用与恢复：改 headless profile 的 `cordis.patch.yml`（该键改 `ask` / `off` 即收口，改回 `auto` 即放行），
  或停掉系统计划任务（`schtasks /change /tn <任务名> /disable`，`/enable` 恢复）——两者都可逆，且都不需要改插件代码。
- **批次是留痕与撤回的单位。** 每轮自动整理铸一个批次号，贯穿产出条目、降级条目与全部审计行
  （`entries.batch_id` / `audit.batch_id`，schema v8）；`batchReport` 仅凭批次号即可只读重建整批
  （源 id 清单、产出条目、来源、会话、起止时间），`/memory restore --batch=<id>` 整批撤回
  （产出降级 ＋ 源恢复，单事务、他批零影响）。
- **仍缺（诚实登记）**：北极星「要求 3」的**待批单子 ＋ 面板过目**没有实现——`review` 档只是「不自动合」，
  没有一批持久化的待批合并项，人工合并仍要在会话内发起 `supersede` 并过一次审批；全库整理的**执行**部分
  与 v1 同（面板按钮只登记 `tidy_requests` 标记）。后台轮被拒时只留一行 `*-denied` 审计（文案记
  **生效**策略，不拿全局策略充数），不会有谁去改判据重试。

### 24. 观察通道的到期提示与无人值守轮（L2 ＋ L3）：提示归提示，自动跑的路同样在插件之外

**L2 到期提示（`observe-due`）。** 与整理机同形：`agent/turn-stopping` 只读算一次「距上次观察多久」，
过 `OBSERVE_DUE_DAYS`（7 天）时落一行 `observe-due` 审计（同进程按 `OBSERVE_NOTICE_INTERVAL` 小时节流），
并在下一次会话的预热段末行追加 `WARMUP_OBSERVE_HINT`；一旦有新的 `observed` 审计行（真跑过扫描），
提示即消失。**同步/异步的边界是这条决策的要点**：预热段提供者必须同步（决策 3），所以那里只报
「天数」——天数可自审计窗口同步读出；「本工作区还有几个可读会话」要问异步的 `sessionQuery`，
只有 turn-stopping 那条异步路径能算，于是它进审计行、**不进**预热段末行。两处的过线条件因此不完全
同形：末行看天数，审计行看「天数 ＋ 本工作区可读会话数 ≥ `OBSERVE_DUE_SESSIONS`」。这条差异是有意的：
宁可少写一行审计，也不在同步路径上假装知道一个当时读不出来的数。

**L3 无人值守观察轮。** 复用决策 23 的执行体与调度：插件本体不新增定时器、后台进程或后台模型通道
（静态可核），系统计划任务唤起一个 `headless` profile 的真实会话，会话里的模型自己 `scan` → 推断 →
`commit`。插件提供两样：入口（`memory_observe`，与交互路径同一个工具）与放行口——写入来源由
`normalizeObservationEntries` 锚死为 `OBSERVATION_SOURCE`（`observation`），于是粒度写策略
`source:observation` 可以只放行这一条路（headless profile 的 `cordis.patch.yml` 给出 `auto`；
改 `ask` / `off` 即收口，与整理轮同一套开关语义）。调度只留插件之外：Windows 计划任务
`\DSH-Memory-Observe`（每周日 04:00，比每天一轮的整理轮稀），执行体在
`%LOCALAPPDATA%\DSH-Memory-Observe\`（`obs-sched.cmd` → `obs-sched.js` → `obs-task.txt`）。
轮次刻意取稀：观察是对同一批语料反复推断，轮次越密越容易产出重复条目，任务文本因此要求先按
`user/user-global` 查一遍已有观察条目再决定写不写。

**闸一决定「一轮只能看一个工作区」。** `sessionScope` 按 cwd 精确相等放行，所以子进程的 cwd 就是被
观察的工作区；反过来，执行体不能照抄整理轮的「cwd 落在 checkout」——那会让一轮只看得见 checkout
自己的历史。三处环境坑（都有实测）：① 子进程 cwd 换到工作区后，tsx 按 cwd 找 tsconfig 的行为会让
`@deepseek-ai/*` 的 `paths` 解析失效（症状是 `profile-boot` 报 `FiberState` 找不到），必须用
`TSX_TSCONFIG_PATH` 指回 checkout 的 solution tsconfig；② `--import` 与入口脚本都要写成绝对路径；
③ `.cmd` 包装照旧 ASCII-only（非 ASCII 的 checkout 路径只许出现在 Node 读的 `.js` 里）。

**闸二之上加一条自产文本的窄排除。** 内核把无头轮的位置参数记成一条 `user/message`
（`source.kind === 'user'`），于是观察轮自己的任务说明会被闸二当成「用户本人的发言」，下一轮就可能
拿它当证据。任务文本因此以 `SCHEDULED_ROUND_MARKER`（`【无人值守轮】`）开头，`extractHumanMessages`
按前缀整条排除并计入账单 `injected`（排除是响亮的，不静默丢）。这是白名单之上的一条窄排除，
不改变「黑名单会漏」这条既有结论；整理轮的任务文本同样打了标记，于是它在观察切片里也不出现。

**仍缺（诚实登记）**：① 会话数那半边不进预热段末行（同步约束，见上）；② 一轮只覆盖一个工作区，
多工作区要铺多条计划任务——本轮按「14 天真人发言量」实测只铺了 `D:\DeepSeek-Harness\日常对话`
一处（126 条，居首），其余工作区要另立任务；③ 观察轮自身的会话会进下一次扫描的候选（cwd 相同），
内容靠任务文本标记排除——会话级开关（F5）只能整会话排除，而观察轮必须开着记忆才能扫描自己。

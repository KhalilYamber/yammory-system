# AGENTS.md

`yammory_system` 是 DeepSeek Harness 的能力接缝插件：为 DSH 补上有界、分层、带审批门、可审计的跨会话记忆。别的记忆插件卖仓库，本插件卖 `ctx.memory` 服务、写入审批门与会话日志可重建的审计。DSH 哲学是 **everything is a plugin**——本仓库只做插件，不碰引擎。改代码前先读 `README.md`（对外契约）、`ARCHITECTURE.md`（设计决策）与 `test/`（现有行为）。

## 仓库布局：发布面 / 本地工程面

根目录只放发布到 GitHub / npm 的文件；本地工程文件一律收进 `dev/`（gitignore，永不提交）。

```
index.mjs            插件入口（唯一 host 面文件）：服务/审批门/工具/快照段/适配器注册表注册
types.d.ts           类型契约：ctx.memory / ctx.memoryAdapters 服务与 memory/* SessionEventMap 声明合并
lib/constants.mjs    词汇表与协议常量（轨道/作用域/错误码/schema 版本/硬上限/条目状态值/标签上限/分面裁决表 ARBITRATION_BY_FACET 与 GAP_TAG，零依赖；表与七面在加载期自检）
lib/errors.mjs       结构化领域错误（code + details，零依赖）
lib/budget.mjs       每轨每层软预警线核算（纯函数，零依赖）
lib/match.mjs        唯一子串匹配（零/多命中语义，零依赖）
lib/gate.mjs         审批门策略与 reason 编解码（零依赖）
lib/protocol.mjs     协议 v1：写语义核心 MemoryProtocolCore（含 F6 `supersede` 与 S5 `restore`/`arbitrate`）+ 条目/信封/审计校验（零 DSH 依赖）
lib/registry.mjs     适配器注册表（register 可逆 / list / adapt / export，零依赖）
lib/adapters.mjs     参考适配器：mem0 / hermes-memory-md / claude-code-memory-md（零依赖）
lib/snapshot.mjs     预热段 + 冻结快照渲染（纯函数，零依赖）
lib/constraint.mjs   表达约束生成：分领域水平 → 四档说话要求（纯函数，零依赖）
lib/workspace.mjs    工作区键规范化（Windows 大小写不敏感，零依赖）
lib/extract.mjs      会话事件文本抽取（memory_recall 历史片段用，零依赖）
lib/observe.mjs      观察通道纯函数核心（闸一授权收窄 / 闸二真人发言白名单 / 均匀采样 / 预算记账 / 观察条目组装，零依赖）
lib/consolidate.mjs  整理机纯函数核心（热度选候选 / `merged` 跳过 / 桶分组与相似线索 / 开工线积压核算，零依赖）
lib/stats.mjs        可观测三数纯函数（重复率 Jaccard / 召回命中率 / 注入量；成功率恒 null 不冒充，零依赖）
lib/strings.mjs      模型可见/命令面双语词表（预热头/约束头/四档说话要求/分组标题/提案头 ＋ `COMMAND_TEXT` 命令面文案包与 `CommandTextBundle` typedef，零依赖）
lib/store.mjs        node:sqlite Provider：条目表+审计账本+迁移（SCHEMA v1→v7，含 `session_switch` 会话开关表、`tidy_requests` 全库整理标记表与 `entries.status` 降级/回滚/打标写入；零依赖）
lib/retrieval.mjs    可插拔检索 Provider seam：keyword 主路径（分词＋多词召回＋相关度排序，F2 层 A）+ substring 对照 + vector 可选后端（零 DSH 依赖）
lib/embedding.mjs    嵌入 Provider seam：确定性伪嵌入（零 DSH 依赖，仅 node: 内置模块）
lib/mcp.mjs          stdio MCP server 导出：只读工具面 memory_search / memory_stats（零 DSH 依赖）
bin/mcp-server.mjs   MCP 可执行入口（零 DSH 依赖）
client/client.js     Web 面板（零构建单模块：React ＋ 官方控件库 `@deepseek-ai/dsh-client-ui-primitives`，抽屉挂官方 `shell.overlay` 浮层；对记忆内容只读；en/zh 随 language 配置；经 dsh.client 注入）+ 会话开关钮（`conversation.session.header.actions`，session scope，官方 Switch；挂会话标题栏、Agent 预设旁）+ 「整理全库」排队按钮（只登记 `tidy_requests` 标记，不调模型、不碰条目）
scripts/             机械门：verify-readmes.mjs（五语一致性）、check-coverage.mjs（覆盖率）、verify-self-contained.mjs（拒绝仓库外依赖）、verify-artifacts.mjs（制品齐全+语法+导入）、loader-runner.mjs（真实 Loader composition）
cordis.patch.yml     bundle 声明（insert yammory_system）
package.json         npm 元数据；files 白名单 = 发布内容（含 docs/ 协议三件套与一致性套件）
package-lock.json    锁文件（CI 用，不进 npm 包）
tsconfig.check.json  tsc --checkJs 类型检查门
.github/workflows/   CI（三平台×双 Node）、每周 next-rc 兼容探针、v* 标签 npm 发布
README.md            英文主介绍（GitHub 默认页；五语源文）
README-{zh,es,pt,hi}.md   中/西/葡/印地语介绍（顶部互链，与英文同 commit 更新）
ARCHITECTURE.md      三角色 seam 架构图与全部设计决策
docs/protocol-v1.md(+.zh)       dsh-memory-protocol v1 规范（双语；docs/schemas/ 为规范性 JSON Schema）
docs/adapters-guide.md(+.zh)    第三方插件接入指南（双语）
docs/upstream-proposal.md(+.zh) 官方 ctx.memory seam 采纳论证与迁移路径（双语）
test/                单测 + mock ctx 集成测试（进 GitHub）
test/client-harness.mjs     客户端半侧测试桩：迷你 React ＋ 假 DOM ＋ 官方控件占位件（测试专用，不进 npm 包）
test/protocol-conformance/  协议一致性套件（可对外分发：进 GitHub 也进 npm 包）
LICENSE / THIRD_PARTY_NOTICES.md   Apache-2.0 + 复用出处标注
dev/                 ❌ 本地工程面：冒烟脚本、夹具、演示——永不提交
```

- 新增被 `index.mjs` import 的模块必须同步加进 `package.json` 的 `files`。
- **行为变更需同步五语 README**：以 README.md（英文）为源，中/西/葡/印地四语同 commit 更新；顶部互链行与 Topics 行保持五语一致。
- **永不提交**：`dev/`、`node_modules/`、真实用户记忆库（含敏感内容）、任何凭据/密钥。

## 命令

```sh
npm install             # 安装 peer 依赖（@deepseek-ai/dsh-tools、schemastery 等）
npm test                # node --test 跑 test/*.test.mjs（含协议一致性套件的仓库门）
npm run coverage        # 展示内置覆盖率报告
npm run lint            # oxlint 静态检查
npm run check:coverage  # 覆盖率门：lib ≥90%、index.mjs ≥85%、all files ≥90%
npm run typecheck       # tsc --checkJs 类型检查门
npm run check:readmes   # 五语 README 一致性门
npm run verify:self-contained # 拒绝 file/link/portal/workspace/git 等仓库外依赖 spec
npm run verify:artifacts # 发布文件齐全 + 语法检查 + 纯 Node import 冒烟
npm run test:conformance  # 协议一致性套件（黄金参考；第三方 Provider 用 run.mjs --provider）
```

无构建步骤：纯 ESM，`index.mjs`/`lib/` 即发布产物。

## 提交纪律

- conventional commit 前缀：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`，中文描述。
- 一个逻辑变更一个 commit；每完成一个 F 需求模块跑 `npm test` 后提交。
- 提交前必过：`npm test` 全绿；`git status` 无杂物；`git diff --cached --check` 无空白错误。
- 行为变更同 commit 更新测试与五语 README。

## DSH 插件约束（红线）

- **只消费公开服务**：`tools`、`systemPrompt`、审批 seam（`inject` 声明）。不修改 DSH 引擎 / agent-loop / apiproxy / 官方 UI 包。
- **注册即 effect**：一切贡献走 `ctx.effect()` / `ctx.on()` / 服务 `register()`（返回 disposer）；绝不手动收尾。
- **模型可见 ⟺ 落盘**：注入模型的快照文本可自会话日志重建（system/message + snapshot 审计行 + 审批 reason 携带完整载荷）。
- **会话级开关不可绕过**：`session_switch` 表的「关」状态在 `MemoryProtocolCore` 写方法内部拦截（与审批门同级、在 gate 与落盘之前），预热段/召回/观察在 `index.mjs` 各自入口拦截；开关状态**绝不进会话日志**（决策 4 的自适应门不变），审计行 `text` 恒为 `null`。
- **审批门不可绕过**：写路径的强制点位于 `MemoryProtocolCore`（`lib/protocol.mjs`）写方法内部（`MemoryService` 继承它并注入 `ctx.approval.request` 传输），不在工具层；`writePolicy` 是 Config，模型不可见、不可改；禁用（`enabled:false`）时一切贡献整体消失，不留半残状态。
- **整理机不越界**（F6）：语义判断（哪几条在讲同一件事）由**当前会话的模型**做，`supersede` 的强制点在同一个 `MemoryProtocolCore` 里——不新增后台模型通道、不新增定时器、不新增后台进程；`agent/turn-stopping` 只读算积压、过线只给提示（`tidy-due` 审计行 ＋ 预热段末行），**绝不自动跑整理**。降级只从 `active → superseded`（留痕、可回滚、绝不物理删），只动会话可见集，桶内不跨；降级审计行 `text` 恒为 `null`（只记 id），每批另落一行 `consolidation` 变更摘要。面板「整理全库」按钮同理只是**排队**（决策 21）：登记一条 `tidy_requests` 标记（过同一套 `writePolicy` 的 turn 外 gate），提示进下次会话预热段末行，跑到清标记由 `supersede` 完成——面板点一下绝不等于记忆被整理过。
- **治理不越界**（S5）：`restore` 只走 `superseded → active`（反向一律响亮失败，它不是「改状态」的通用口子）；`arbitrate` 的**方向由 `ARBITRATION_BY_FACET` 表决定**，工具与命令面都没有反向参数——「能力听观察、意愿听自陈」是代码不变量；coexist 面（其余五面）一条都不降级、两组各打 `gap` 标。两者复用 F6 的审批门、store 面、审计形状与桶内边界，**同样不新增 Config / 依赖 / 定时器 / 后台模型通道**；降级行审计 `text` 恒为 `null`。置信门槛刻意留 v2。
- **失败要大声**：库损坏/版本过新/非法配置在加载期抛错；子串歧义报 `AMBIGUOUS_MATCH`；绝不静默吞、绝不静默截断。（v2：写入不因容量被拒，预算只是软预警线。）
- **本地优先**：零网络、零凭据；记忆库只写 `dbPath`（默认 `$DSH_HOME/dsh-memento/memory.db`），POSIX 权限 0600。
- **systemPrompt 提供者必须同步**（0.1.2-rc.1 不 await）：SQLite 同步读 + WeakMap 按 Session 冻结。

## 会话事件的 alpha.5 约束（必读）

本插件在 `types.d.ts` 声明了 `memory/added|updated|removed|recalled|snapshot` 的 SessionEventMap 合并，但**运行时默认不向会话日志 append 这些事件**：截至 0.1.2-rc.1 harness 仍无插件事件注册面（`KNOWN_SESSION_EVENT_TYPES` 不含 memory/*，且 `Session.append` 写入面不接受 `ignorable` 标记），append 未注册类型会让该会话下次加载被持久化层拒绝。审计链由审批 seam 的 `approval/asked + approval/decided`（已知事件类型）与插件审计表承担；未来 harness 收录 memory/* 后自适应开启。**不要"顺手"取消这个自适应门。**

## 质量约定

- 文件以恰好一个换行结尾；空 `catch` 说明吞掉什么且 `try` 只包一条语句；不注释显而易见的事实。
- `lib/` 保持零 DSH 依赖：任何 DSH 依赖只允许出现在 `index.mjs`；`lib/` 只依赖 node: 内置模块。
- 测试描述行为而非背书正确性；fixtures 用合成数据，永不掺真实用户记忆。
- 复用他人代码处标注 license 与出处（THIRD_PARTY_NOTICES.md + 文件头注释）。

## 编辑本文件

规则保持自包含；改完须与仓库现状一致。

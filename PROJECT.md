# yammory_system

给 DeepSeek Harness 的**用户画像记忆插件**。

## 它要解决什么

AI 不知道用户的知识水位，就按自己的水位说话——术语、跳跃的推理、默认前提。用户看不懂，只能反复追问，对话效率与学习效率一起掉。

本插件让 agent 知道用户的**分领域知识水平与完整画像**，在对话中自动用对方听得懂的话交流。

## 它是什么

一个 DSH（Cordis）记忆插件。核心是「**七面多边形用户画像 + 分领域知识水平 + 表达约束注入 + 双通道采集**」。

- 多边形：躯体 / 心智 / 价值与意愿 / 能力与技能 / 行为与习惯 / 社会与处境 / 经历与轨迹
- 注入：开场限流预热（普遍相关）＋ 按需召回（情境相关），外加一段表达约束
- 采集：问卷（用户主动激发的 skill）＋ 观察（后台离线分析历史对话）
- 治理：soft delete 双向（降级留痕 ＋ `restore` 回滚）；冲突走**分面裁决**（能力听观察 / 意愿听自陈 / 落差两条都留并各打 `gap` 标）

完整设计见 [`施工清单.md`](./施工清单.md)。

## 来源与许可

本项目 **fork 自 [`dsh-memento`](https://github.com/PerryLink/dsh-memento)**（Apache-2.0），保留原始许可与版权声明。

选择它的理由：它是 capability seam 式架构（`ctx.memory` 服务 ＋ provider），正合本项目「独立模块 ＋ 单一接口」的主张；且它遵守 DSH 的硬约束（Model-visible ⟺ logged、审批门不可绕过、CJK 子串检索不走 FTS5 中文坑）。

功能形状的参考对象是 [`dsh-experience-memory`](https://github.com/lzpgood123/dsh-experience-memory)（MIT）——它的「常驻热记忆 ＋ 按需经验库 ＋ 后台子代理 review」与本项目的分路注入和观察同形。

## 目录

| 路径 | 说明 |
|---|---|
| `施工清单.md` | 架构定稿与施工顺序（主文档） |
| `docs/记忆机制v2规格.md` | 记忆机制 v2 施工契约（拆上限＋软预警、分级注入、会话开关、静默整理机） |
| `lib/`, `index.mjs` | 插件源码（源自 dsh-memento；S1 / S2 已改造：七面 schema ＋ 分路注入 ＋ 表达约束；S3 补 facet/level 入参与 `memory_profile` 通道） |
| `skills/` | DSH 原生 skill 源文件（S3：`yammory-survey` 画像问卷 ＋ 题库；安装见 `skills/README.md`） |
| `_candidates/` | 选型时的候选源码（已 gitignore） |
| `_refs/` | 开发参考资料（已 gitignore） |

## 环境

- Node `^22.19.0 || >=24.0.0`（本机 v24.15.0）
- pnpm 11.22.0
- 目标 DSH 版本线：`0.1.x`

## 状态

| 关卡 | 内容 | 状态 |
|---|---|---|
| **S0 · 立基座** | repo、基座 `dsh-memento`、开发知识 | ✅ |
| **S1 · 数据模型** | SCHEMA v5：`facet` / `level` / `status` 三列 ＋ profile 表（8 大类 31 领域） | ✅ |
| **S2 · 分路注入 ＋ 表达约束** | `lib/constraint.mjs` ＋ `renderWarmup`（预热段） | ✅ 测试 207/207 · typecheck 0 错 |
| **S3 · 问卷通道** | `memory` 工具 facet/level 入参 ＋ `memory_profile` 工具（profile 表写入通道）＋ `skills/yammory-survey` 原生 skill | ✅ 测试 214/214 · typecheck 0 错 · lint 0 错 |
| **S4 · 观察通道（探路）** | `docs/观察通道方案.md`：落点＝模型面工具 ＋ skill，v1 显式触发 | ✅ 只读轮 |
| **F1 · 冷启动 dogfood** | 插件挂进 DSH `web` profile；问卷端到端跑通，预热块真机可见 | ✅ 真机首跑 |
| **v2 · 记忆机制规格（D1）** | `docs/记忆机制v2规格.md` | ✅ 落纸（待 F 层施工） |
| **F2 · 检索主梁（层 A）** | `KeywordRetriever` 默认承接 `memory_recall`（分词＋多词召回＋相关度排序）；`docs/F2检索升级方案.md` | ✅ 测试 263/263 |
| **S4b · 观察通道** | `memory_observe` 工具 ＋ `yammory-observe` skill ＋ `/memory observe` ＋ 预热段目录行；`docs/观察通道方案.md` | ✅ 测试 263/263 · 门链 8/8 |
| **R1 · 红队硬化** | 2026-09-13 红队 11 条全部收口：面板路由过大信任栅栏① · `replace` 乐观锁⑦ · NUL、脏标签、迁移幂等、import 越界、gate 白名单、词汇校验、入参、maxChars；`test/redteam.test.mjs` 回归 9 条 | ✅ 测试 272/272 · 门链 8/8 |
| **F3 ＋ F4 · 拆上限 ＋ 分级注入** | 写入永不因容量被拒（`Config.budgets` 语义改「软预警线」，值不变）；`checkBudget` 由「拒」改「报越线」；`renderWarmup` 常驻段加软线收窄；协议一致性套件 C 组同步改口径 | ✅ 测试 273/273 · 一致性 22/22 · 门链 8/8 |
| **R2 · F3/F4 后审视** | 清理拆上限后残留的「有界/硬预算」口径（协议文档 en/zh、JSDoc、errors 注释、package.json、5 语言 README tagline、工具描述）；`consolidate` 补上与 `replace` 同型的乐观锁（`expectedVersions` → `STALE_WRITE`） | ✅ 测试 273/273 · 门链 8/8 |
| **F5 · 会话级记忆开关** | 关掉即「注入停 ＋ 召回禁 ＋ 写入停 ＋ 观察不碰」；schema v6 `session_switch` 表；`/memory session` ＋ composer 开关钮；真机手验中揪出并修复 `memory_observe` schema 缺字段 | ✅ 测试 285/285 · 门链 8/8 |
| **F6 · 整理机（v1 增量版）** | `supersede` 降级不删 ＋ `merged` 打标 ＋ 桶内不跨 ＋ 分批 ＋ 审计摘要；`/memory tidy` ＋ `yammory-tidy` skill；触发只提示不自动跑 | ✅ 测试 318/318 · 门链 8/8 |
| **F7 · 可观测三数** | `/memory stats`：重复率 / 召回命中率 / 注入量；第三数的成功率标注「需反馈通道，待定义」 | ✅ 随 F6 同批 |
| **S5 · 治理** | soft delete 的回滚（`restore`：`superseded → active`，单向、走审批门与审计）＋ **分面裁决**（`arbitrate`：方向由 `ARBITRATION_BY_FACET` 表定——能力听观察 / 意愿听自陈 / 其余五面 coexist 各打 `gap` 标）；`docs/S5治理方案.md` | ✅ 测试 335/335 · 门链 8/8 |
| **收边 · 面板两处 ＋ 门牌** | 抽屉「可观测三数」行（读 `/api/memento/stats` 的 `lines`，措辞与命令面同源）＋「整理全库」排队按钮（新表 `tidy_requests`，schema v7：登记 → 下次会话预热段末行请模型跑 → 跑到由 `supersede` 清标记）；五语 README 的「How it's different」对齐当下生态，npm 宣称改 GitHub 渠道；`docs/收边方案.md` | ✅ 测试 347/347 · 门链 8/8 |
| **R2 · 红队第二轮修复** | 2026-09-14 只读红队（0914-18）6 条收口：`supersede` 合并条目**继承源桶**（高 1，共享记忆不再被 preset 会话收走）· `arbitrate` 保留者**审批后复检**（高 2，不写与库况相反的「kept」审计）· 会话开关路由 `enabled` **严格布尔**（中 2）· 会话 id **存在性校验**（中 3，退化档并如实登记为未闭合）· `export/import` 保住 `tags`/`facet`/`level`（中 4）· `facet` 可写登记为**设计边界**（中 1）；`test/redteam2.test.mjs` 回归 12 条；`docs/红队2修复方案.md` | ✅ 测试 359/359 · 门链 8/8 |

**待办**：

- **F6 v2（全库整理）**：规格 3.5.9 的**面板手动按钮 ＋ 排队登记 ＋ 回执**已随「收边」落地；**剩下的只有「空闲时自动跑」**——它会在会话日志之外发生，撞「模型可见 ⟺ 落盘」，故不做（口径见 ARCHITECTURE 决策 21）。另含双向让路与 S6 Dream 并入。
- **S5 v2（置信门槛）**：多高的把握才允许覆盖，需要真实观察数据攒够才定得出线；S5 先做结构化的共存与裁决（方向表 ＋ 落差标），不引入数值门槛。
- **会话开关的归属校验**：红队② 中 3 已按 DSH 源码核实——`connection.fetch` 的 handler 拿到的东西里没有可校验的会话归属，故只落到「存在性校验 ＋ 审计写实 ＋ 文档登记」的退化档，**同源内的越权面未闭合**（同源页面 A 仍能改会话 B 的开关）。彻底闭合需要 DSH 提供会话级凭据或按请求可校验的归属；本插件不硬造「页面自证」的归属头。详见 `施工清单.md` 已知未闭合项第 10 条与 ARCHITECTURE 决策 22。
- **F7 第三数**：「注入量-成功率」里的成功率没有信号源，需一条用户侧反馈通道，未定。
- ~~UI 补全~~：**已闭合（0914 收边）**——面板抽屉的三数行与「整理全库」按钮都已上线。
- **真机手验**：重启 DSH 装载新码，把 F5 / F6 / F7 / S5 / 收边 / R2 逐项过一遍（host 代码改动需重启才装载）。
- **H1**：拆 `index.mjs`（已 3300+ 行）。
- **分发门牌**：README「How it's different」与 npm 口径已随「收边」对齐；剩下 GitHub 仓库描述与 `dsh-plugin` 等 topics（`gh repo edit`）与「是否真发布 npm」的决定。

**身份**：项目已由 `dsh-memento` 更名为 `yammory_system`；出处与 Apache-2.0 归属保留；仓库指向 <https://github.com/KhalilYamber/yammory-system>；数据面（库目录 / 环境变量 / 路由）为兼容旧数据**保持不变**。

---

*本文件为项目门面，与施工清单一同维护。*

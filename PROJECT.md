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
- 治理：soft delete 留痕；冲突走**分面裁决**（能力听观察 / 意愿听自陈 / 落差两条都留）

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

**待办**：S5 治理（soft delete 行为 ＋ **分面裁决**）· **v2 各机制**（F3/F4/F5/F6/F7，见 `docs/记忆机制v2规格.md`）· S6 Dream（并入整理机）。

**身份**：项目已由 `dsh-memento` 更名为 `yammory_system`；出处与 Apache-2.0 归属保留；仓库指向 <https://github.com/KhalilYamber/yammory-system>；数据面（库目录 / 环境变量 / 路由）为兼容旧数据**保持不变**。

---

*本文件为项目门面，与施工清单一同维护。*

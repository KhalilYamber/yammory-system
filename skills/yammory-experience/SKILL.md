---
name: yammory-experience
description: Records reusable lessons about doing the work into the yammory_system agent track (环境事实 / 约定 / 教训) — 经验, the second memory leg kept apart from the user profile. Use when a real pitfall was hit and the lesson will be reusable, or when the user says 记一条经验 / 记下这个坑 / 以后别再踩 / yammory experience.
whenToUse: 用户说「记一条经验 / 记下这个坑 / 以后别再踩 / yammory experience」，或干活时真踩到坑、教训可复用时使用。不适用于：关于用户本人的观察与自陈（那走 yammory-observe 与 yammory-survey，落 user 轨）。
---

# 经验（yammory-experience）🧰

把「干活的教训」收进 **agent 轨**，与关于用户的记忆分家；下次遇到同类活时按需取。

## 定位：第二个世界

| | 记忆（user 轨） | 经验（agent 轨） |
|---|---|---|
| 关于什么 | 这个人 | 这个世界（环境、工具、这活怎么干） |
| 谁在消费 | 每一轮都在场，塑造默认行为与口气 | 碰到同类活时才召回 |
| 常见来源 | 问卷、观察 | 干活现场掉坑的那一下 |

数据上按轨道分家：`track: 'agent'`。前端抽屉的「经验」页签只显示 agent 轨，记忆页签只显示 user 轨。

## 判据：这条知识该不该每一轮都在场？

这是唯一的分界线，按**用途**判，不按「讲的是谁」判。

- 需要每一轮都在场（塑造默认行为与口气）→ 记忆，**不写这里**。
- 只在某类活出现时才用得上 → 经验，写这里。

三条配套纪律：

1. **先问用途，再问归属。** 关于用户的内容也可能是经验（他的机器没装 node、他要求提交前跑测试）。换言之：「关于用户的」不自动等于「记忆」。
2. **一条事实能生出两条知识。** 两可的不要二选一，拆开各写一条：记忆写「他是什么样」，经验写「该怎么办」。
3. **拆不动就不写。** 既预测不了这个人、又指导不了下次动手的，是废话。

```text
例：同一次事故，两条知识
· 经验：「WSL 里跨文件系统跑 Windows 侧 git，会误报整个仓库被改动；看 diff 与提交一律用 Windows 侧 git。」
· 记忆：「他在跨文件系统工作前会先确认换行与工作目录。」（仅当它能预测他在别的情境里的做法时才写）
```

## 落哪一层

- **跨仓库通用**（工具链坑、Shell 编码、DSH 自身机制）→ `scope: 'user-global'`，所有工作区都看得见。
- **与具体仓库／项目绑定** → `scope: 'workspace'`，按会话 cwd 隔离，别的项目看不见。

判据：换个仓库还成立吗？成立 → user-global；不成立 → workspace。

## 写成什么

一条一个坑，正文三行：

```text
<遇到 X 就做 Y，一句话说清教训>。
症状：<怎么发现的，可复现的现象>
原因：<为什么会这样>
```

标签：**话题标放首位**（面板按它分桶），后面跟分类标。

- 话题标：一个短词，如 `powershell`、`wsl`、`dsh-协议`、`测试`、`git`。
- 分类标：`A-开发相关` 或 `B-非开发`。
- 面板取用规则是「tags 里第一个非保留标」；保留标（`observation`、`merged`、`gap`、`A-开发相关`、`B-非开发`、`YYYY-MM-DD`）不会被当成话题。

写法例子：

```text
在 WSL 侧用 git 看 diff 会误报整个仓库都被改动。
症状：git status 报 100 个文件全改，逐行对比却完全一致。
原因：Windows 侧 core.autocrlf=true，磁盘是 CRLF、索引是 LF；跨文件系统读写把行尾差异当成了改动。
→ memory add，track=agent，scope=user-global，tags=['git', 'wsl', 'A-开发相关']
```

## 什么时候记

- 用户明说：「记一条经验」「记下这个坑」「以后别再踩」「yammory experience」。
- 干活时真踩到坑，且教训可复用：**这是允许的自动路径**。它不读历史、不烧上下文、不动任何已有条目，只写一条新条目，并且照样过审批门——批不批在用户手里。
- 一次至多 3 条，宁少勿多。没踩过坑就不要硬凑。

## 落库路径

```text
memory { action: 'add', track: 'agent', scope: 'user-global', text: '…', tags: ['git', 'A-开发相关'] }
```

写之前先 `memory { action: 'query', text: '<话题词>' }` 看一眼有没有同话题的旧条目，避免重复。被审批拒了就如实说哪条没写进去，**不换措辞重试**。

## 过时了怎么办

不删。补一条更正，把旧的降级留痕：

1. `memory { action: 'add', text: '更正：<新结论>。旧结论：<旧结论>。原因：<为什么变了>' }`
2. `memory { action: 'query', text: '<旧条目里的稳定子串>' }` 拿到旧条目 id。
3. `memory { action: 'supersede', ids: ['<旧 id>'] }` —— 降级不物理删，可 `restore` 回来。

工具换代、约定改了、坑被填了，都走这条路。

## 反面清单

| 不许写 | 为什么 |
|---|---|
| 关于这个人的观察与判断 | 那是 `yammory-observe` 与 `yammory-survey` 的活，落 user 轨 |
| 「这次任务做了什么」的过程流水 | 一次性的，不是可复用的教训 |
| 「要注意细节」「要小心」这类没有症状的泛泛之谈 | 没法复现，也没法验证 |
| 没验证过的猜测 | 教训要能指到一次可复现的现象 |
| 一条里塞三个坑 | 一条一个，否则将来只能整条降级 |

## 与其它三条腿的关系

- `yammory-survey`（问）与 `yammory-observe`（看）采的是**关于用户**的画像 → user 轨。
- `yammory-tidy`（整理）按桶合并条目；agent 轨的桶与 user 轨分开，**跨桶不合并**。
- 本 skill 采的是**关于这个世界**的教训 → agent 轨。四条腿共用同一道审批门、同一套审计。

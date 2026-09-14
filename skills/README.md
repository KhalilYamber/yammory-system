# skills/ · DSH 原生 skill 源文件

本目录放 yammory_system 配套的 DSH skill **源文件**（纳入 git，便于版本管理）。skill 由 DSH 自己的 skill 机制加载，本插件不注册它、也不改 DSH 内核。

```
skills/
  yammory-survey/                 # 采集第一条腿：问
    SKILL.md                      # 入口（frontmatter: name / description / whenToUse）
    references/question-bank.md   # 题库：24 个问卷合法子板块
  yammory-observe/                # 采集第二条腿：看（S4b）
    SKILL.md                      # 入口
    references/observation-facets.md  # 面手册：判据、例句、证据门槛
  yammory-tidy/                   # 维护：整理（F6）
    SKILL.md                      # 入口
    references/merge-rules.md     # 合并判据细表与对照例
```

两条腿的分工：**问卷问「你想要什么」，观察看「你实际怎么做」**。问卷覆盖 24 个非观察子板块；观察覆盖 5 个仅观察面（思维方式与思辨 / 人格特质 / 情绪模式与心理强度 / 自我认知 / 决策与行动风格）。两者都写同一套画像（`memory` 的 `facet` ＋ `tags`，能力面走 `memory_profile`），冲突时分面裁决、并存不删。

第三个 skill 不是采集腿，而是**维护**：`yammory-tidy` 走 F6 整理机——把讲同一件事的条目并成一条带 `merged` 标的条目，旧条目降级为 `superseded`（留痕、不物理删、桶内不跨）。触发同样只由用户发起；预热段末行或 `/memory tidy` 提示「该整理了」时，模型最多**问**一句要不要整理。

## 安装到 DSH 用户级 skill 目录

DSH 的本地 skill 提供方按 rank 扫描若干根目录，其中**用户级 DSH 目录**是 `<dshHome>/skills`（默认 `~/.dsh/skills`，`DSH_HOME` 环境变量可覆盖）。把 skill 目录整个放进该根目录即可——本地提供方接受目录包形式 `<name>/SKILL.md`。

> 注意：**不支持嵌套递归发现**（`**/SKILL.md` 不会被扫到）。目录必须**直接**位于 skills 根下，即 `~/.dsh/skills/yammory-observe/SKILL.md`。

### 方式 A：复制（一次性快照）

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse -Force "D:\GitHub_place\记忆系统\skills\yammory-survey" "$env:USERPROFILE\.dsh\skills\"
Copy-Item -Recurse -Force "D:\GitHub_place\记忆系统\skills\yammory-observe" "$env:USERPROFILE\.dsh\skills\"
Copy-Item -Recurse -Force "D:\GitHub_place\记忆系统\skills\yammory-tidy" "$env:USERPROFILE\.dsh\skills\"
```

```sh
# POSIX
mkdir -p ~/.dsh/skills
cp -R /path/to/yammory-system/skills/yammory-survey ~/.dsh/skills/
cp -R /path/to/yammory-system/skills/yammory-observe ~/.dsh/skills/
cp -R /path/to/yammory-system/skills/yammory-tidy ~/.dsh/skills/
```

优点：干净、与仓库解耦。缺点：仓库更新后要重新复制。

### 方式 B：目录联接（开发时保持同步）

```powershell
# Windows PowerShell（需管理员权限或开发者模式）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\yammory-survey" `
  -Target "D:\GitHub_place\记忆系统\skills\yammory-survey"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\yammory-observe" `
  -Target "D:\GitHub_place\记忆系统\skills\yammory-observe"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\yammory-tidy" `
  -Target "D:\GitHub_place\记忆系统\skills\yammory-tidy"
```

```sh
# POSIX
mkdir -p ~/.dsh/skills
ln -s /path/to/yammory-system/skills/yammory-survey ~/.dsh/skills/yammory-survey
ln -s /path/to/yammory-system/skills/yammory-observe ~/.dsh/skills/yammory-observe
ln -s /path/to/yammory-system/skills/yammory-tidy ~/.dsh/skills/yammory-tidy
```

优点：改仓库即改 skill，无需重装。缺点：删仓库目录会留下悬空链接。

**项目级安装**（不改用户目录）：把同样的联接建在 `<repo>/.dsh/skills/` 下。DSH 会话的 cwd 落在该仓库内时，项目级 skill 根同样被扫描；`.dsh/` 已在 `.gitignore` 里，属本地工程面。

若 `DSH_HOME` 指向别处，把上面路径里的 `~/.dsh` 换成 `$DSH_HOME`。

## 验证 DSH 能发现它

1. **文件就位**：`<dshHome>/skills/<skill-name>/SKILL.md` 存在，且 frontmatter 的 `name` 是 kebab-case、与目录名一致。
2. **机械门**（仓库内，不依赖 DSH 运行）：
   ```sh
   npm run verify:skill
   ```
   逐个校验 `skills/` 下每个 skill 目录：frontmatter 齐备合法、目录名与 `name` 一致、`references/` 引用不漏文件。
3. **DSH 侧**：DSH 会 watch skills 根目录的新增条目；装好后新开（或刷新）会话，模型侧目录 `<available_skills>` 与用户面 skill 列表里应出现 `yammory-survey`、`yammory-observe` 与 `yammory-tidy`。让 agent 调一次 `skill({ name: 'yammory-observe' })` 能取回正文即为发现成功。

## 触发

| skill | 用户口头触发 | 用户面 skill 列表 |
|---|---|---|
| `yammory-survey` | 「做画像问卷」「更新画像」「补一下我的画像」「yammory survey」 | 在 DSH GUI 的 skill 列表里选 `yammory-survey` 加载 |
| `yammory-observe` | 「观察一下我」「看看你对我了解到什么程度」「从最近的聊天里看看我」「yammory observe」 | 同上，选 `yammory-observe` |
| `yammory-tidy` | 「整理一下记忆」「记忆太乱了」「把重复的合并掉」「yammory tidy」（或 `/memory tidy` 之后） | 同上，选 `yammory-tidy` |

三个 skill 的纪律都写死在正文里：**只由用户主动发起**，模型不得自作主张开问卷、发起观察或整理——问卷留下的半张脏画像、观察烧掉的上下文、整理动的一批条目，都比没有更糟。

观察通道的模型面入口是 `memory_observe` 工具（`scan` 只读取历史切片，`commit` 走审批门落库）；命令面是 `/memory observe`（只读打印同一切片，推断仍由模型做）。整理机的模型面入口是 `memory` 工具的 `tidy`（只读取计划）与 `supersede`（合并 ＋ 降级，走审批门）；命令面是 `/memory tidy`（只读计划）。治理面的模型面入口是 `memory` 工具的 `restore`（把降级走回来）与 `arbitrate`（按面裁决冲突，方向由代码里的表定）；命令面是 `/memory restore <id...>` 与 `/memory arbitrate <id...>`；`yammory-tidy` 的 `references/merge-rules.md` 第六节载有裁决表。

## 许可

skill 内容为本项目原创，与仓库同许可（Apache-2.0）。

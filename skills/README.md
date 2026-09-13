# skills/ · DSH 原生 skill 源文件

本目录放 yammory_system 配套的 DSH skill **源文件**（纳入 git，便于版本管理）。skill 由 DSH 自己的 skill 机制加载，本插件不注册它、也不改 DSH 内核。

```
skills/
  yammory-survey/
    SKILL.md                    # 入口（frontmatter: name / description / whenToUse）
    references/question-bank.md # 题库：24 个问卷合法子板块
```

## 安装到 DSH 用户级 skill 目录

DSH 的本地 skill 提供方按 rank 扫描若干根目录，其中**用户级 DSH 目录**是 `<dshHome>/skills`（默认 `~/.dsh/skills`，`DSH_HOME` 环境变量可覆盖）。把 `yammory-survey/` 整个目录放进该根目录即可——本地提供方接受目录包形式 `<name>/SKILL.md`。

> 注意：**不支持嵌套递归发现**（`**/SKILL.md` 不会被扫到）。目录必须**直接**位于 skills 根下，即 `~/.dsh/skills/yammory-survey/SKILL.md`。

### 方式 A：复制（一次性快照）

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse -Force "D:\GitHub_place\记忆系统\skills\yammory-survey" "$env:USERPROFILE\.dsh\skills\"
```

```sh
# POSIX
mkdir -p ~/.dsh/skills
cp -R /path/to/yammory-system/skills/yammory-survey ~/.dsh/skills/
```

优点：干净、与仓库解耦。缺点：仓库更新后要重新复制。

### 方式 B：目录联接（开发时保持同步）

```powershell
# Windows PowerShell（需管理员权限或开发者模式）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\yammory-survey" `
  -Target "D:\GitHub_place\记忆系统\skills\yammory-survey"
```

```sh
# POSIX
mkdir -p ~/.dsh/skills
ln -s /path/to/yammory-system/skills/yammory-survey ~/.dsh/skills/yammory-survey
```

优点：改仓库即改 skill，无需重装。缺点：删仓库目录会留下悬空链接。

若 `DSH_HOME` 指向别处，把上面路径里的 `~/.dsh` 换成 `$DSH_HOME`。

## 验证 DSH 能发现它

1. **文件就位**：`<dshHome>/skills/yammory-survey/SKILL.md` 存在，且 frontmatter 的 `name` 是 kebab-case、与目录名一致。
2. **机械门**（仓库内，不依赖 DSH 运行）：
   ```sh
   npm run verify:skill
   ```
   校验 frontmatter 齐备合法、目录名与 `name` 一致、`references/` 引用不漏文件。
3. **DSH 侧**：DSH 会 watch skills 根目录的新增条目；装好后新开（或刷新）会话，模型侧目录 `<available_skills>` 与用户面 skill 列表里应出现 `yammory-survey`。让 agent 调一次 `skill({ name: 'yammory-survey' })` 能取回正文即为发现成功。

## 触发

| 触发方式 | 例子 |
|---|---|
| 用户口头 | 「做画像问卷」「更新画像」「补一下我的画像」「yammory survey」 |
| 用户面 skill 列表 | 在 DSH GUI 的 skill 列表里选 `yammory-survey` 加载 |

skill 的纪律写死在正文里：**只由用户主动发起**，模型不得自作主张开问卷。

## 许可

skill 内容为本项目原创，与仓库同许可（Apache-2.0）。

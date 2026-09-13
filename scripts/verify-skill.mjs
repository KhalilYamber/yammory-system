// scripts/verify-skill.mjs — skill 源文件门：断言 skills/ 下的每个 skill 目录
// 有一份 frontmatter 合法的 SKILL.md（name 为 kebab-case 且与目录名一致、
// description 与 whenToUse 齐备、description 不超 DSH 目录上限），且正文里
// 相对引用的 references/ 文件真实存在。纯 Node 内置模块，零依赖。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const skillsDir = path.join(root, 'skills')

/** DSH 会话目录的 description 上限（dsh-tool-skill 的 catalogDescriptionMaxLength 默认值）。 */
const DESCRIPTION_MAX = 500
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 解析 SKILL.md 的 YAML frontmatter 首部（只认 `key: value` 单行标量；复杂 YAML 不在支持面）。
 * @param {string} text - SKILL.md 全文。
 * @returns {{fields: Record<string, string>, body: string} | null} 解析结果；无 frontmatter 返回 null。
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end < 0) return null
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '') continue
    const separator = line.indexOf(':')
    if (separator < 0) return null
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    fields[key] = raw.replace(/^["']|["']$/g, '')
  }
  return { fields, body: text.slice(end + 4) }
}

if (!existsSync(skillsDir)) {
  console.error('verify-skill: skills/ directory is missing')
  process.exit(1)
}

const skillDirs = readdirSync(skillsDir).filter((entry) => statSync(path.join(skillsDir, entry)).isDirectory())
if (skillDirs.length === 0) {
  console.error('verify-skill: skills/ contains no skill directory')
  process.exit(1)
}

/** @type {string[]} */
const failures = []
for (const dir of skillDirs) {
  const skillFile = path.join(skillsDir, dir, 'SKILL.md')
  /** @param {string} message */
  const fail = (message) => failures.push(`${dir}: ${message}`)
  if (!existsSync(skillFile)) {
    fail('missing SKILL.md (nested discovery is not supported; the directory must sit directly under skills/)')
    continue
  }
  const parsed = parseFrontmatter(readFileSync(skillFile, 'utf8'))
  if (parsed === null) {
    fail('SKILL.md has no parseable YAML frontmatter')
    continue
  }
  const { fields, body } = parsed
  for (const key of ['name', 'description', 'whenToUse']) {
    if (typeof fields[key] !== 'string' || fields[key].length === 0) fail(`frontmatter field "${key}" is missing`)
  }
  if (typeof fields.name === 'string' && fields.name !== dir) fail(`frontmatter name "${fields.name}" does not match directory "${dir}"`)
  if (typeof fields.name === 'string' && !SKILL_NAME_PATTERN.test(fields.name)) fail(`name "${fields.name}" is not kebab-case`)
  if (typeof fields.description === 'string' && fields.description.length > DESCRIPTION_MAX) {
    fail(`description is ${fields.description.length} chars; the DSH catalog cap is ${DESCRIPTION_MAX}`)
  }
  if (body.trim().length === 0) fail('SKILL.md body is empty')
  // 相对引用必须真实存在（skill 加载后按 resourceBase 解析，漏文件即坏的指引）
  for (const match of body.matchAll(/\]\(\.\/([^)]+)\)/g)) {
    if (!existsSync(path.join(skillsDir, dir, match[1]))) fail(`referenced resource ./${match[1]} does not exist`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  process.exit(1)
}
console.log(`skills OK: ${skillDirs.length} skill(s) with valid frontmatter — ${skillDirs.join(', ')}`)

// 精确找"值"：只在 <root> 下找 gh*_ / github_pat_ 这类令牌字面量（不打印完整值）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOTS = [path.join(os.homedir(), '.dsh'), 'D:/dafeiyu']
const SKIP = new Set([
  'sessions', 'sessions.trash', 'memories', 'attachments', 'cache', 'node_modules', '.git',
  'dsh-runtimes', 'runtime', 'logs', 'dsh-ops', '.pnpm-store', 'tmp', 'backups',
])
const PATTERN = /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,})\b/g

const hits = []
let scanned = 0

function scan(file) {
  let text
  try {
    const stat = fs.statSync(file)
    if (stat.size > 4 * 1024 * 1024) return
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  scanned += 1
  if (!/ghp_|github_pat_|gho_|ghs_/.test(text)) return
  text.split('\n').forEach((line, index) => {
    PATTERN.lastIndex = 0
    const match = PATTERN.exec(line)
    if (match === null) return
    const value = match[1]
    hits.push(`${file}:${index + 1}  ${value.slice(0, 4)}…${value.slice(-2)}(len=${value.length})`)
  })
}

function walk(dir, depth) {
  if (depth > 5) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      walk(full, depth + 1)
      continue
    }
    if (!/\.(js|mjs|cjs|json|yml|yaml|md|txt|env|ps1|cmd|bat)$/.test(entry.name)) continue
    scan(full)
  }
}

for (const root of ROOTS) if (fs.existsSync(root)) walk(root, 0)

console.log(`扫了 ${scanned} 个文件，命中 ${hits.length} 处令牌字面量：`)
for (const hit of hits.slice(0, 30)) console.log('  ' + hit)
if (hits.length === 0) console.log('  （没有）')

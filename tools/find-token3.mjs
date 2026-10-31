// 在 ~/.dsh 的配置类文件里找 GitHub 令牌线索（只报 文件:行 + 掩码；跳过会话正文）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
const DSH = path.join(HOME, '.dsh')
const SKIP_DIRS = new Set(['sessions', 'sessions.trash', 'memories', 'attachments', 'cache', 'node_modules', '.git', 'logs'])

function mask(line) {
  return line
    .replace(/(ghp_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1***')
    .replace(/(github_pat_[A-Za-z0-9]{4})[A-Za-z0-9_]+/g, '$1***')
    .trim()
    .slice(0, 170)
}

const hits = []
function walk(dir, depth) {
  if (depth > 4) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, depth + 1)
      continue
    }
    if (!/\.(js|mjs|cjs|json|yml|yaml|md|txt|env)$/.test(entry.name)) continue
    let text
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (!/github/i.test(text)) continue
    text.split('\n').forEach((line, index) => {
      if (!/github/i.test(line)) return
      hits.push(`${path.relative(DSH, full)}:${index + 1}: ${mask(line)}`)
    })
  }
}
walk(DSH, 0)

console.log(`命中 ${hits.length} 行：`)
for (const hit of hits.slice(0, 60)) console.log('  ' + hit)

// 凭据文件的键名（不打印值）
const cred = path.join(DSH, '.credentials.yaml')
if (fs.existsSync(cred)) {
  console.log('\n.credentials.yaml 里出现的键名（只列 key）：')
  for (const line of fs.readFileSync(cred, 'utf8').split('\n')) {
    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (match) console.log('  ' + match[1])
  }
}

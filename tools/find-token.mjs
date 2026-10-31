// 在 @local 插件里找 GitHub 令牌的"位置"（不打印令牌本身，只报 文件:行 + 掩码）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@local')
const KEYS = [/github/i, /ghp_[A-Za-z0-9]/, /github_pat_/, /token/i, /^gh/i]

function mask(value) {
  const text = String(value)
  if (text.length <= 8) return '*'.repeat(text.length)
  return text.slice(0, 4) + '…' + text.slice(-2) + `(len=${text.length})`
}

function scanFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (!/github|ghp_|github_pat_/i.test(line)) return
    if (line.length > 400) return
    const masked = line.replace(/(ghp_[A-Za-z0-9]{6})[A-Za-z0-9]+/g, '$1***').replace(/(github_pat_[A-Za-z0-9]{6})[A-Za-z0-9_]+/g, '$1***')
    console.log(`${path.relative(ROOT, file)}:${index + 1}: ${masked.trim().slice(0, 160)}`)
  })
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(full)
      continue
    }
    if (!/\.(js|mjs|cjs|json|yml|yaml|md|txt)$/.test(entry.name)) continue
    scanFile(full)
  }
}

console.log('扫描:', ROOT)
walk(ROOT)

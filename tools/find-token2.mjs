// 在"规矩/说明/凭据位置"这类文件里找 GitHub 令牌线索（不打印令牌本身）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TARGETS = [
  path.join(os.homedir(), '.dsh', 'prompt-inject.md'),
  path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  'D:/dafeiyu/shared/沈知渝上手包.md',
  'D:/dafeiyu/shared/沈知渝协作规矩.md',
]

function maskLine(line) {
  return line
    .replace(/(ghp_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1***')
    .replace(/(github_pat_[A-Za-z0-9]{4})[A-Za-z0-9_]+/g, '$1***')
    .replace(/((?:token|密码|口令|pat)[^\n]{0,12}[:=：]\s*)([^\s，。；]{6,})/gi, '$1***')
    .trim()
    .slice(0, 180)
}

for (const file of TARGETS) {
  if (!fs.existsSync(file)) {
    console.log(`-- 不存在: ${file}`)
    continue
  }
  console.log(`\n== ${file} ==`)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (!/github|ghp_|github_pat_|代{0,2}理|proxy/i.test(line)) return
    console.log(`  ${index + 1}: ${maskLine(line)}`)
  })
}

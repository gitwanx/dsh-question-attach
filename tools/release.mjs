#!/usr/bin/env node
/**
 * 一条命令发布：取凭据 → 临时改 private → 跑 publish.mjs → 改回 public（并写描述）。
 *
 * 为什么绕这一圈：细粒度 PAT 在仓库 public 时调 blobs/contents 会 403
 * （Resource not accessible by personal access token），private 下才写得进去。
 *
 * 凭据来源（按顺序）：GITHUB_TOKEN 环境变量 → 仓库根 .token → `git credential fill`（系统凭据库）。
 * 不会把令牌写进任何文件，也不回显。
 *
 * 用法：node tools/release.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const API = 'https://api.github.com'
const OWNER = process.env.GITHUB_OWNER || 'gitwanx'
const REPO = process.env.GITHUB_REPO || 'dsh-question-attach'
const DESCRIPTION =
  '随答附图（dsh-question-attach）· DSH 宿主问答卡的附图/文件插件：只在提问时出现，选项选完按继续时把图片与文件跟在回答后面发给同一个 Agent；不改 app.asar。'

function tokenFromCredentialStore() {
  try {
    const stdout = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 15000,
    })
    for (const line of stdout.split('\n')) {
      if (line.startsWith('password=')) return line.slice('password='.length).trim()
    }
  } catch (error) {
    return undefined
  }
  return undefined
}

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const file = path.join(ROOT, '.token')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  return tokenFromCredentialStore()
}

async function api(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'qattach-release',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 200)}`)
  return text === '' ? undefined : JSON.parse(text)
}

const token = readToken()
if (!token) {
  console.error('× 没有令牌：设 GITHUB_TOKEN，或把 token 放进 .token（已 gitignore）')
  process.exit(1)
}
console.log(`令牌已就绪（长度 ${token.length}，不回显）　目标：${OWNER}/${REPO}`)

await api(token, 'PATCH', `/repos/${OWNER}/${REPO}`, { private: true })
console.log('→ 临时改回 private（细粒度 PAT 只在 private 下能写）')

const output = execFileSync(process.execPath, [path.join(HERE, 'publish.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, GITHUB_PRIVATE: '1', GITHUB_TOKEN: token },
})
const tail = output.split('\n').filter((line) => line.startsWith('✓') || line.includes('接到已有提交'))
console.log(tail.join('\n'))

const info = await api(token, 'PATCH', `/repos/${OWNER}/${REPO}`, { private: false, description: DESCRIPTION })
console.log('→ 已改回 public')
console.log('→ 描述：', info.description)

const anon = await fetch(`${API}/repos/${OWNER}/${REPO}`, { headers: { 'user-agent': 'anon' } })
const anonJson = await anon.json()
console.log(`→ 匿名核验：private=${anonJson.private}　${anonJson.html_url}`)

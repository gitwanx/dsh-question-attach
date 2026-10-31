#!/usr/bin/env node
/**
 * 把本仓库发布到 GitHub（public）——走 REST API，不需要 git 协议。
 *
 * 为什么不用 git push：本机到 github.com:443 连不通（超时），
 * 但 api.github.com 通。所以用 Git Data API 建一棵树、提交一次、推一个 main 分支。
 *
 * 用法：
 *   1. 在 GitHub 上建一个 token（fine-grained，勾 repo 的 Contents + Administration，
 *      或者 classic 的 repo 权限），写进仓库根目录的 .token（已被 .gitignore 忽略），
 *      或设环境变量 GITHUB_TOKEN。
 *   2. node tools/publish.mjs            # 真发
 *      node tools/publish.mjs --dry-run  # 只列要发哪些文件
 *
 * 环境变量：
 *   GITHUB_TOKEN / 文件 .token   令牌
 *   GITHUB_OWNER                 默认取令牌自己（GET /user）
 *   GITHUB_REPO                  默认 dsh-question-attach
 *   GITHUB_PRIVATE=1             建私有仓库（默认 public）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const API = 'https://api.github.com'

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'backup'])
const SKIP_FILES = new Set(['.token', 'package-lock.json'])
const SKIP_EXT = ['.log', '.tmp']

const DESCRIPTION = 'DSH 宿主问答卡「附图/文件」插件：只在提问时出现，选项选完按继续时把图片与文件跟在回答后面发给同一个 Agent；不改 app.asar。'
const COMMIT_MESSAGE =
  'feat: DSH 问答卡「附图/文件」插件 v0.3.0\n\n' +
  '只在问答卡出现时挂一条栏；选项选完按继续时，图片内联、其它文件先上传，\n' +
  '随后随回答发给同一个 Agent。不改 app.asar，卸载可逐字节还原。'

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const file = path.join(ROOT, '.token')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  return undefined
}

function collect(dir, out = [], base = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(path.join(dir, entry.name), out, rel)
      continue
    }
    if (SKIP_FILES.has(entry.name)) continue
    if (SKIP_EXT.some((ext) => entry.name.endsWith(ext))) continue
    if (/^sample.*\.(png|txt)$/.test(entry.name)) continue // 自检用的样本，跑测试时现生成
    out.push(rel)
  }
  return out
}

async function api(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-question-attach-publisher',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch (error) {
    parsed = { raw: text }
  }
  if (!response.ok) {
    const message = parsed && parsed.message ? parsed.message : text.slice(0, 200)
    throw new Error(`${method} ${route} -> ${response.status} ${message}`)
  }
  return parsed
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const files = collect(ROOT).sort()
  console.log(`要发布的文件（${files.length}）：`)
  for (const file of files) {
    const bytes = fs.statSync(path.join(ROOT, file)).size
    console.log(`  ${String(bytes).padStart(7)}  ${file}`)
  }
  if (dryRun) {
    console.log('\n--dry-run：没有发任何东西。')
    return 0
  }

  const token = readToken()
  if (token === undefined) {
    console.error('\n× 没有令牌：设 GITHUB_TOKEN，或把 token 写进本目录的 .token（已 gitignore）。')
    return 1
  }

  const me = await api(token, 'GET', '/user')
  const owner = process.env.GITHUB_OWNER || me.login
  const repo = process.env.GITHUB_REPO || 'dsh-question-attach'
  const isPrivate = process.env.GITHUB_PRIVATE === '1'
  console.log(`\n账号：${owner}　仓库：${owner}/${repo}　${isPrivate ? '私有' : '公开'}`)

  // 1) 仓库已存在就复用，不存在就建
  let repoInfo
  let exists = true
  try {
    repoInfo = await api(token, 'GET', `/repos/${owner}/${repo}`)
    console.log('  仓库已存在，复用')
  } catch (error) {
    exists = false
  }
  if (!exists) {
    repoInfo = await api(token, 'POST', '/user/repos', {
      name: repo,
      description: DESCRIPTION,
      private: isPrivate,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    })
    console.log('  已创建空仓库')
  } else if (repoInfo.private === true && !isPrivate) {
    // 你要的是开源：顺手把私有改成公开（需要 token 有 Administration 权限）
    await api(token, 'PATCH', `/repos/${owner}/${repo}`, { private: false, description: DESCRIPTION })
    console.log('  已把仓库改成公开')
  }

  // 已有 main 就接在它后面提交，不覆盖历史
  let parentSha
  try {
    const ref = await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/main`)
    parentSha = ref.object.sha
    console.log(`  接到已有提交后面：${parentSha.slice(0, 7)}`)
  } catch (error) {
    parentSha = undefined
  }

  // 2) 每个文件一个 blob
  const blobs = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(ROOT, file)).toString('base64')
    const blob = await api(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'base64' })
    blobs.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
    process.stdout.write(`  blob ${file}\n`)
  }

  // 3) 一棵树 + 一次提交 + 推 main
  const tree = await api(token, 'POST', `/repos/${owner}/${repo}/git/trees`, { tree: blobs })
  const commit = await api(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message: COMMIT_MESSAGE,
    tree: tree.sha,
    parents: parentSha === undefined ? [] : [parentSha],
  })
  let branchExists = true
  try {
    await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/main`)
  } catch (error) {
    branchExists = false
  }
  if (branchExists) {
    await api(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha, force: true })
  } else {
    await api(token, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
  }

  console.log(`\n✓ 发布完成：https://github.com/${owner}/${repo}`)
  console.log(`  提交：${commit.sha}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\n× 失败：${error.message}`)
    process.exit(1)
  },
)

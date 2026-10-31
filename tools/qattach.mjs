#!/usr/bin/env node
/**
 * DSH 问答卡「附图/文件」插件 · 安装 / 卸载 / 看状态
 *
 *   node tools/qattach.mjs install    装到 desktop profile（建链接 + 在 cordis.patch.yml 插一行）
 *   node tools/qattach.mjs restore    还原（删链接 + 只摘自己那一行，其它配置一律不碰）
 *   node tools/qattach.mjs status     只看当前状态
 *
 * 只动两处：
 *   1. <DSH_HOME>/profiles/desktop/node_modules/@local/dsh-question-attach（目录联接）
 *   2. <DSH_HOME>/profiles/desktop/cordis.patch.yml（一行 insert）
 *
 * 不碰 app.asar、不碰会话数据。
 * 还原是外科手术：只摘自己那一块，用户后来加的配置保持原样。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.dirname(HERE) // 仓库根目录 = 插件包目录
const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, '.dsh')
const PROFILE = path.join(DSH_HOME, 'profiles', 'desktop')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const LINK = path.join(PROFILE, 'node_modules', '@local', 'dsh-question-attach')
const BACKUP = path.join(HERE, 'backup')

const ID = 'question-attach'
const NAME = '@local/dsh-question-attach'
// 有意用纯 ASCII：profile 的 patch 文件常被各种编辑器打开，UTF-8 中文注释在 GBK 编辑器里
// 会变成乱码。这一行仍然写着插件名，还原时靠它定位。
const COMMENT_LINE = '# question-attach (@local/dsh-question-attach) - added by the question-attach installer'
const INSERT_BLOCK = `- insert:\n    - id: ${ID}\n      name: '${NAME}'\n`

const say = (line = '') => console.log(line)

function readPatch() {
  return fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : ''
}

function writePatch(text) {
  const tmp = `${PATCH}.qattach.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, PATCH)
}

/** 摘掉所有指向本插件的 insert 条目，其它内容逐字节保留。 */
function stripOurInsert(text) {
  const lines = text.split('\n')
  const kept = []
  let removed = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*#/.test(line) && line.includes('question-attach')) {
      removed += 1
      continue
    }
    if (/^\s*-\s*insert:\s*$/.test(line)) {
      const block = [line]
      let cursor = index + 1
      while (cursor < lines.length && /^\s{4,}\S/.test(lines[cursor])) {
        block.push(lines[cursor])
        cursor += 1
      }
      const joined = block.join('\n')
      if (joined.includes(`id: ${ID}`) || joined.includes(NAME)) {
        removed += 1
        index = cursor - 1
        continue
      }
      kept.push(...block)
      index = cursor - 1
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

function hasOurs(text) {
  return text.split('\n').some((line) => line.trim() === `- id: ${ID}` || line.includes(NAME))
}

function linkTarget() {
  try {
    return fs.readlinkSync(LINK, { encoding: 'utf8' })
  } catch (error) {
    return undefined
  }
}

function doInstall() {
  say('== 安装：DSH 问答卡「附图/文件」插件 ==')
  if (!fs.existsSync(path.join(SOURCE, 'client.js'))) {
    say(`× 这里不像插件包目录：${SOURCE}`)
    return 1
  }
  if (!fs.existsSync(PROFILE)) {
    say(`× 找不到 desktop profile：${PROFILE}`)
    say('  先跑一次 DSH 桌面版（或者用 DSH_HOME 指定 DSH 主目录）再试。')
    return 1
  }
  say(`  插件源码：${SOURCE}`)

  fs.mkdirSync(path.dirname(LINK), { recursive: true })
  if (fs.existsSync(LINK)) {
    say('  链接已存在，跳过（要重建就先跑 restore）')
  } else {
    execFileSync('cmd', ['/c', 'mklink', '/J', LINK, SOURCE], { stdio: 'ignore' })
    say(`  建链接：${LINK} -> ${SOURCE}`)
  }

  const text = readPatch()
  if (hasOurs(text)) {
    say('  cordis.patch.yml 里已经有这一行，跳过')
  } else {
    fs.mkdirSync(BACKUP, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const snapshot = path.join(BACKUP, `cordis.patch.yml.bak_${stamp}`)
    fs.writeFileSync(snapshot, text, 'utf8')
    say(`  备份原配置：${snapshot}`)
    const joiner = text === '' || text.endsWith('\n') ? '' : '\n'
    writePatch(`${text}${joiner}${COMMENT_LINE}\n${INSERT_BLOCK}`)
    say('  已写入 cordis.patch.yml 的一行 insert')
  }

  say('')
  say('装好了。回 DSH 按一下刷新按钮（或重启应用），问答卡里就会出现「＋ 附图/文件」。')
  return 0
}

function doRestore() {
  say('== 还原：DSH 问答卡「附图/文件」插件 ==')
  let changed = 0

  const { text: cleaned, removed } = stripOurInsert(readPatch())
  if (removed > 0) {
    writePatch(cleaned)
    changed += 1
    say(`  已从 cordis.patch.yml 摘掉 ${removed} 处`)
  } else {
    say('  cordis.patch.yml 里没有这一行，跳过')
  }

  if (fs.existsSync(LINK)) {
    execFileSync('cmd', ['/c', 'rmdir', LINK], { stdio: 'ignore' })
    changed += 1
    say(`  已删掉链接：${LINK}`)
  } else {
    say('  链接本来就不存在，跳过')
  }

  const log = path.join(DSH_HOME, 'question-attach.log')
  if (fs.existsSync(log)) {
    try {
      fs.renameSync(log, `${log}.restored`)
      say(`  诊断日志改名：${path.basename(log)}.restored`)
    } catch (error) {
      /* 日志可有可无 */
    }
  }

  say('')
  say(changed === 0 ? '本来就是干净的，没动任何东西。' : '还原完成。回 DSH 按一下刷新按钮（或重启），卡片就回到原样。')
  return 0
}

function doStatus() {
  const text = readPatch()
  const target = linkTarget()
  say('== 状态 ==')
  say(`  插件源码：${SOURCE}`)
  say(`  profile：${PROFILE}`)
  say(`  链接：${fs.existsSync(LINK) ? `存在${target ? ` -> ${target}` : ''}` : '不存在'}`)
  say(`  patch 行：${hasOurs(text) ? '在' : '不在'}`)
  say(`  最近日志：${path.join(DSH_HOME, 'question-attach.log')}`)
  return 0
}

const mode = process.argv[2] ?? 'status'
const selfPath = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(selfPath)
if (invokedDirectly) {
  const code = mode === 'install' || mode === 'apply' ? doInstall() : mode === 'restore' ? doRestore() : doStatus()
  process.exit(code)
}

export { stripOurInsert, hasOurs, INSERT_BLOCK, COMMENT_LINE, ID, NAME }

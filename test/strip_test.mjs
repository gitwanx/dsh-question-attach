// 还原器自检：只摘自己那一块 insert，其它内容逐字节不动。
// 自带样本，不读用户机器上的任何配置 —— 仓库拷到哪都能跑。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { stripOurInsert, hasOurs, INSERT_BLOCK, COMMENT_LINE } = await import(
  'file://' + path.join(HERE, '..', 'tools', 'qattach.mjs').replace(/\\/g, '/')
)

const failures = []
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? `  [${extra}]` : ''))
  if (!ok) failures.push(name)
}

// 一份"别人的配置"：有普通条目、有别人的 insert、有注释、有缩进不一的写法
const pristine = [
  '# 我的 profile patch 层',
  '- id: ui-theme',
  '  config:',
  '    fontSize: 21',
  '- insert:',
  '    - id: my-own-plugin',
  "      name: '@local/my-own-plugin'",
  '',
  '- id: agent-preset-registry',
  '  config:',
  '    default: standard',
  '',
].join('\n')

const installed =
  pristine + COMMENT_LINE + '\n' + INSERT_BLOCK + "\n- insert:\n    - id: later-block\n      name: '@local/later'\n"

check('未安装时识别不到自己', hasOurs(pristine) === false)
check('安装后能识别到自己', hasOurs(installed) === true)

const back = stripOurInsert(installed)
check('只摘自己那一块', !back.text.includes('question-attach'))
check('别人的 insert 留着', back.text.includes("id: my-own-plugin") && back.text.includes("id: later-block"))
check('剩下的内容逐字节等于原来的（除自己那块）', back.text === pristine + "\n- insert:\n    - id: later-block\n      name: '@local/later'\n",
  JSON.stringify(back.text.slice(-60)))
check('记录到了移除条目', back.removed >= 1, String(back.removed))
check('重复摘是无操作', stripOurInsert(back.text).text === back.text)

// 装 → 摘，必须与装之前逐字节相同（本次只装自己一块的场景）
const onlyOurs = pristine + COMMENT_LINE + '\n' + INSERT_BLOCK
check('装一次再摘一次＝装之前', stripOurInsert(onlyOurs).text === pristine)
check('空文件也安全', stripOurInsert('').text === '')

console.log()
if (failures.length > 0) {
  console.log('FAILED:', failures.length, failures)
  process.exit(1)
}
console.log('ALL PASS（strip 逻辑）')

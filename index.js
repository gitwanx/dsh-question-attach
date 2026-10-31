/**
 * dsh-question-attach · host half
 *
 * 只做两件事，不碰任何业务数据：
 *   1. 挂载时往 ~/.dsh/question-attach.log 记一行（证明 host 半边起来了）；
 *   2. 注册 /__qattach/ping —— 浏览器半边用它上报「插件已加载 / 图已发出 / 发送失败」，
 *      同样只写那一个日志文件。这条路由不带认证，只写日志、不回显任何数据。
 *
 * 卡片本体在 app.asar 里，本插件不改它；撤销就是把这个包和 cordis.patch.yml
 * 里的一行 insert 去掉（桌面还原脚本干这件事）。
 *
 * @module @local/dsh-question-attach
 */
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-question-attach'

const LOG_FILE = join(homedir(), '.dsh', 'question-attach.log')
const PING_PATH = '/__qattach/ping'

function append(line) {
  const text = String(line).replace(/[\r\n]+/g, ' ').slice(0, 400)
  appendFile(LOG_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8').catch(() => {})
}

export function apply(ctx) {
  const log = ctx?.logger ?? console
  append('host:mount')

  const mountHttp = (scoped) => {
    if (!scoped?.webServer || typeof scoped.webServer.register !== 'function') {
      log.warn?.('[question-attach] webServer 不可用：浏览器半边仍可加载，但没有诊断日志')
      return null
    }
    return scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: PING_PATH,
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const event = url.searchParams.get('ev') ?? 'unknown'
            const detail = url.searchParams.get('d') ?? ''
            append(`client:${event}${detail ? ` ${detail}` : ''}`)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end('{"ok":true}')
          },
        }),
      'question-attach: ping route',
    )
  }

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountHttp)
  else mountHttp(ctx)
}

export default { name, apply }

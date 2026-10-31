/**
 * dsh-question-attach · client half (v0.2)
 *
 * 宿主问答卡「附图/文件」增强（A+B 一卡）：
 *   卡片里多一条栏 —— 选项照常选，选完按「继续/提交」时，图与文件跟在回答后面发同一个 Agent。
 *
 * 三条硬约束（按星海 2026-11-01 的要求）：
 *   1. 只在有问答卡时激活；没卡片时完全不留痕（插件在后台待着，不画任何东西）。
 *   2. 栏挂在卡片 section 里、footer 之前 —— 不压在选项上，选项怎么滚都不重叠。
 *   3. 发附件前先提醒模型「后面还有附件，先等一下」：上传没完就先发一条提醒，上传完再发附件。
 *
 * 不碰 app.asar。卡片 DOM 契约：frame[data-question-key] / body[data-question-scroll] / footer。
 *
 * @module @local/dsh-question-attach/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-question-attach',
  factory(require) {
    const FRAME_SEL = '[data-question-key]'
    const BODY_SEL = '[data-question-scroll]'
    const FOOTER_SEL = 'footer'
    const MARK = 'data-qattach'
    const MAX_ITEMS = 6
    const MAX_EDGE = 1600
    const MAX_IMAGE_BYTES = 12 * 1024 * 1024
    const MAX_FILE_BYTES = 30 * 1024 * 1024
    const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    const CSS_ID = '@local/dsh-question-attach/qattach.css'

    const zh = {
      add: '＋ 附图/文件',
      addTitle: '图片随回答内联发送，其它文件先上传再随回答发送',
      hint: '选完选项按「继续/提交」，这些会跟在回答后面发出去（也能直接 Ctrl+V 粘贴截图）',
      pending: '上传中 {n} 个…',
      full: '最多 6 个',
      remove: '移除',
      preview: '点开看大图',
      tooBig: '文件太大',
      imgTooBig: '图片超过 12MB',
      badImage: '这张图浏览器读不出来',
      noUploader: '当前界面没有文件上传服务，只能附图',
      busy: '正在发送附件…',
      ok: '已随回答发出',
      fail: '没发出去：',
      noSession: '拿不到当前会话，附件发不出去',
    }
    const en = {
      add: '+ Attach',
      addTitle: 'Images go inline with your answer; other files upload first',
      hint: 'Pick options, hit Continue — these follow the answer (Ctrl+V to paste a screenshot)',
      pending: 'Uploading {n}…',
      full: 'At most 6',
      remove: 'Remove',
      preview: 'Open full size',
      tooBig: 'File is too large',
      imgTooBig: 'Image is larger than 12MB',
      badImage: 'This image cannot be read in the browser',
      noUploader: 'No file-upload service here; images only',
      busy: 'Sending attachments…',
      ok: 'Sent with the answer',
      fail: 'Not sent: ',
      noSession: 'No active session to send these to',
    }
    const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || ''
    const copy = /^zh/i.test(lang) || lang === '' ? zh : en

    const states = new Map()
    let observer = null
    let scheduled = null

    /* ------------------------------ utils ------------------------------ */

    function cssEscape(value) {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
      return String(value).replace(/["\\]/g, '\\$&')
    }

    function isElement(node) {
      return node !== null && typeof node === 'object' && node.nodeType === 1
    }

    function revoke(item) {
      if (item !== null && item !== undefined && item.previewUrl) {
        try {
          URL.revokeObjectURL(item.previewUrl)
        } catch (error) {
          /* preview is best-effort */
        }
        item.previewUrl = ''
      }
    }

    function readAsDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsDataURL(blob)
      })
    }

    function loadImage(blob) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob)
        const image = new Image()
        image.onload = () => {
          URL.revokeObjectURL(url)
          resolve(image)
        }
        image.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('decode failed'))
        }
        image.src = url
      })
    }

    function toBlob(canvas, mediaType) {
      return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mediaType, 0.92))
    }

    /** Images: pass supported rasters through, downscale big ones, convert anything else to PNG. */
    async function normalizeImage(file) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(copy.imgTooBig)
      const declared = typeof file.type === 'string' ? file.type : ''
      if (declared === 'image/gif') return { blob: file, mediaType: 'image/gif' }
      let image
      try {
        image = await loadImage(file)
      } catch (error) {
        throw new Error(copy.badImage)
      }
      const longEdge = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height)
      const needScale = longEdge > MAX_EDGE
      const needConvert = !SUPPORTED.has(declared)
      if (!needScale && !needConvert) return { blob: file, mediaType: declared || 'image/png' }
      const mediaType = needConvert ? 'image/png' : declared === 'image/jpeg' ? 'image/jpeg' : declared
      const ratio = needScale ? MAX_EDGE / longEdge : 1
      const width = Math.max(1, Math.round((image.naturalWidth || image.width) * ratio))
      const height = Math.max(1, Math.round((image.naturalHeight || image.height) * ratio))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) return { blob: file, mediaType: declared }
      context.drawImage(image, 0, 0, width, height)
      const blob = await toBlob(canvas, mediaType)
      if (blob === null) return { blob: file, mediaType: declared }
      return { blob, mediaType }
    }

    function looksLikeImage(file) {
      const type = typeof file.type === 'string' ? file.type : ''
      if (/^image\//.test(type)) return true
      return /\.(png|jpe?g|webp|gif)$/i.test(file.name || '')
    }

    async function imagePart(item) {
      if (item.part !== undefined) return item.part
      const dataUrl = await readAsDataUrl(item.blob)
      const comma = dataUrl.indexOf(',')
      const part = { type: 'image', mediaType: item.mediaType, data: comma === -1 ? '' : dataUrl.slice(comma + 1) }
      if (item.name) part.name = item.name
      item.part = part
      return part
    }

    function ping(event, detail) {
      try {
        const query = new URLSearchParams({ ev: String(event) })
        if (detail !== undefined) query.set('d', String(detail).slice(0, 300))
        void fetch(`/__qattach/ping?${query.toString()}`, { cache: 'no-store' }).catch(() => {})
      } catch (error) {
        /* diagnostics only */
      }
    }

    /* ------------------------------ styles ------------------------------ */

    function mountStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-question-attach'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = `
.qaRail{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0 0;margin-top:8px;
  border-top:1px dashed var(--dsw-alias-border-l2);flex:none;min-width:0}
.qaAdd{cursor:pointer;font:inherit;font-size:12px;line-height:20px;padding:3px 12px;border-radius:999px;flex:none;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}
.qaAdd:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.qaAdd[disabled]{opacity:.45;cursor:default}
.qaChips{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}
.qaChip{position:relative;height:40px;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2,transparent);flex:none}
.qaChipImg{width:40px;cursor:zoom-in}
.qaChipImg img{width:100%;height:100%;object-fit:cover;display:block}
.qaPreview{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);display:flex;align-items:center;
  justify-content:center;padding:24px;cursor:zoom-out}
.qaPreview img{max-width:88vw;max-height:88vh;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);background:#111}
.qaChipFile{display:flex;align-items:center;gap:6px;padding:0 22px 0 8px;max-width:190px}
.qaChipName{font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary);max-width:140px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qaChipPct{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none}
.qaChipErr .qaChipName,.qaChipErr .qaChipPct{color:var(--dsw-alias-state-error-primary,#d93026)}
.qaX{position:absolute;top:2px;right:2px;width:16px;height:16px;line-height:14px;text-align:center;border:none;
  border-radius:999px;cursor:pointer;font-size:12px;padding:0;background:rgba(0,0,0,.55);color:#fff}
.qaHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.qaHintErr{color:var(--dsw-alias-state-error-primary,#d93026)}
.qaHintOk{color:var(--dsw-alias-state-success-primary,#2ea043)}
`
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ------------------------------ rail ------------------------------ */

    function stateFor(key) {
      let state = states.get(key)
      if (state === undefined) {
        state = { key, items: [], armed: false, busy: false, rail: null, hint: null, chips: null, add: null }
        states.set(key, state)
      }
      return state
    }

    function setHint(state, text, kind) {
      if (state.hint === null) return
      state.hint.textContent = text
      state.hint.className = 'qaHint' + (kind === 'error' ? ' qaHintErr' : kind === 'ok' ? ' qaHintOk' : '')
    }

    function baseHint(state) {
      const uploading = state.items.filter((item) => item.status === 'uploading').length
      if (uploading > 0) return copy.pending.replace('{n}', String(uploading))
      if (state.items.length === 0) return copy.hint
      return copy.hint
    }

    /** 点缩略图看大图；点任意处或 Esc 关掉。 */
    function openPreview(item) {
      if (!item.previewUrl) return
      if (document.querySelector('[data-qapreview]') !== null) return
      const overlay = document.createElement('div')
      overlay.className = 'qaPreview'
      overlay.setAttribute('data-qapreview', '1')
      const image = document.createElement('img')
      image.src = item.previewUrl
      image.alt = item.name || 'image'
      overlay.appendChild(image)
      const close = () => {
        overlay.remove()
        document.removeEventListener('keydown', onKey, true)
      }
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }
      overlay.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        close()
      })
      document.addEventListener('keydown', onKey, true)
      document.body.appendChild(overlay)
      ping('preview', 'open')
    }

    function renderRail(state) {
      if (state.chips === null) return
      state.chips.textContent = ''
      for (const item of state.items) {
        const chip = document.createElement('div')
        chip.className =
          item.kind === 'image' ? 'qaChip qaChipImg' : 'qaChip qaChipFile' + (item.status === 'error' ? ' qaChipErr' : '')
        if (item.kind === 'image') {
          const image = document.createElement('img')
          image.alt = item.name || 'image'
          image.src = item.previewUrl
          chip.appendChild(image)
          chip.title = copy.preview
          chip.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            openPreview(item)
          })
        } else {
          const name = document.createElement('span')
          name.className = 'qaChipName'
          name.textContent = item.name || 'file'
          chip.appendChild(name)
          if (item.status === 'uploading') {
            const pct = document.createElement('span')
            pct.className = 'qaChipPct'
            pct.textContent = `${item.progress || 0}%`
            chip.appendChild(pct)
          } else if (item.status === 'error') {
            const bad = document.createElement('span')
            bad.className = 'qaChipPct'
            bad.textContent = '×'
            chip.appendChild(bad)
          }
        }
        const kill = document.createElement('button')
        kill.type = 'button'
        kill.className = 'qaX'
        kill.title = copy.remove
        kill.setAttribute('aria-label', copy.remove)
        kill.textContent = '×'
        kill.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          removeItem(state, item)
        })
        chip.appendChild(kill)
        state.chips.appendChild(chip)
      }
      state.chips.hidden = state.items.length === 0
      if (state.add !== null) state.add.disabled = state.items.length >= MAX_ITEMS
    }

    function removeItem(state, item) {      const at = state.items.indexOf(item)
      if (at !== -1) state.items.splice(at, 1)
      try {
        if (item.controller) item.controller.abort()
      } catch (error) {
        /* abort is best-effort */
      }
      revoke(item)
      renderRail(state)
      if (!state.busy) setHint(state, baseHint(state), '')
    }

    function sessionIdOfKey(key) {
      const match = /^question:([^:]+):(.+)$/.exec(String(key || ''))
      if (match === null) return undefined
      const candidate = match[1]
      if (candidate === '' || candidate === 'unnamed') return undefined
      return candidate
    }

    function currentSessionId(ctx) {
      try {
        const uiSession = ctx.get('uiSession')
        const source = uiSession && uiSession.current
        const snapshot = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined
        return snapshot && typeof snapshot.key === 'string' ? snapshot.key : undefined
      } catch (error) {
        return undefined
      }
    }

    /**
     * 卡片 key 里的那一段不一定是 Session 身份（实测线上是裸 uuid，binding 取不到），
     * 所以按候选顺序试：key 里那段 → 当前视图的 Session → 列表里唯一在跑的 Session。
     */
    function resolveSession(ctx, key) {
      let sessions
      try {
        sessions = ctx.get('sessions')
      } catch (error) {
        sessions = undefined
      }
      if (sessions === undefined || typeof sessions.binding !== 'function') return { session: undefined, candidates: [] }
      const candidates = []
      const fromKey = sessionIdOfKey(key)
      if (fromKey !== undefined) candidates.push(fromKey)
      const current = currentSessionId(ctx)
      if (current !== undefined && current !== fromKey) candidates.push(current)
      const tried = []
      for (const id of candidates) {
        tried.push(id)
        let binding
        try {
          binding = sessions.binding(id)
        } catch (error) {
          binding = undefined
        }
        if (binding && binding.session) return { session: binding.session, candidates: tried, sessionId: id }
      }
      // 兜底：列表里唯一"在跑"的那个会话就是刚提问的那个。
      try {
        const list = sessions.list
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        const byId = snapshot && snapshot.byId ? snapshot.byId : {}
        const running = Object.keys(byId).filter((id) => byId[id] && byId[id].running === true)
        if (running.length === 1) {
          const binding = sessions.binding(running[0])
          if (binding && binding.session) return { session: binding.session, candidates: tried, sessionId: running[0] }
          tried.push(running[0])
        }
      } catch (error) {
        /* list shape is a fallback only */
      }
      return { session: undefined, candidates: tried }
    }

    /** Non-image files: stage them right away so the answer only has to carry a receipt. */
    function startUpload(ctx, state, item) {
      const fileUpload = ctx.get('fileUpload')
      const resolved = resolveSession(ctx, state.key)
      const sessionId = resolved.sessionId
      if (fileUpload === undefined || typeof fileUpload.upload !== 'function') {
        item.status = 'error'
        item.error = copy.noUploader
        renderRail(state)
        return Promise.resolve()
      }
      if (sessionId === undefined) {
        item.status = 'error'
        item.error = copy.noSession
        renderRail(state)
        return Promise.resolve()
      }
      item.status = 'uploading'
      item.progress = 0
      item.controller = new AbortController()
      item.promise = (async () => {
        try {
          const result = await fileUpload.upload(
            sessionId,
            item.blob,
            item.name || undefined,
            item.controller.signal,
            (progress) => {
              const total = progress && typeof progress.total === 'number' ? progress.total : 0
              const loaded = progress && typeof progress.loaded === 'number' ? progress.loaded : 0
              item.progress = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0
              renderRail(state)
            },
          )
          if (result && result.ok === true) {
            item.receiptId = result.value.receiptId
            item.status = 'ready'
            item.progress = 100
          } else {
            item.status = 'error'
            item.error = result && result.error && result.error.code ? String(result.error.code) : 'upload-failed'
          }
        } catch (error) {
          item.status = 'error'
          item.error = error && error.message ? error.message : 'upload-failed'
        }
        renderRail(state)
      })()
      return item.promise
    }

    async function addFiles(ctx, state, files) {
      const list = Array.from(files || [])
      for (const file of list) {
        if (state.items.length >= MAX_ITEMS) {
          setHint(state, copy.full, 'error')
          break
        }
        const isImage = looksLikeImage(file)
        if (isImage) {
          try {
            const normalized = await normalizeImage(file)
            state.items.push({
              kind: 'image',
              name: file.name || '',
              blob: normalized.blob,
              mediaType: normalized.mediaType,
              previewUrl: URL.createObjectURL(normalized.blob),
              status: 'ready',
            })
            setHint(state, baseHint(state), '')
          } catch (error) {
            setHint(state, error && error.message ? error.message : copy.badImage, 'error')
          }
          continue
        }
        if (file.size > MAX_FILE_BYTES) {
          setHint(state, `${copy.tooBig}：${file.name || ''}`, 'error')
          continue
        }
        const item = { kind: 'file', name: file.name || 'file', blob: file, status: 'pending' }
        state.items.push(item)
        setHint(state, baseHint(state), '')
        renderRail(state)
        void startUpload(ctx, state, item)
      }
      renderRail(state)
      if (state.items.length > 0 && !state.busy) setHint(state, baseHint(state), '')
      if (state.items.length > 0) ping('attach', `${state.items.length} item(s)`)
    }

    function buildRail(ctx, state) {
      const rail = document.createElement('div')
      rail.setAttribute(MARK, '1')
      rail.className = 'qaRail'

      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'qaAdd'
      add.textContent = copy.add
      add.title = copy.addTitle

      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.style.display = 'none'
      input.addEventListener('change', () => {
        void addFiles(ctx, state, input.files)
        input.value = ''
      })

      add.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        input.click()
      })

      const chips = document.createElement('div')
      chips.className = 'qaChips'
      chips.hidden = true

      const hint = document.createElement('span')
      hint.className = 'qaHint'
      hint.textContent = copy.hint

      rail.appendChild(add)
      rail.appendChild(input)
      rail.appendChild(chips)
      rail.appendChild(hint)

      state.add = add
      state.chips = chips
      state.hint = hint
      renderRail(state)
      return rail
    }

    /* ------------------------------ sending ------------------------------ */

    function attachmentText(images, files) {
      const pieces = []
      if (images > 0) pieces.push(`${images} 张图`)
      if (files > 0) pieces.push(`${files} 个文件`)
      const what = pieces.join('、')
      return `（附件 ${what}，是上一条回答的补充材料；先看完这些再继续。）`
    }

    async function sendAttachments(ctx, key, state) {
      if (state.busy || state.items.length === 0) return
      const resolved = resolveSession(ctx, key)
      const session = resolved.session
      if (session === undefined) {
        setHint(state, copy.noSession, 'error')
        ping('no-session', (resolved.candidates || []).join(',') || 'none')
        return
      }
      ping('target', resolved.sessionId || 'unknown')

      state.busy = true
      const waiting = state.items.filter((item) => item.kind === 'file' && item.status === 'uploading')
      try {
        // 先打个招呼：模型别急着往下干，附件马上到。
        if (waiting.length > 0) {
          setHint(state, copy.pending.replace('{n}', String(waiting.length)), '')
          await session.prompt([{ type: 'text', text: `（先别动手：还有 ${waiting.length} 个附件正在上传，收到后再继续。）` }], 'steer')
          await Promise.all(waiting.map((item) => item.promise))
        }

        const usable = state.items.filter((item) => (item.kind === 'image' ? true : item.status === 'ready' && item.receiptId))
        if (usable.length === 0) {
          setHint(state, `${copy.fail}附件都没准备好`, 'error')
          state.busy = false
          return
        }

        setHint(state, copy.busy, '')
        const parts = []
        let images = 0
        let files = 0
        for (const item of usable) {
          if (item.kind === 'image') {
            parts.push(await imagePart(item))
            images += 1
          } else {
            parts.push({ type: 'file', receiptId: item.receiptId })
            files += 1
          }
        }
        parts.push({ type: 'text', text: attachmentText(images, files) })

        let result = await session.prompt(parts, 'steer')
        if (result && result.ok !== true) {
          const code = result.error && result.error.code ? String(result.error.code) : ''
          if (/steer/.test(code)) result = await session.prompt(parts, 'queue')
        }
        state.busy = false
        if (result && result.ok === true) {
          setHint(state, copy.ok, 'ok')
          ping('sent', `${images}i/${files}f`)
          for (const item of state.items) revoke(item)
          state.items = []
          renderRail(state)
          return
        }
        const code = result && result.error && result.error.code ? String(result.error.code) : 'send-failed'
        setHint(state, `${copy.fail}${code}`, 'error')
        ping('send-failed', code)
      } catch (error) {
        state.busy = false
        const message = error && error.message ? error.message : 'send-failed'
        setHint(state, `${copy.fail}${message}`, 'error')
        ping('send-failed', message)
      }
    }

    /* ------------------------------ wiring ------------------------------ */

    function placeRail(frame, rail) {
      const footer = frame.querySelector(FOOTER_SEL)
      const section = frame.querySelector('section') || frame
      if (footer !== null && footer.parentNode === section) section.insertBefore(rail, footer)
      else section.appendChild(rail)
    }

    function augment(ctx) {
      if (typeof document === 'undefined') return
      for (const frame of document.querySelectorAll(FRAME_SEL)) {
        const key = frame.getAttribute('data-question-key') || ''
        if (key === '') continue
        const existing = frame.querySelector(`[${MARK}]`)
        const body = frame.querySelector(BODY_SEL)
        // 卡片被收起（body 不在）时不留任何东西；这也顺带保证"只在提问时出现"。
        if (body === null) {
          if (existing !== null) existing.remove()
          continue
        }
        const state = stateFor(key)
        if (existing !== null) {
          state.rail = existing
          continue
        }
        const rail = buildRail(ctx, state)
        placeRail(frame, rail)
        state.rail = rail
        ping('augment', key)
      }
    }

    function sweep(ctx) {
      if (typeof document === 'undefined') return
      for (const [key, state] of [...states.entries()]) {
        const alive = document.querySelector(`[data-question-key="${cssEscape(key)}"]`)
        if (alive !== null) continue
        states.delete(key)
        if (state.armed && state.items.length > 0) {
          void sendAttachments(ctx, key, state).finally(() => {
            for (const item of state.items) revoke(item)
            state.items = []
          })
          continue
        }
        for (const item of state.items) {
          try {
            if (item.controller) item.controller.abort()
          } catch (error) {
            /* abort is best-effort */
          }
          revoke(item)
        }
        state.items = []
      }
    }

    function schedule(ctx) {
      if (scheduled !== null) return
      scheduled = setTimeout(() => {
        scheduled = null
        try {
          augment(ctx)
        } catch (error) {
          /* a detached tree is not an error */
        }
        try {
          sweep(ctx)
        } catch (error) {
          /* same */
        }
      }, 180)
    }

    function armFromEvent(event) {
      const target = event.target
      if (!isElement(target)) return
      const frame = target.closest(FRAME_SEL)
      if (frame === null) return
      const key = frame.getAttribute('data-question-key') || ''
      const state = states.get(key)
      if (state === undefined) return
      if (event.type === 'keydown' && event.key !== 'Enter') return
      if (event.type === 'pointerdown' || event.type === 'mousedown') {
        // 关卡片（header 上的 ×）不算作答；点「＋ 附图/文件」也不算作答，别把附件顺手发出去。
        if (target.closest('header') !== null) return
        if (target.closest('[data-qattach]') !== null) return
      }
      state.armed = true
    }

    /** Which card a paste belongs to: the focused one, the event target's, else the only card up. */
    function frameForPaste(event) {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (isElement(active)) {
        const inside = active.closest(FRAME_SEL)
        if (inside !== null) return inside
      }
      const target = event.target
      if (isElement(target)) {
        const inside = target.closest(FRAME_SEL)
        if (inside !== null) return inside
      }
      const frames = document.querySelectorAll(FRAME_SEL)
      return frames.length === 1 ? frames[0] : null
    }

    /** Files off the clipboard; images arrive with an empty name, which is fine. */
    function clipboardFiles(data) {
      const files = []
      if (data === null || data === undefined) return files
      if (data.files !== null && data.files !== undefined && data.files.length > 0) {
        for (const file of data.files) files.push(file)
      }
      if (files.length === 0 && data.items !== undefined && data.items !== null) {
        for (const item of data.items) {
          if (item.kind !== 'file') continue
          const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
          if (file !== null && file !== undefined) files.push(file)
        }
      }
      return files
    }

    /** Ctrl+V inside the card attaches a screenshot instead of typing nothing. */
    function makePasteHandler(ctx) {
      return (event) => {
        const files = clipboardFiles(event.clipboardData)
        if (files.length === 0) return
        const frame = frameForPaste(event)
        if (frame === null) return
        const key = frame.getAttribute('data-question-key') || ''
        const state = states.get(key)
        if (state === undefined) return
        event.preventDefault()
        event.stopPropagation()
        void addFiles(ctx, state, files)
        ping('paste', files.length)
      }
    }

    return {
      inject: ['sessions', 'uiSession'],
      apply(ctx) {
        ctx.effect(mountStyles, 'question-attach: stylesheet')
        ctx.effect(() => {
          const pasteHandler = makePasteHandler(ctx)
          const start = () => {
            augment(ctx)
            observer = new MutationObserver(() => schedule(ctx))
            observer.observe(document.body, { childList: true, subtree: true })
            document.addEventListener('pointerdown', armFromEvent, true)
            document.addEventListener('keydown', armFromEvent, true)
            document.addEventListener('paste', pasteHandler, true)
            ping('mount', 'v4')
          }
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
          else start()
          return () => {
            if (observer !== null) {
              observer.disconnect()
              observer = null
            }
            if (scheduled !== null) {
              clearTimeout(scheduled)
              scheduled = null
            }
            document.removeEventListener('pointerdown', armFromEvent, true)
            document.removeEventListener('keydown', armFromEvent, true)
            document.removeEventListener('paste', pasteHandler, true)
            for (const state of states.values()) {
              for (const item of state.items) {
                try {
                  if (item.controller) item.controller.abort()
                } catch (error) {
                  /* abort is best-effort */
                }
                revoke(item)
              }
            }
            states.clear()
          }
        }, 'question-attach: card rail')
      },
    }
  },
})

# 随答附图 · dsh-question-attach

> 给 DeepSeek Harness 的**宿主问答卡**加一条「附图 / 文件」栏：选项照常选，按「继续」时，
> 图与文件**跟在回答后面**发给同一个 Agent。不改 `app.asar`，一个脚本装、一个脚本还原。

中文名 **随答附图**（包名 `@local/dsh-question-attach`，仓库 `dsh-question-attach`）。

适用于 DSH 桌面版 / Web 版（`0.2.x`）。纯浏览器插件 + 一个只写日志的宿主路由，无外部依赖。

```
＋ 附图/文件   [缩略图 ×]  [文件名 42% ×]   选完选项按「继续/提交」，这些会跟在回答后面发出去
[ 跳过 ]  [ 继续 ]
```

## 为什么需要它

DSH 自己会问用户问题（`ask_user_question`）：卡片会**接管聊天输入框**，让你在选项里选、或自己写答案。
问题出在：**这张卡片没有任何附件通道**。

卡片插件的 `inject` 只有 `sessions / remote / uiSession / slots / locale / uiConversation`，
聊天输入框那套附件能力在另一个插件内部，也没有对外暴露服务。想回答时顺手贴张图，是没有入口的。

两条路：

| 路 | 代价 |
|---|---|
| 改 `app.asar` 里的卡片本体 | 182MB 整包重打包 + 停服 + 重装风险，DSH 一升级就没了 |
| **在卡片 DOM 上留一条自己的栏，附件走公开的会话通道** | 本仓库 |

选了第二条。细节和取舍写在 [docs/设计说明.md](docs/设计说明.md)。

## 它做什么

| 行为 | 说明 |
|---|---|
| 只在提问时出现 | 只有问答卡存在时才挂栏；卡片收起立刻消失；平时插件在后台待着，界面上一丝痕迹都没有 |
| 不压选项 | 栏插在卡片里、按钮行**上方**，不在选项滚动区里，选项怎么滚都不重叠 |
| 选完按「继续」才发 | 卡片收起（作答已提交）且你动过卡片主体时才发；点右上角 `×` 关掉不发 |
| 记得提醒模型 | 附件还在上传 → 先发一条「先别动手：还有 N 个附件正在上传，收到后再继续」，传完再发附件；都已就绪 → 一条消息带齐 |
| Ctrl+V 粘贴截图 | 焦点在卡片里直接粘，剪贴板里的图进栏（只拦带文件的粘贴，粘文字不受影响） |
| 点缩略图看大图 | 全屏预览，点任意处或 `Esc` 关掉 |
| 图片内联、文件上传 | 图片走 `{type:'image', mediaType, data}`；其它文件先进 `fileUpload` 拿到 `receiptId`，再随 prompt 发 |

上限：一次最多 6 个；图片 ≤12MB（长边 >1600px 先缩，gif 原样），其它文件 ≤30MB。

## 安装

需要：Node.js 18+，DSH 至少跑过一次（`~/.dsh/profiles/desktop` 存在）。

1. 把这个仓库放到任意目录（别放临时目录）。
2. 双击 **`安装.cmd`**（等价于 `node tools/qattach.mjs install`）。
3. 回 DSH 按一下**刷新按钮**（或重启应用）。

装的时候只做两件事：

- 建一个目录联接：`~/.dsh/profiles/desktop/node_modules/@local/dsh-question-attach` → 本仓库目录
- 在 `~/.dsh/profiles/desktop/cordis.patch.yml` **追加**一行：

```yaml
# question-attach (@local/dsh-question-attach) - added by the question-attach installer
- insert:
    - id: question-attach
      name: '@local/dsh-question-attach'
```

> 追加前会把原文件备份到 `tools/backup/cordis.patch.yml.bak_<时间>`。
> 还原 → 重新安装之间**隔 5 秒以上**再点：同一秒连点两次，DSH 的配置监听会把两次改动
> 合并成一次读，插件不会重新挂上。

## 卸载

双击 **`卸载.cmd`**（等价于 `node tools/qattach.mjs restore`），然后刷新页面。

还原是外科手术：只摘掉自己那一块 insert（连同上面那行注释），**你自己后来加的任何配置原样留着**。
不碰 `app.asar`、不碰会话记录。

`看状态.cmd` 只看：链接在不在、patch 行在不在、源码在哪。

## 自检

```bash
python test/run_test.py     # 26 项：栏位/不重叠、图片、文件上传、先等一下提醒、
                            # 上传完成只发一条、粘贴、预览、关掉不发、收起不留痕、会话回落
node test/strip_test.mjs    # 还原器：只摘自己那块，其它字节不动（自带样本，不读本机配置）
```

`test/run_test.py` 用真实 Chromium（headless）打开 `test/card.html`——里面的卡片 DOM 结构照抄
DSH 的 `dsh-client-ui-user-questions` 契约，用假 ctx 记录 `session.prompt` 的入参。**不需要连真机。**

## 诊断

插件两边都只写一个文件：`~/.dsh/question-attach.log`

| 事件 | 含义 |
|---|---|
| `host:mount` / `client:mount v4` | 插件前后两半都加载了 |
| `client:augment question:…:N` | **认到卡片、栏挂上去了**（这才算功能生效，`mount` 只是加载） |
| `client:paste 1` / `client:attach 1 item(s)` | 粘进来 / 挂上去 |
| `client:preview open` | 点了缩略图 |
| `client:target session-…` | 定位到哪个会话（修复后才有） |
| `client:sent 1i/0f` | 真的发出去了：1 张图 / 0 个文件 |
| `client:no-session …` | 没定位到会话（附件没发出去，栏上也会显示错误） |

## 兼容性

依赖卡片的三条 DOM 契约：`frame[data-question-key]`、`div[data-question-scroll]`、`footer`。
DSH 升级如果改了它们，表现是**栏不出现**（不会损坏任何东西），按日志里有没有
`client:augment` 就能判断。

另外两个线上踩过的坑（已修，见 `docs/设计说明.md`）：

- 卡片 key 里那段 id **不是**能拿去 `sessions.binding()` 的会话身份 → 必须回落到 `uiSession.current`。
- 卡片的标题/选项是**纯文本**渲染，只有 `detail` 走 Markdown —— 模型写问题时别用 `**加粗**`。

## 更新记录

**0.3.1 —— 文案跟着「语言」走，不再看 `<html lang>`**

插件 bundle 往往比 locales 服务先执行，那一刻 `<html lang>` 还是模板里的 `en`，界面其实是中文，
于是栏上出现了「+ Attach / Pick options, hit Continue…」。现在以 `locale` 服务的
`getSnapshot().active` 为准，并 `subscribe` 变化：中途换语言，已经挂着的栏就地换文案。

**0.3.0** —— Ctrl+V 粘贴截图、缩略图全屏预览、会话回落（修 `client:no-session`）。

## 声明

- 本仓库不包含 DeepSeek Harness 的任何代码或资源，只调用它的公开客户端服务
  （`sessions` / `uiSession` / `fileUpload` / `locale` / `remote`）和插件装载协议。
- 安装脚本会改**你本机**的 `~/.dsh/profiles/desktop/cordis.patch.yml`，改前自动备份，`卸载.cmd` 可逐字节还原。
- 与 DeepSeek 官方无关，按 MIT 发布。

## 许可

MIT，见 [LICENSE](LICENSE)。

v0.3.1 · 2026-11-01

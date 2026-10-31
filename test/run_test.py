"""question-attach v2 离线自检：真 Chromium 跑真卡片 DOM。

覆盖：栏的位置（footer 之前、不在滚动区里 → 不压选项）、图片内联、文件先上传、
「先等一下」提醒、上传没完时先发提醒再发附件、关卡片不发、收起卡片不留痕。

不碰线上应用：headless 浏览器打开本地 test/card.html，用假 ctx 记录 session.prompt 入参。
跑法：python test/run_test.py
"""
from __future__ import annotations

import pathlib
import struct
import zlib

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
CARD = HERE / "card.html"
PNG = HERE / "sample.png"
BIG_PNG = HERE / "sample_big.png"
TXT = HERE / "sample.txt"


def make_png(path: pathlib.Path, width: int = 40, height: int = 30) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    raw = b""
    for _y in range(height):
        raw += b"\x00"
        for x in range(width):
            raw += bytes((200, 40 + (x * 5) % 200, 60, 255))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> int:
    make_png(PNG)
    make_png(BIG_PNG, 400, 300)
    TXT.write_text("hello from the question card\n", encoding="utf-8")
    failures: list[str] = []

    def check(name: str, condition: bool, extra: str = "") -> None:
        print(("PASS  " if condition else "FAIL  ") + name + (f"  [{extra}]" if extra else ""))
        if not condition:
            failures.append(name)

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(headless=True)
        except Exception:
            browser = pw.chromium.launch(headless=True, channel="msedge")
        page = browser.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))

        # ---- 1. 位置：在 footer 之前，且不在滚动区里（不和选项重叠） ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        placement = page.evaluate(
            """() => {
              const rail = document.querySelector('[data-qattach]');
              const body = document.querySelector('[data-question-scroll]');
              const footer = document.querySelector('[data-question-key] footer');
              return {
                parentIsSection: rail.parentElement.tagName.toLowerCase() === 'section',
                beforeFooter: rail.nextElementSibling === footer,
                insideScrollBody: body.contains(rail),
                railBox: rail.getBoundingClientRect().toJSON(),
                bodyBox: body.getBoundingClientRect().toJSON(),
              };
            }"""
        )
        check("栏挂在卡片 section 里", placement["parentIsSection"])
        check("栏在 footer 之前", placement["beforeFooter"])
        check("栏不在滚动区里（不压选项）", placement["insideScrollBody"] is False)
        check("栏在选项下方（不重叠）", placement["railBox"]["top"] >= placement["bodyBox"]["bottom"] - 1,
              f"rail.top={placement['railBox']['top']:.0f} body.bottom={placement['bodyBox']['bottom']:.0f}")
        check("无 JS 异常", not errors, "; ".join(errors))
        check("mount ping 到了", any("ev=mount" in u for u in page.evaluate("window.__ping")))

        # ---- 2. 图片：内联 base64 ----
        page.set_input_files("[data-qattach] input[type=file]", str(PNG))
        page.wait_for_selector(".qaChipImg img", timeout=5000)
        check("图片出 chip", page.locator(".qaChipImg").count() == 1)

        # ---- 3. 文件：先上传，chip 显示进度 ----
        page.set_input_files("[data-qattach] input[type=file]", str(TXT))
        page.wait_for_selector(".qaChipFile", timeout=5000)
        check("文件出 chip", page.locator(".qaChipFile").count() == 1)
        check("文件走了 fileUpload", page.evaluate("window.__uploadCalls.length") == 1,
              str(page.evaluate("window.__uploadCalls")))
        page.wait_for_function("window.__uploadCalls.length === 1", timeout=5000)

        # ---- 4. 上传还没完就提交：先发「先别动手」提醒，再发附件 ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.evaluate("window.__uploadDelay = 1500")  # goto 之后再设，否则被重载冲掉
        page.set_input_files("[data-qattach] input[type=file]", [str(PNG), str(TXT)])
        page.wait_for_selector(".qaChipFile", timeout=5000)
        page.click("#submit")
        page.evaluate("document.querySelector('[data-question-key]').remove()")
        page.wait_for_function("window.__sent.length >= 2", timeout=15000)
        sent = page.evaluate("window.__sent")
        first, second = sent[0], sent[1]
        check("第一条是「先别动手」提醒",
              [p["type"] for p in first["parts"]] == ["text"] and "先别动手" in (first["parts"][0]["text"] or ""),
              str(first["parts"]))
        types = [p["type"] for p in second["parts"]]
        check("第二条先附件后文字", types == ["image", "file", "text"], str(types))
        check("文件走 receiptId", (second["parts"][1]["receiptId"] or "").startswith("rcpt-"),
              str(second["parts"][1]["receiptId"]))
        check("图片是裸 base64", (second["parts"][0]["dataLength"] or 0) > 100 and second["parts"][0]["dataPrefix"] != "data:ima")
        check("末尾文字说明附件数量", "1 张图" in (second["parts"][2]["text"] or "") and "1 个文件" in (second["parts"][2]["text"] or ""),
              str(second["parts"][2]["text"]))
        check("用的是 steer", second["mode"] == "steer", second["mode"])

        # ---- 5. 上传已完成：一条消息搞定 ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.evaluate("window.__uploadDelay = 10")
        page.set_input_files("[data-qattach] input[type=file]", [str(PNG), str(TXT)])
        page.wait_for_function("window.__uploadCalls.length === 1", timeout=5000)
        page.wait_for_timeout(200)
        page.click("#submit")
        page.evaluate("document.querySelector('[data-question-key]').remove()")
        page.wait_for_function("window.__sent.length >= 1", timeout=8000)
        page.wait_for_timeout(400)
        single = page.evaluate("window.__sent")
        check("上传完成时不发多余提醒", len(single) == 1, f"sent={len(single)}")
        check("一条里同时有图和文件", [p["type"] for p in single[0]["parts"]] == ["image", "file", "text"],
              str([p["type"] for p in single[0]["parts"]]))

        # ---- 6. 关卡片（header ×）不发 ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.evaluate("window.__sent = []")
        page.set_input_files("[data-qattach] input[type=file]", str(PNG))
        page.wait_for_selector(".qaChipImg img", timeout=5000)
        page.click("header .x")
        page.evaluate("document.querySelector('[data-question-key]').remove()")
        page.wait_for_timeout(600)
        check("从 header 关掉不发附件", page.evaluate("window.__sent.length") == 0)

        # ---- 7. 卡片收起（body 卸载）→ 栏消失，不留痕 ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.evaluate("document.querySelector('[data-question-scroll]').remove()")
        page.wait_for_timeout(500)
        check("收起卡片后栏被移除", page.locator("[data-qattach]").count() == 0)
        check("收起卡片后不误发（没动过）", page.evaluate("window.__sent.length") == 0)

        # ---- 8. 单张移除 ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.set_input_files("[data-qattach] input[type=file]", str(PNG))
        page.wait_for_selector(".qaChipImg img", timeout=5000)
        page.click(".qaX")
        page.wait_for_timeout(200)
        check("chip 上的 × 能移除", page.locator(".qaChip").count() == 0)

        # ---- 9. Ctrl+V 粘贴截图（focus 在卡片里） ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.evaluate("window.__sent = []")
        paste_result = page.evaluate(
            """async () => {
              const canvas = document.createElement('canvas');
              canvas.width = 32; canvas.height = 24;
              const ctx2d = canvas.getContext('2d');
              ctx2d.fillStyle = '#3355ff'; ctx2d.fillRect(0, 0, 32, 24);
              const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
              const file = new File([blob], '', { type: 'image/png' });   // 截图常见：无文件名
              const dt = new DataTransfer();
              dt.items.add(file);
              const textarea = document.querySelector('[data-question-scroll] textarea');
              textarea.focus();
              const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
              textarea.dispatchEvent(event);
              return { prevented: event.defaultPrevented };
            }"""
        )
        page.wait_for_selector(".qaChipImg img", timeout=5000)
        check("粘贴截图能挂上", page.locator(".qaChipImg").count() == 1)
        check("粘贴被拦下（不往输入框塞垃圾）", paste_result["prevented"] is True)
        check("上报了 paste 事件", any("ev=paste" in u for u in page.evaluate("window.__ping")))
        page.click("#submit")
        page.evaluate("document.querySelector('[data-question-key]').remove()")
        page.wait_for_function("window.__sent.length >= 1", timeout=8000)
        pasted = page.evaluate("window.__sent")[0]
        check("粘贴的图也能随回答发出", [p["type"] for p in pasted["parts"]] == ["image", "text"],
              str([p["type"] for p in pasted["parts"]]))

        # ---- 10. 缩略图点开预览（线上 00:16 反馈：不能点开预览） ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.set_input_files("[data-qattach] input[type=file]", str(BIG_PNG))
        page.wait_for_selector(".qaChipImg img", timeout=5000)
        page.click(".qaChipImg")
        page.wait_for_selector("[data-qapreview]", timeout=3000)
        box = page.evaluate(
            """() => {
              const el = document.querySelector('[data-qapreview]');
              const img = el.querySelector('img');
              return { fixed: getComputedStyle(el).position === 'fixed', w: img.getBoundingClientRect().width };
            }"""
        )
        check("点缩略图能打开预览", box["fixed"] is True and box["w"] > 100, str(box))
        page.click("[data-qapreview]")
        page.wait_for_timeout(150)
        check("点一下预览就关掉", page.locator("[data-qapreview]").count() == 0)

        # ---- 11. key 里那段不是 Session 身份时，回落 uiSession（复现线上 no-session） ----
        page.goto(CARD.as_uri())
        page.wait_for_selector("[data-qattach]", timeout=5000)
        page.evaluate("window.__sent = []")
        page.set_input_files("[data-qattach] input[type=file]", str(PNG))
        page.wait_for_selector(".qaChipImg img", timeout=5000)
        page.click("#submit")
        page.evaluate("document.querySelector('[data-question-key]').remove()")
        page.wait_for_function("window.__sent.length >= 1", timeout=8000)
        check("key 段解析不到时改用当前会话照发", page.evaluate("window.__sent.length") == 1)
        check("没有报 no-session", not any("ev=no-session" in u for u in page.evaluate("window.__ping")),
              str([u for u in page.evaluate("window.__ping") if "no-session" in u]))

        check("全程无 JS 异常", not errors, "; ".join(errors))
        browser.close()

    print()
    if failures:
        print("FAILED:", len(failures), "->", failures)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

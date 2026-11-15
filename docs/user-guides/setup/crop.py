#!/usr/bin/env python3
"""撮った画面（shots/）から、説明に要る範囲だけを切り出して figs/ に置く。番号の位置（marks.js）も切り出しに合わせて移す。

実行:  python3 docs/user-guides/setup/crop.py
範囲は CSS px（撮影時の画面 1280×720 基準）。画素の倍率は画像から求める。
撮ったままの画面（shots/）はリポジトリに入れない。撮り直すときは automator/src/guide/setupShots.ts
（検証用の dcm4chee 2 台は automator/src/guide/setupLab/lab/docker-compose.yml）。
PDF にするのは automator/src/guide/setupPdf.ts。
"""
import json
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SHOTS, FIGS = HERE / "shots", HERE / "figs"

SETTINGS = (258, 98, 1022, 622)     # 環境設定のダイアログ
SEND = (218, 38, 1062, 682)         # DICOM 送信のダイアログ
UI2_DIALOG = (116, 16, 1164, 720)   # dcm4chee の Register new application entity
UI2_DEVICE = (116, 16, 1164, 400)   # 同じ窓の New Device の欄
QR = (0, 0, 1280, 250)              # Query/Retrieve の窓の上部
MAIN = (0, 0, 1280, 330)            # メイン画面の上部

# 名前: (範囲, {番号(1 始まり): 番号を出す側})。範囲 None は切り出さない。nonum は枠だけで番号を出さない。
PLAN = {
    "sa-local-ae": (SETTINGS, {}),
    "sa-remote": (SETTINGS, {1: "left", 4: "left"}),
    "sa-main-toolbar": ((0, 0, 1280, 200), {}),
    "sa-qr-query": (QR, {1: "right", 3: "left", 4: "bottom"}),
    "sa-qr-saved": (QR, {1: "bottom"}),
    "sa-main-after": (MAIN, {}),
    "sa-send": (SEND, {}),
    "sa-send-done": (SEND, {}),
    "ui2-newaet-graphynext-a": (UI2_DEVICE, {1: "right"}),
    "ui2-newaet-graphynext-b": (UI2_DIALOG, {1: "right", 2: "right", 3: "right"}),
    "ui2-newaet-graphypacs-a": (UI2_DEVICE, {1: "right"}),
    "ui2-newaet-graphypacs-b": (UI2_DIALOG, {1: "right", 2: "right", 3: "right"}),
    "ui2-aelist": ((0, 0, 1280, 470), {3: "left"}),
    "web-main-empty": ((560, 0, 1280, 230), {1: "left", 2: "bottom"}),
    "web-remote": (SETTINGS, {1: "left", 4: "left"}),
    "web-movedest": (SETTINGS, {}),
    "web-qr-query": (QR, {1: "right", 3: "left", 4: "bottom"}),
    "web-qr-saved": (QR, {1: "bottom"}),
    "web-main-after": (MAIN, {}),
    "web-viewer": (None, {}),
    "tr-echo-ng": (SETTINGS, {2: "bottom"}),
    "tr-qr-nopc": ((0, 0, 1280, 270), {1: "nonum"}),
    "tr-qr-zero": (QR, {1: "nonum"}),
    "tr-qr-unsaved": (QR, {1: "bottom"}),
    "tr-debug": (SETTINGS, {}),
    "tr-web-baseurl": ((260, 130, 1280, 300), {1: "nonum"}),
}


FULL_COLOR = {"web-viewer"}  # 医用画像の濃淡を含むものは減色しない


def save(im: Image.Image, name: str) -> None:
    """画面写真は色数が少ないので 256 色にして軽くする（PDF と配布物の大きさを抑える）。"""
    if name not in FULL_COLOR:
        im = im.convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    im.save(FIGS / f"{name}.png", optimize=True)


def load_marks() -> dict:
    text = (SHOTS / "marks.js").read_text(encoding="utf-8")
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def main() -> None:
    marks = load_marks()
    FIGS.mkdir(exist_ok=True)
    for old in FIGS.glob("*.png"):
        old.unlink()
    out = {}
    for name, (rect, sides) in PLAN.items():
        im = Image.open(SHOTS / f"{name}.png")
        base_w = marks.get(name, {}).get("width", 1280)
        scale = im.width / base_w
        x0, y0, x1, y1 = rect or (0, 0, base_w, round(im.height / scale))
        save(im.crop(tuple(round(v * scale) for v in (x0, y0, x1, y1))), name)
        moved = []
        for i, m in enumerate(marks.get(name, {}).get("marks", []), start=1):
            ax0, ay0 = max(m["x"], x0), max(m["y"], y0)
            ax1, ay1 = min(m["x"] + m["w"], x1), min(m["y"] + m["h"], y1)
            if ax1 <= ax0 or ay1 <= ay0:
                raise SystemExit(f"{name}: 番号 {i} が切り出しの範囲の外です")
            moved.append({"x": ax0 - x0, "y": ay0 - y0, "w": ax1 - ax0, "h": ay1 - ay0, "side": sides.get(i, m["side"])})
        out[name] = {"width": x1 - x0, "height": y1 - y0, "marks": moved}
        print(f"{name}: {im.width}x{im.height} -> {round((x1 - x0) * scale)}x{round((y1 - y0) * scale)}（番号 {len(moved)}）")
    # 起動時のダイアログは画面全体の左上に出るので、その部分だけを使う（画面全体の画素で指定）
    port = Image.open(SHOTS / "tr-port8080.png")
    if port.width >= 1600:
        port = port.crop((0, 0, 440, 178))
    save(port, "tr-port8080")
    (FIGS / "marks.js").write_text(f"window.GUIDE_MARKS = {json.dumps(out, ensure_ascii=False, indent=1)};\n", encoding="utf-8")


if __name__ == "__main__":
    main()

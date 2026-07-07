#!/usr/bin/env python3
"""アプリアイコンのマスター(frontend/public/icons/app/app_icon.png)から
electron-builder 用の desktop/build/icon.png(1024x1024)を生成する。

electron-builder はベースアイコンに 512x512 以上の正方形 PNG を要求し、
そこから各 OS 用(.ico / .icns / .png)を自動変換する。マスターが 500x500 のため
ここで 1024x1024 にリサンプルして単一ソースを保つ。

app_icon.png を差し替えたら本スクリプトを実行して build/icon.png を更新すること。
    python3 scripts/gen-app-icon.py
依存: Pillow (pip install Pillow)
"""
import pathlib
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow が必要です: pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend/public/icons/app/app_icon.png"
DST = ROOT / "desktop/build/icon.png"

if not SRC.exists():
    sys.exit(f"マスターが見つかりません: {SRC}")

img = Image.open(SRC).convert("RGBA").resize((1024, 1024), Image.LANCZOS)
DST.parent.mkdir(parents=True, exist_ok=True)
img.save(DST)
print(f"wrote {DST} ({img.size[0]}x{img.size[1]}) from {SRC.name}")

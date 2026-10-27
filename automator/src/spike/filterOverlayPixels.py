"""フィルタ層スパイクの画素判定。before/after のスクリーンショット（同じ範囲）を比べる。

usage: filterOverlayPixels.py before.png after.png  → JSON
  before の明るい塊（円板）を 3 つ見つけ（左から 半径 2・4・6 mm）、中心の画素・差分・隅の一致を返す。
"""
import json
import sys
from collections import deque

import numpy as np
from PIL import Image

b = Image.open(sys.argv[1]).convert("RGB")
a = Image.open(sys.argv[2]).convert("RGB")
W, H = b.size
assert a.size == b.size, (a.size, b.size)
bp, ap = b.load(), a.load()
arr = np.asarray(b, dtype=float).mean(axis=2)
# 画像の矩形: 黒でない画素が行・列の大半を占める範囲（文字は細いので外れる）
rows = np.where((arr > 20).mean(axis=1) > 0.3)[0]
cols = np.where((arr > 20).mean(axis=0) > 0.3)[0]
X0, X1, Y0, Y1 = int(cols[0]), int(cols[-1]), int(rows[0]), int(rows[-1])
lum = [[(bp[x, y][0] + bp[x, y][1] + bp[x, y][2]) / 3 for x in range(W)] for y in range(H)]
inside = arr[Y0:Y1 + 1, X0:X1 + 1]
bg = float(np.median(inside))  # 背景は画像の大半
hi = float(inside.max())
mid = (bg + hi) / 2
seen = [[False] * W for _ in range(H)]
blobs = []
for y in range(Y0, Y1 + 1):
    for x in range(X0, X1 + 1):
        if seen[y][x] or lum[y][x] <= mid:
            continue
        q = deque([(x, y)]); seen[y][x] = True; pts = []
        while q:
            cx, cy = q.popleft(); pts.append((cx, cy))
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if X0 <= nx <= X1 and Y0 <= ny <= Y1 and not seen[ny][nx] and lum[ny][nx] > mid:
                    seen[ny][nx] = True; q.append((nx, ny))
        if len(pts) >= 20:
            blobs.append(pts)
blobs.sort(key=lambda p: sum(x for x, _ in p) / len(p))
cent = [(round(sum(x for x, _ in p) / len(p)), round(sum(y for _, y in p) / len(p)), len(p)) for p in blobs]


def diff(x, y):
    return [ap[x, y][i] - bp[x, y][i] for i in range(3)]


def corner(x0, y0, n=8):
    return sum(1 for y in range(y0, y0 + n) for x in range(x0, x0 + n) if ap[x, y] != bp[x, y])


res = {
    "size": [W, H], "blobs": cent,
    "centre": [{"before": list(bp[x, y]), "after": list(ap[x, y]), "delta": diff(x, y)} for x, y, _ in cent],
    "changedTotal": sum(1 for y in range(H) for x in range(W) if ap[x, y] != bp[x, y]),
    "imageRect": [X0, Y0, X1, Y1],
    "cornersChanged": [corner(X0 + 2, Y0 + 2), corner(X1 - 10, Y0 + 2), corner(X0 + 2, Y1 - 10), corner(X1 - 10, Y1 - 10)],
}
print(json.dumps(res))

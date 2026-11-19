"""planes2dCheck.ts の独立の基準。本体（Java）の実装は使わず、numpy・scipy の map_coordinates だけで、
患者の LPS 軸に揃えた 3 断面（Axial・Sagittal・Coronal）の、断面ごと・位置ごとの ROI の画素数と平均強度を求める。

使い方: python3 -I planes2dRef.py <体積.npy（HU、[k][row][col]）> <geom2dSynth の JSON> <出力 JSON>
格子の定義（設計）: 元の体積の原点 O（先頭スライスの先頭画素の中心）から、間隔 s（= 元の最小間隔）ごとの格子点。範囲は ROI の
外接（ROI の画素中心の最小・最大）の ±1 間隔。マスクは三線形補間 0/1 の値が 0.5 以上。画像は端の値で延長。
"""
import json
import sys

import numpy as np
from scipy.ndimage import map_coordinates

vol = np.load(sys.argv[1])
syn = json.load(open(sys.argv[2]))
iop = np.array(syn["iop"], dtype=float)
ex, ey = iop[:3], iop[3:]
en = np.cross(ex, ey)
sp_row, sp_col = syn["pixelSpacing"]  # [行間隔(=列方向 ey), 列間隔(=行方向 ex)]
dx, dy, dt = sp_col, sp_row, syn["sliceThickness"]
o = np.array(syn["frames"][0]["imagePositionPatient"], dtype=float)
b = syn["box"]
n, h, w = vol.shape
mask = np.zeros_like(vol)
mask[b["k0"]:b["k1"], b["r0"]:b["r1"], b["c0"]:b["c1"]] = 1.0
s = min(dx, dy, dt)

kk, jj, ii = np.nonzero(mask)
pts = o[None, :] + ii[:, None] * dx * ex[None, :] + jj[:, None] * dy * ey[None, :] + kk[:, None] * dt * en[None, :]
lo, hi = pts.min(axis=0), pts.max(axis=0)
mlo = np.floor((lo - s - o) / s).astype(int)
mhi = np.ceil((hi + s - o) / s).astype(int)

PLANES = {  # 名前: (行の軸, 列の軸, 列の符号, 法線の軸)
    "AXIAL": (0, 1, +1, 2), "SAGITTAL": (1, 2, -1, 0), "CORONAL": (0, 2, -1, 1),
}
out = {}
for name, (ra, ca, cs, na) in PLANES.items():
    nr, nc, nn = mhi[ra] - mlo[ra] + 1, mhi[ca] - mlo[ca] + 1, mhi[na] - mlo[na] + 1
    r_idx = mlo[ra] + np.arange(nr)
    c_idx = (mlo[ca] + np.arange(nc)) if cs > 0 else (mhi[ca] - np.arange(nc))
    res = {}
    for q in range(nn):
        cn = o[na] + (mlo[na] + q) * s
        R, C = np.meshgrid(r_idx, c_idx)  # (nc, nr)
        P = np.zeros(R.shape + (3,))
        P[..., ra] = o[ra] + R * s
        P[..., ca] = o[ca] + C * s
        P[..., na] = cn
        d = P - o
        u = (d @ ex) / dx
        v = (d @ ey) / dy
        k = (d @ en) / dt
        coords = np.stack([k.ravel(), v.ravel(), u.ravel()])
        img = map_coordinates(vol, coords, order=1, mode="nearest")
        m = map_coordinates(mask, coords, order=1, mode="constant", cval=0.0) >= 0.5
        cnt = int(m.sum())
        if cnt:
            res[repr(float(cn))] = {"position": float(cn), "pixels": cnt, "mean": float(img[m].mean())}
    out[name] = {"spacing": s, "slices": list(res.values())}
json.dump(out, open(sys.argv[3], "w"))

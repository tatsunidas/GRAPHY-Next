#!/usr/bin/env python3
"""NIfTI（.nii.gz）の 1 枚を、向きの文字つきで描く（NIfTI 書き出しの向きの目視用）。

  python render-nifti-slice.py <nii.gz> <出力.png> <axial|sagittal> [<スライス番号|auto>] [<窓の中心> <窓の幅>]

nibabel の as_closest_canonical（RAS+）に直してから描く。
  axial   : 上 = 前（A）、左 = 患者の右（R）、右 = L（放射線科の慣例。画像に文字を入れる）。
  sagittal: 上 = 上（S）、左 = 前（A）、右 = 後（P）。
スライス番号 auto は、画素の標準偏差が最大のスライス（中身のあるもの）を選ぶ（空のスライスで合格にしない）。
標準出力に選んだ番号と、nibabel が言う軸の向き（aff2axcodes）を出す。
"""
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np

nii, out, plane = sys.argv[1], sys.argv[2], sys.argv[3]
idx = sys.argv[4] if len(sys.argv) > 4 else "auto"
wc = float(sys.argv[5]) if len(sys.argv) > 5 else 40.0
ww = float(sys.argv[6]) if len(sys.argv) > 6 else 400.0
img = nib.as_closest_canonical(nib.load(nii))
data = np.asanyarray(img.dataobj).astype(np.float32)  # [x(R+), y(A+), z(S+)]
print("axcodes:", nib.aff2axcodes(img.affine), "shape:", data.shape)

if plane == "axial":
    n = data.shape[2]
    sl = (lambda k: data[:, :, k])
else:
    n = data.shape[0]
    sl = (lambda k: data[k, :, :])
k = int(np.argmax([np.std(sl(i)) for i in range(n)])) if idx == "auto" else int(idx)
a = sl(k)
if plane == "axial":
    # a[x(R+), y(A+)] → 表示: 行 = y を上が A（反転）、列 = x を左が R（そのまま R+ が右になるので反転して R を左へ）
    disp = a.T[::-1, ::-1]
    letters = {"left": "R", "right": "L", "top": "A", "bottom": "P"}
else:
    # a[y(A+), z(S+)] → 表示: 行 = z（上が S）、列 = y（左が A）
    disp = a.T[::-1, ::-1]
    letters = {"left": "A", "right": "P", "top": "S", "bottom": "I"}
sx, sy, sz = (float(v) for v in np.sqrt((img.affine[:3, :3] ** 2).sum(axis=0)))
if plane == "axial":
    aspect = sy / sx   # 行 = y, 列 = x
else:
    aspect = sz / sy   # 行 = z, 列 = y
fig, ax = plt.subplots(figsize=(6, 6), dpi=110)
ax.imshow(disp, cmap="gray", vmin=wc - ww / 2, vmax=wc + ww / 2, aspect=aspect)
ax.axis("off")
kw = dict(color="yellow", fontsize=20, fontweight="bold", transform=ax.transAxes)
ax.text(0.02, 0.5, letters["left"], ha="left", va="center", **kw)
ax.text(0.98, 0.5, letters["right"], ha="right", va="center", **kw)
ax.text(0.5, 0.98, letters["top"], ha="center", va="top", **kw)
ax.text(0.5, 0.02, letters["bottom"], ha="center", va="bottom", **kw)
ax.set_title(f"{plane} slice {k}/{n}  (nibabel as_closest_canonical)", fontsize=9)
fig.savefig(out, bbox_inches="tight")
print("slice:", k, "->", out)

#!/usr/bin/env python3
"""保存された T2 マップ（派生シリーズ）の値を、ファントムの真値（truth.json）と突き合わせる。

使い方: python3 check-t2-saved.py <保存したシリーズのフォルダ> <truth.json> [--tol 0.05] [--padding-disks 5000]
  [--z-t2] [--expect-instances 8]
  各円柱の中心付近（半径 r-1 の円内）の実値（格納値×slope+intercept）の中央値が、真の T2 の ±tol 以内か。
  --padding-disks: その T2 の円柱は「測れない」円柱。データ無し（PixelPaddingValue）の割合が、雑音と σ̂ から予測した値と
                   一致すること（NaN を 0 や値で埋めない。長い T2 にも僅かな減衰があるので、全部が無しになるとは限らない）。
  --sigma-est: プラグインが推定した σ̂（画面・説明に出る）。--p: 誤検出確率（既定 0.01）。予測に使う。
  --z-t2: 体の T2 が位置の z で変わるファントム。各インスタンスの IPP の z から期待値を求め、保存順・位置の対応を見る。
合格・失敗を数えて、失敗があれば終了コード 1。
"""
import argparse
import glob
import json
import os
import sys

import math
from statistics import NormalDist

import numpy as np
import pydicom

ap = argparse.ArgumentParser()
ap.add_argument("folder")
ap.add_argument("truth")
ap.add_argument("--tol", type=float, default=0.05)
ap.add_argument("--padding-disks", default="")
ap.add_argument("--z-t2", action="store_true")
ap.add_argument("--sigma-est", type=float, default=0.0)
ap.add_argument("--p", type=float, default=0.01)
ap.add_argument("--expect-instances", type=int, default=0)
a = ap.parse_args()

t = json.load(open(a.truth))
files = sorted(glob.glob(os.path.join(a.folder, "*.dcm")))
ds = sorted((pydicom.dcmread(f) for f in files), key=lambda d: int(d.InstanceNumber))
fails = 0
total = 0


def check(ok, msg):
    global fails, total
    total += 1
    if not ok:
        fails += 1
    print(("  OK   " if ok else "  FAIL ") + msg)


check(len(ds) > 0, f"{os.path.basename(a.folder)}: {len(ds)} 枚")
if a.expect_instances:
    check(len(ds) == a.expect_instances, f"枚数 = {a.expect_instances}")
if not ds:
    sys.exit(1)
pad_disks = {float(x) for x in a.padding_disks.split(",") if x}
yy, xx = np.mgrid[0 : t["ny"], 0 : t["nx"]]
slope = float(ds[0].RescaleSlope)
icpt = float(ds[0].RescaleIntercept)
check(str(ds[0].RescaleType) == "ms", f"RescaleType = ms ({ds[0].RescaleType})")
pad = getattr(ds[0], "PixelPaddingValue", None)
check(pad is not None, f"PixelPaddingValue がある ({pad})")


def real(d):
    return d.pixel_array.astype(np.float64) * float(d.RescaleSlope) + float(d.RescaleIntercept)


def stored(d):
    return d.pixel_array.astype(np.int64)


mid = ds[len(ds) // 2]
img, raw = real(mid), stored(mid)
for k in t["disks"]:
    rr = max(k["r"] - 1, 1) ** 2
    m = (xx - k["cx"]) ** 2 + (yy - k["cy"]) ** 2 <= rr
    if k["t2"] in pad_disks:
        # 全スライスの円内の画素を数える（予測と比べるのに十分な数）
        n = obs = 0
        for d in ds:
            n += int(m.sum())
            obs += int(np.sum(stored(d)[m] == pad))
        frac = obs / n
        te0, te1 = t["te"][0], t["te"][-1]
        sa, sb = t["S0"] * math.exp(-te0 / k["t2"]), t["S0"] * math.exp(-te1 / k["t2"])
        D = math.log(sa / sb)
        sd_true = t["sigma"] * math.sqrt(1 / sa**2 + 1 / sb**2)
        z = NormalDist().inv_cdf(1 - a.p)
        # 採用（T2 が付く）される確率: D̂ > z·σ̂·√(1/Sa²+1/Sb²)。D̂ ~ N(D, sd_true²)
        thr = z * a.sigma_est * math.sqrt(1 / sa**2 + 1 / sb**2)
        p_accept = 1 - NormalDist(D, sd_true).cdf(thr)
        pred = 1 - p_accept
        tol = 3 * math.sqrt(pred * (1 - pred) / n) + 0.03  # 3 SD + 近似の余裕
        check(abs(frac - pred) <= tol, f"T2={k['t2']:g} の円柱: データ無しの割合 {frac*100:.1f}%（予測 {pred*100:.1f}% ± {tol*100:.1f}%、n={n}、D={D:.4f}、SD(D)={sd_true:.4f}）")
        check(frac >= 0.5, f"T2={k['t2']:g} の円柱は、測れない画素の方が多い（データ無し {frac*100:.1f}%）")
    else:
        med = float(np.median(img[m]))
        rel = abs(med - k["t2"]) / k["t2"]
        check(rel <= a.tol, f"T2={k['t2']:g}: 中央値 {med:.1f} ms（ずれ {rel*100:.2f}%、許容 {a.tol*100:g}%）")
bg = (xx < 3) & (yy < 3)
check(float(np.mean(raw[bg] == pad)) >= 0.95, "体の外（背景）は PixelPaddingValue（データ無し）で埋まる")

if a.z_t2:
    zs = []
    for d in ds:
        z = float(d.ImagePositionPatient[2])
        idx = round(z / t["z_step_mm"])
        exp = t["body_t2"] + 10.0 * idx
        v = real(d)[28:35, 44:53]
        med = float(np.median(v))
        rel = abs(med - exp) / exp
        zs.append((z, med, exp))
        check(rel <= a.tol, f"IPP z={z:g} mm: 体の T2 中央値 {med:.1f} ms（期待 {exp:g} ms、ずれ {rel*100:.2f}%）")
    check(len({round(m) for _, m, _ in zs}) > 1, "スライスごとに値が違う（対応の検査として成立している）")

print(f"{total - fails}/{total} 合格, {fails} 失敗")
sys.exit(1 if fails else 0)

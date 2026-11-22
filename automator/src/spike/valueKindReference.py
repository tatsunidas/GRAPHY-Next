"""valueKindCheck.ts の独立の基準。合成シリーズの ROI の画素値を、書き出した DICOM から読み直し、IBSI 1（3.5）の式だけで
IVH の 6 つの特徴量を求める（本体の実装は使わない。ν_i = 1 − (1/N)·Σ[X < i]、γ_i = (i − min G)/(max G − min G)、
I_x ＝ ν_i ≤ x となる最小の格子点、V_x ＝ γ_i ≥ x となる最小の格子点の ν）。

使い方: python3 -I valueKindReference.py '<JSON>'   JSON: {"dir", "name", "mode", "w", "ng", "suv", "box"}
  mode 0: 整数の格子（偶数丸め）、1: 固定ビン幅 w（ビン中心）、2: 固定ビン数 ng。suv=true は PET を SUVbw にする。
出力: {"features":[V10,V90,I10,I90,Vdiff,Idiff], "edgeRisk": ビンの境界に乗って浮動小数の誤差で決まりうるボクセル数, "n"}
"""
import glob
import json
import math
import sys
from decimal import Decimal, ROUND_FLOOR

import numpy as np
import pydicom

a = json.loads(sys.argv[1])
if "voxelsFile" in a:  # 実データ: ROI の画素値（SUV など）を別のスクリプトが書き出した配列から読む
    files = []
    b = None
    vals = [np.load(a["voxelsFile"]).astype(np.float64)]
else:
    files = sorted(glob.glob(f"{a['dir']}/{a['name']}/*.dcm"))
    b = a["box"]
    vals = []
for z, f in enumerate(files):
    if not (b["z0"] <= z < b["z1"]):
        continue
    d = pydicom.dcmread(f)
    px = d.pixel_array.astype(np.float64)[b["r0"]:b["r1"], b["c0"]:b["c1"]]
    v = px * float(d.RescaleSlope) + float(d.RescaleIntercept) if "RescaleSlope" in d else px
    if a.get("suv"):
        dose = float(d.RadiopharmaceuticalInformationSequence[0].RadionuclideTotalDose)
        v = v * (float(d.PatientWeight) * 1000.0) / dose  # 撮像時刻 = 投与時刻なので減衰の補正は 1
    vals.append(v.ravel())
x = np.concatenate(vals).astype(np.float32).astype(np.float64)  # 本体は float32 の画像で計算する
n = len(x)
mode, w, ng = a["mode"], a.get("w"), a.get("ng", 1000)
edge = 0
if mode == 0:
    X = np.rint(x)
    kmin, kmax = int(X.min()), int(X.max())
    grid = [float(k) for k in range(kmin, kmax + 1)]
    step = 1.0
elif mode == 1:
    xmin, xmax = float(x.min()), float(x.max())
    nb = int(((Decimal(repr(xmax)) - Decimal(repr(xmin))) / Decimal(repr(w))).to_integral_value(ROUND_FLOOR))
    t = (x - xmin) / w
    edge = int(np.sum((np.abs(t - np.rint(t)) < 1e-6 * np.maximum(1, np.abs(t))) & (x > xmin)))
    bins = np.floor(t).astype(np.int64) + 1
    X = xmin + (bins - 0.5) * w
    grid = [xmin + (k - 0.5) * w for k in range(1, nb + 1)]
    step = w
else:
    xmin, xmax = float(x.min()), float(x.max())
    t = ng * ((x - xmin) / (xmax - xmin))
    mid = (x < xmax)
    edge = int(np.sum(mid & (np.abs(t - np.rint(t)) < 1e-6) & (x > xmin)))
    X = np.where(x >= xmax, ng, np.floor(t) + 1)
    grid = [float(k) for k in range(1, ng + 1)]
    step = 1.0


def nu(i):
    return 1.0 - float(np.sum(X < i - step / 2)) / n


gmin, gmax = grid[0], grid[-1]
out = []
for p in (10, 90):  # V_x
    v = float("nan")
    if gmax > gmin:
        for i in grid:
            if (i - gmin) / (gmax - gmin) >= p / 100 - 1e-12:
                v = nu(i)
                break
    out.append(v)
for p in (10, 90):  # I_x（格子の上端を越えても探す）
    i = gmin
    top = float(np.max(X)) + 2 * step
    r = float("nan")
    while i <= top:
        if nu(i) <= p / 100 + 1e-12:
            r = i
            break
        i += step
    out.append(r)
out.append(out[0] - out[1])
out.append(out[2] - out[3])
print(json.dumps({"features": [None if (isinstance(v, float) and math.isnan(v)) else v for v in out], "edgeRisk": edge, "n": n}))

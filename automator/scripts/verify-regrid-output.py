"""
再格子化の出力（派生シリーズの DICOM 一式）を、リサンプラの実装に依らず python 側で照合する。

    python verify-regrid-output.py <truth.json> <phantom の dir 名> <出力 DICOM のフォルダ> <間隔 mm>

標準出力に JSON（{"checks": [[名前, 真偽, 詳細], ...], "padded": n, "nonFinite": n}）を書く。
真値: dims = floor(L/s)+1（L は元の各軸の長さ）、IOP は元と 1e-6、IPP は 原点 + k·s·法線 と 1e-3 mm、
値は 1 次関数を出力 IPP から計算して ε = (q_src + q_out)/2 以内。
"""
import glob
import json
import math
import os
import sys

import numpy as np
import pydicom

truth = json.load(open(sys.argv[1]))
which = sys.argv[2]
files = sorted(glob.glob(os.path.join(sys.argv[3], "*")))
s = float(sys.argv[4])
ph = next(p for p in truth["phantoms"] if p["dir"] == which)
A, B, C, D = (truth["func"][k] for k in "ABCD")
sp = truth["spacingMm"]

dss = sorted((pydicom.dcmread(f) for f in files), key=lambda d: int(d.InstanceNumber))
iop = np.array(ph["iop"])
rc, rr = iop[:3], iop[3:]
nrm = np.cross(rc, rr)
origin = np.array(truth["origin"])
step = np.array(ph["step"])
L_col = (truth["cols"] - 1) * sp["col"]
L_row = (truth["rows"] - 1) * sp["row"]
L_sl = float(np.dot(step * (truth["slices"] - 1), nrm))
exp_dims = (math.floor(L_col / s + 1e-9) + 1, math.floor(L_row / s + 1e-9) + 1, math.floor(L_sl / s + 1e-9) + 1)

checks = []


def chk(name, ok, detail=""):
    checks.append([name, bool(ok), str(detail)])


d0 = dss[0]
chk("枚数", len(dss) == exp_dims[2], f"{len(dss)} / {exp_dims[2]}")
chk("列数", int(d0.Columns) == exp_dims[0], f"{d0.Columns} / {exp_dims[0]}")
chk("行数", int(d0.Rows) == exp_dims[1], f"{d0.Rows} / {exp_dims[1]}")
chk("PixelSpacing", np.allclose([float(x) for x in d0.PixelSpacing], [s, s], atol=1e-6), list(d0.PixelSpacing))
chk("SpacingBetweenSlices", abs(float(d0.SpacingBetweenSlices) - s) < 1e-6, d0.get("SpacingBetweenSlices"))
q_out = float(d0.RescaleSlope)
eps = (truth["slope"] + q_out) / 2
pad = d0.get("PixelPaddingValue", None)
padded = 0
nonfinite = 0
worst_ipp = 0.0
worst_iop = 0.0
worst_val = 0.0
for k, ds in enumerate(dss):
    ipp = np.array([float(x) for x in ds.ImagePositionPatient])
    worst_ipp = max(worst_ipp, float(np.max(np.abs(ipp - (origin + k * s * nrm)))))
    worst_iop = max(worst_iop, float(np.max(np.abs(np.array([float(x) for x in ds.ImageOrientationPatient]) - iop))))
    px = ds.pixel_array.astype(np.float64)
    jj, ii = np.meshgrid(np.arange(int(ds.Rows)), np.arange(int(ds.Columns)), indexing="ij")
    pos = ipp + ii[..., None] * s * rc + jj[..., None] * s * rr
    truth_v = A * pos[..., 0] + B * pos[..., 1] + C * pos[..., 2] + D
    val = px * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    mask = np.ones(px.shape, bool)
    if pad is not None:
        mask = px != int(pad)
        padded += int((~mask).sum())
    if mask.any():
        worst_val = max(worst_val, float(np.max(np.abs(val[mask] - truth_v[mask]))))
chk("IOP が元と 1e-6 以内", worst_iop < 1e-6, worst_iop)
chk("IPP が 1e-3 mm 以内", worst_ipp < 1e-3, worst_ipp)
chk("値が ε 以内（有限の画素のみ）", worst_val <= eps + 1e-9, f"最大誤差 {worst_val:.6f} ε {eps:.6f}")
print(json.dumps({"checks": checks, "padded": padded, "nonFinite": nonfinite, "paddingValue": None if pad is None else int(pad)}))

"""
保存された Fusion 演算結果のシリーズを、バックエンドの保管庫から直接読んで検査し、JSON で出力する。

    python verify-fusion-calc-output.py <保管庫のフォルダ> <ファントムのフォルダ> <SeriesDescription> <mode>

mode:
  pt-ct-mult   背景 CT(40 HU 一様) × 前景 PT(ガウス球)。期待値は PT を CT の格子点で 3 次線形補間した物理値 × 40。
               補間は本体の実装とは別に numpy で書く（同じ仮定で真値を作らない）。
  ct-const     一様な値のシリーズ。値と Rescale・メタデータを返す。
"""
import glob
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.tag import Tag

store, phantom, desc, mode = sys.argv[1:5]

found = []
for p in glob.glob(os.path.join(store, "**", "*.dcm"), recursive=True):
    try:
        h = pydicom.dcmread(p, stop_before_pixels=True)
    except Exception:
        continue
    if str(getattr(h, "SeriesDescription", "")) == desc:
        found.append(p)
if not found:
    print(json.dumps({"found": 0}))
    sys.exit(0)

dss = [pydicom.dcmread(p) for p in found]


def z_of(ds):
    if "PerFrameFunctionalGroupsSequence" in ds:
        return float(ds.PerFrameFunctionalGroupsSequence[0].PlanePositionSequence[0].ImagePositionPatient[2])
    return float(ds.ImagePositionPatient[2])


dss.sort(key=z_of)
first = dss[0]
is_pm = str(first.SOPClassUID) == "1.2.840.10008.5.1.4.1.1.30"
info = {
    "found": len(dss),
    "modality": str(first.Modality),
    "sop_class": str(first.SOPClassUID),
    "is_parametric_map": is_pm,
    "patient_id": str(first.PatientID),
    "patient_name": str(first.PatientName),
    "study_uid": str(first.StudyInstanceUID),
    "frame_of_reference": str(getattr(first, "FrameOfReferenceUID", "")),
    "rows": int(first.Rows), "columns": int(first.Columns),
    "has_rescale": "RescaleSlope" in first,
    "has_window": "WindowCenter" in first,
}


def volume(ds_list):
    out = []
    for ds in ds_list:
        if is_pm:
            raw = ds[Tag(0x7FE0, 0x0008)].value
            a = np.frombuffer(raw, dtype="<f4").reshape(ds.Rows, ds.Columns).astype(np.float64)
        else:
            a = ds.pixel_array.astype(np.float64) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
            if "PixelPaddingValue" in ds:
                pad = float(ds.PixelPaddingValue) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
                info["padding_value"] = pad
        out.append(a)
    return np.stack(out)


vol = volume(dss)
info["shape"] = list(vol.shape)
info["min"] = float(np.nanmin(vol))
info["max"] = float(np.nanmax(vol))
info["nan_count"] = int(np.isnan(vol).sum())
if not is_pm:
    info["rescale_slope"] = float(first.RescaleSlope)
    info["rescale_intercept"] = float(first.RescaleIntercept)
    info["rescale_type"] = str(getattr(first, "RescaleType", ""))
else:
    rw = first.SharedFunctionalGroupsSequence[0].RealWorldValueMappingSequence[0]
    info["rwvm_slope"] = float(rw.RealWorldValueSlope)
    info["unit_meaning"] = str(rw.MeasurementUnitsCodeSequence[0].CodeMeaning)
    info["derivation"] = str(first.DerivationDescription)

if mode.startswith("sample:"):
    # sample:<k>:<x>:<y> … スライス k の (x, y) 付近 3×3 の保存値。ビューアの読み値との突き合わせに使う
    _, ks, xs_, ys_ = mode.split(":")
    k, x, y = int(ks), int(round(float(xs_))), int(round(float(ys_)))
    info["neigh"] = [float(vol[k, yy, xx]) for yy in range(y - 1, y + 2) for xx in range(x - 1, x + 2)
                     if 0 <= yy < vol.shape[1] and 0 <= xx < vol.shape[2]]

if mode.startswith("sampleall:"):
    # sampleall:<x>:<y> … 全スライスの (x, y) 付近 3×3 の値（物理値）。k は呼び出し側が選ぶ
    _, xs_, ys_ = mode.split(":")
    x, y = int(round(float(xs_))), int(round(float(ys_)))
    info["neigh_all"] = [
        [float(vol[k, yy, xx]) for yy in range(y - 1, y + 2) for xx in range(x - 1, x + 2)
         if 0 <= yy < vol.shape[1] and 0 <= xx < vol.shape[2]]
        for k in range(vol.shape[0])
    ]

if mode == "pt-ct-mult":
    truth = json.load(open(os.path.join(phantom, "truth.json")))
    fg = truth["fg"]
    pts = sorted(glob.glob(os.path.join(phantom, "pt_*.dcm")))
    pt = np.stack([
        pydicom.dcmread(p).pixel_array.astype(np.float64) * fg["slope"] + fg["intercept"] for p in pts
    ])  # [z][y][x]
    bg = truth["bg"]
    xs = bg["origin_xy"] + bg["spacing"] * np.arange(bg["cols"])
    zs = np.array(bg["z"])
    # PT 格子の連続 index
    def idx(v, origin, step):
        return (v - origin) / step
    expected = np.empty_like(vol)
    for k, z in enumerate(zs):
        zi = idx(z, fg["z"][0], fg["z"][1] - fg["z"][0])
        z0 = int(np.floor(zi)); wz = zi - z0
        z1 = min(z0 + 1, pt.shape[0] - 1)
        yi = idx(xs, fg["origin_xy"], fg["spacing"])
        xi = idx(xs, fg["origin_xy"], fg["spacing"])
        y0 = np.floor(yi).astype(int); wy = yi - y0
        x0 = np.floor(xi).astype(int); wx = xi - x0
        y1 = np.minimum(y0 + 1, pt.shape[1] - 1); x1 = np.minimum(x0 + 1, pt.shape[2] - 1)
        def plane(zz):
            p = pt[zz]
            return ((1 - wy)[:, None] * ((1 - wx)[None, :] * p[np.ix_(y0, x0)] + wx[None, :] * p[np.ix_(y0, x1)])
                    + wy[:, None] * ((1 - wx)[None, :] * p[np.ix_(y1, x0)] + wx[None, :] * p[np.ix_(y1, x1)]))
        expected[k] = ((1 - wz) * plane(z0) + wz * plane(z1)) * 40.0
    err = np.abs(vol - expected)
    info["max_abs_err"] = float(np.nanmax(err))
    info["max_expected"] = float(np.nanmax(expected))
    info["rel_err"] = float(np.nanmax(err) / np.nanmax(expected))
    # 向きの確認: 球の中心（値が最大）の位置が一致するか
    info["argmax_out"] = [int(i) for i in np.unravel_index(np.nanargmax(vol), vol.shape)]
    info["argmax_expected"] = [int(i) for i in np.unravel_index(np.argmax(expected), expected.shape)]
    info["zero_fraction"] = float((vol == 0).mean())

print(json.dumps(info))

"""
保存した校正値のシリーズ（Parametric Map）を、元の合成 PET と解析式で照合する。

    python verify-calibrated-series.py <保管庫の dicom フォルダ> <元の合成 PET のフォルダ> <新シリーズの SeriesInstanceUID> <pid|suvr>

期待値は濃度と投与量から決める（アプリと同じ計算はここでしない）:
  pid : 値 = BQML × 100 / 崩壊後投与量
  suvr: 値 = BQML / 参照球の濃度
幾何: 新シリーズの各フレームの IPP・IOP・枚数が、元の各スライスと一致するか。
標準出力に JSON を 1 行。
"""
import glob
import json
import math
import os
import sys

import numpy as np
import pydicom

store, phantom, new_uid, mode = sys.argv[1:5]
truth = json.load(open(os.path.join(phantom, "truth.json"), encoding="utf-8"))

# 元（合成 PET）: z 昇順
src = []
for f in glob.glob(os.path.join(phantom, "*.dcm")):
    d = pydicom.dcmread(f)
    src.append((float(d.ImagePositionPatient[2]), d))
src.sort(key=lambda x: x[0])
decayed = truth["dose_bq"] * math.exp(-math.log(2) * 3600 / truth["half_life_s"])
scale = 100.0 / decayed if mode == "pid" else 1.0 / truth["c_ref"]

# 新シリーズ
frames = []  # (ipp, values[rows, cols])
meta = {}
for f in glob.glob(os.path.join(store, "**", "*"), recursive=True):
    if not os.path.isfile(f):
        continue
    try:
        d = pydicom.dcmread(f)
    except Exception:
        continue
    if getattr(d, "SeriesInstanceUID", None) != new_uid:
        continue
    n = int(getattr(d, "NumberOfFrames", 1) or 1)
    rows, cols = int(d.Rows), int(d.Columns)
    px = np.frombuffer(d.FloatPixelData, dtype="<f4").reshape(n, rows, cols)
    shared = d.SharedFunctionalGroupsSequence[0]
    meta["modality"] = str(d.Modality)
    rw = shared.RealWorldValueMappingSequence[0]
    u = rw.MeasurementUnitsCodeSequence[0]
    meta["unitCode"], meta["unitMeaning"] = str(u.CodeValue), str(u.CodeMeaning)
    meta["iop"] = [float(x) for x in shared.PlaneOrientationSequence[0].ImageOrientationPatient]
    meta["for"] = str(d.FrameOfReferenceUID)
    meta["derivation"] = str(getattr(d, "DerivationDescription", ""))
    meta["seriesDescription"] = str(d.SeriesDescription)
    for i in range(n):
        pf = d.PerFrameFunctionalGroupsSequence[i]
        ipp = [float(x) for x in pf.PlanePositionSequence[0].ImagePositionPatient]
        frames.append((ipp, px[i]))
frames.sort(key=lambda x: x[0][2])

out = {"nFrames": len(frames), "nSrc": len(src), **meta}
if len(frames) == len(src):
    max_rel, max_ipp = 0.0, 0.0
    for (ipp, v), (_, s) in zip(frames, src):
        sd = s
        exp = (sd.pixel_array.astype(np.float64) * float(sd.RescaleSlope) + float(sd.RescaleIntercept)) * scale
        rel = np.abs(v.astype(np.float64) - exp) / np.maximum(np.abs(exp), 1e-30)
        max_rel = max(max_rel, float(rel.max()))
        max_ipp = max(max_ipp, max(abs(a - float(b)) for a, b in zip(ipp, sd.ImagePositionPatient)))
    out["maxRelErr"] = max_rel
    out["maxIppDiffMm"] = max_ipp
    out["iopMaxDiff"] = max(abs(a - float(b)) for a, b in zip(meta["iop"], src[0][1].ImageOrientationPatient))
    out["forSame"] = meta["for"] == str(src[0][1].FrameOfReferenceUID)
    out["rows"], out["cols"] = int(frames[0][1].shape[0]), int(frames[0][1].shape[1])
print(json.dumps(out))

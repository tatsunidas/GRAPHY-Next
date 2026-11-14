"""
ROI・マスク・計測の幾何検証（段 1）に使う合成 CT（DICOM）を作る。

    python make-geom-verify-phantom.py <出力フォルダ> [--uid-seed N]

同じ患者座標（LPS mm）の物体を、幾何の違う格子で標本化した複数のシリーズを作る。
物体と真値は **患者座標の解析形状** で定義する（アプリのラスタ化規則・式は使わない）:

  場      v0(p) = A·x + B·y + C·z + D            （全域。ROI 平均の真値 = 図形の重心での値）
  球 S    中心 cS・半径 rS・値 +VS               （体積 4/3·π·r³）
  楕円体 E 中心 cE・半軸 (aE,bE,cE)（LPS 軸平行）・値 +VE （体積 4/3·π·a·b·c）
  標識 M0〜M3  半径 2.5 mm の小球・値 +VM         （点・長さ・角度の真値。非対称配置で反転・転置を検出）

標本化はボクセル中心での点標本（部分体積なし）。体積の離散化誤差は表面ボクセル数で抑えられる（truth.json に
各シリーズの表面ボクセル数の上限を書く）。

シリーズ（幾何 ID）:
  g0_iso        等方 1 mm・標準 axial
  g1_aniso      非正方画素（行 0.9 / 列 0.6 mm）・スライス 2.5 mm
  g2_oblique    二重斜位の IOP（直交取得）
  g3_tilt       ガントリーチルト 15°（スライスの進む向きが法線と非平行）
  g4_missing    1 枚欠損（等間隔から 1 枚抜く）
  g4_irregular  不等間隔（2.0〜3.5 mm）
  g5_reversed   IPP が位置の減る順（InstanceNumber は昇順）
  g8_calib      g1 の幾何・RescaleSlope 0.37（小数）・Intercept -1024・符号なし格納

最後に、書いたファイルを pydicom で読み戻し、IOP の単位・直交、IPP 差と法線、値が生成時の計算と一致することを
確かめる（自己検証）。--uid-seed を変えると UID が変わる（同じ UID のまま作り直さない）。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, CTImageStorage, UID

# ── 引数 ──
args = [a for a in sys.argv[1:] if not a.startswith("--")]
seed = 0
if "--uid-seed" in sys.argv:
    seed = int(sys.argv[sys.argv.index("--uid-seed") + 1])
out = args[0]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(seed or None)


def new_uid():
    # 2.25.<128bit>。seed 指定なら再現可能、無指定なら毎回違う
    return UID("2.25." + str(int.from_bytes(rng.bytes(16), "big")))


# ── 物体（患者座標 LPS mm）──
C0 = np.array([0.0, 0.0, 60.0])           # 全シリーズの格子中心
A, B, C, D = 0.5, -0.25, 0.125, 100.0     # 場 v0（HU 相当）
SPH = {"center": C0 + np.array([-15.0, 10.0, 0.0]), "r": 12.0, "v": 400.0}
ELL = {"center": C0 + np.array([15.0, -10.0, 10.0]), "abc": np.array([14.0, 9.0, 6.0]), "v": 800.0}
MARK_R, MARK_V = 2.5, 1200.0
MARKS = {
    "M0": C0 + np.array([30.0, 0.0, 0.0]),
    "M1": C0 + np.array([0.0, 30.0, 0.0]),
    "M2": C0 + np.array([0.0, 0.0, 15.0]),
    "M3": C0 + np.array([-30.0, -20.0, -5.0]),
}


def field(p):
    """p: (...,3) LPS → 値（HU 相当）"""
    v = A * p[..., 0] + B * p[..., 1] + C * p[..., 2] + D
    d = p - SPH["center"]
    v = v + np.where(np.sum(d * d, -1) <= SPH["r"] ** 2, SPH["v"], 0.0)
    q = (p - ELL["center"]) / ELL["abc"]
    v = v + np.where(np.sum(q * q, -1) <= 1.0, ELL["v"], 0.0)
    for m in MARKS.values():
        d = p - m
        v = v + np.where(np.sum(d * d, -1) <= MARK_R ** 2, MARK_V, 0.0)
    return v


def rot(axis, deg):
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    if axis == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def iop_from_rotation(R):
    """標準 axial（列方向 = +x, 行方向 = +y）を R で回した IOP（6 要素）"""
    return list(map(float, R @ np.array([1.0, 0, 0]))) + list(map(float, R @ np.array([0, 1.0, 0])))


# ── シリーズ定義 ──
STD = [1, 0, 0, 0, 1, 0]
R_OBL = rot("z", 25) @ rot("x", 15) @ rot("y", 10)
TILT = math.radians(15)


def series_defs():
    dz_aniso = 2.5
    miss = [k * dz_aniso for k in range(48)]
    del miss[20]                                # 1 枚欠損（20 枚目）
    irr, z = [], 0.0
    pat = [2.0, 3.5, 2.5, 3.0, 2.0, 3.5]
    for k in range(48):
        irr.append(z)
        z += pat[k % len(pat)]
    return [
        dict(id="g0_iso", rows=96, cols=96, row_mm=1.0, col_mm=1.0, iop=STD, z=[k * 1.0 for k in range(96)]),
        dict(id="g1_aniso", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=STD, z=[k * 2.5 for k in range(48)]),
        dict(id="g2_oblique", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=iop_from_rotation(R_OBL),
             z=[k * 2.5 for k in range(48)]),
        dict(id="g3_tilt", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=STD, z=[k * 2.5 for k in range(48)],
             step_dir=[0.0, math.sin(TILT), math.cos(TILT)]),
        dict(id="g4_missing", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=STD, z=miss),
        dict(id="g4_irregular", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=STD, z=irr),
        dict(id="g5_reversed", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=STD,
             z=[k * 2.5 for k in range(48)], reverse=True),
        dict(id="g8_calib", rows=110, cols=160, row_mm=0.9, col_mm=0.6, iop=STD, z=[k * 2.5 for k in range(48)],
             slope=0.37, intercept=-1024.0, unsigned=True),
    ]


def write_series(sd, study, frame):
    iop = np.array(sd["iop"], float)
    rc, rr = iop[:3], iop[3:]                       # 列が進む向き・行が進む向き
    normal = np.cross(rc, rr)
    step_dir = np.array(sd.get("step_dir", normal), float)   # スライスが進む向き（チルトでは法線と異なる）
    zs = np.array(sd["z"], float)                   # 先頭スライスからの進み量（step_dir に沿った mm）
    rows, cols, row_mm, col_mm = sd["rows"], sd["cols"], sd["row_mm"], sd["col_mm"]
    slope, intercept = sd.get("slope", 1.0), sd.get("intercept", 0.0)
    unsigned = sd.get("unsigned", False)
    # 格子の中心が C0 に来るよう、先頭スライスの IPP を決める
    zc = 0.5 * (zs[0] + zs[-1])
    origin = (C0 - zc * step_dir - 0.5 * (cols - 1) * col_mm * rc - 0.5 * (rows - 1) * row_mm * rr)
    jj, ii = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    inplane = ii[..., None] * col_mm * rc + jj[..., None] * row_mm * rr
    series_uid = new_uid()
    d = os.path.join(out, sd["id"])
    os.makedirs(d, exist_ok=True)
    order = list(range(len(zs)))
    if sd.get("reverse"):
        order = order[::-1]                         # 位置の減る順に並べる（InstanceNumber は昇順）
    ipps, expected, sops = [], [], []
    for n, k in enumerate(order):
        ipp = origin + zs[k] * step_dir
        pos = ipp + inplane
        v = field(pos)
        stored = np.rint((v - intercept) / slope)
        lo, hi = (0, 65535) if unsigned else (-32768, 32767)
        assert stored.min() >= lo and stored.max() <= hi, (sd["id"], stored.min(), stored.max())
        stored = stored.astype(np.uint16 if unsigned else np.int16)
        meta = FileMetaDataset()
        sop = new_uid()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series_uid, frame
        ds.PatientName, ds.PatientID = "Phantom^GeomVerify", "GEOMV-" + sd["id"].upper()
        ds.PatientBirthDate, ds.PatientSex = "19700101", "O"
        ds.StudyDate = ds.SeriesDate = "20261111"
        ds.StudyTime = ds.SeriesTime = "120000"
        ds.Modality = "CT"
        ds.SeriesDescription = "GEOMV " + sd["id"]
        ds.SeriesNumber, ds.InstanceNumber = 1, n + 1
        ds.ImageOrientationPatient = [float(x) for x in iop]
        ds.ImagePositionPatient = [float(x) for x in ipp]
        if len(zs) > 1:
            gaps = np.abs(np.diff(zs))
            ds.SliceThickness = float(np.min(gaps))   # 公称。不等間隔では代表値にならない（意図的）
        ds.PixelSpacing = [row_mm, col_mm]
        ds.Rows, ds.Columns = rows, cols
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
        ds.PixelRepresentation = 0 if unsigned else 1
        ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = slope, intercept, "HU"
        ds.PixelData = stored.tobytes()
        ds.save_as(os.path.join(d, "ct%03d.dcm" % n), enforce_file_format=True)
        ipps.append([float(x) for x in ipp])
        expected.append(stored)
        sops.append(str(sop))
    # ── 自己検証 ──
    assert abs(np.linalg.norm(rc) - 1) < 1e-9 and abs(np.linalg.norm(rr) - 1) < 1e-9, "IOP norm"
    assert abs(float(np.dot(rc, rr))) < 1e-9, "IOP orthogonal"
    for n in range(len(order)):
        ds = pydicom.dcmread(os.path.join(d, "ct%03d.dcm" % n))
        assert np.allclose([float(x) for x in ds.ImagePositionPatient], ipps[n], atol=1e-6), "IPP"
        assert np.array_equal(ds.pixel_array, expected[n]), "pixels"
        pos = np.array(ipps[n]) + inplane
        err = np.max(np.abs(ds.pixel_array * slope + intercept - field(pos)))
        assert err <= slope / 2 + 1e-9, ("values", err)
    # IPP 差と法線の内積（スライス間隔の実距離）
    nrm = [float(np.dot(np.array(ipps[n + 1]) - np.array(ipps[n]), normal)) for n in range(len(ipps) - 1)]
    # 表面ボクセル数の上限: 物体表面の面積 / 最小ボクセル断面積 のオーダー。体積の離散化誤差の上限に使う
    vox = row_mm * col_mm * float(np.min(np.abs(np.diff(zs))) if len(zs) > 1 else 1.0)
    return {
        "id": sd["id"], "dir": sd["id"], "seriesUid": str(series_uid),
        "rows": rows, "cols": cols, "pixelSpacing": [row_mm, col_mm],
        "iop": [float(x) for x in iop], "normal": [float(x) for x in normal],
        "stepDir": [float(x) for x in step_dir],
        "ipps": ipps, "sops": sops, "normalGapsMm": nrm, "reversed": bool(sd.get("reverse")),
        "rescale": {"slope": slope, "intercept": intercept, "unsigned": unsigned},
        "minVoxelVolumeMm3": vox,
    }


study, frame = new_uid(), new_uid()
series = [write_series(sd, study, frame) for sd in series_defs()]
# 実機型のガントリチルト: IOP の行方向が傾き（列 = +x, 行 = (0,cosθ,sinθ)）、IPP は +Z へ進む。既存シリーズは変えず別キーに入れる。
series_extra = [write_series(
    dict(id="g3b_tilt_iop", rows=110, cols=160, row_mm=0.9, col_mm=0.6,
         iop=[1.0, 0.0, 0.0, 0.0, math.cos(TILT), math.sin(TILT)], z=[k * 2.5 for k in range(48)],
         step_dir=[0.0, 0.0, 1.0]), study, frame)]

truth = {
    "coordinateSystem": "DICOM patient LPS, mm. Voxel center sampling (no partial volume).",
    "field": {"A": A, "B": B, "C": C, "D": D, "note": "v0 = A*x + B*y + C*z + D"},
    "center": list(C0),
    "sphere": {"center": list(SPH["center"]), "radiusMm": SPH["r"], "addedValue": SPH["v"],
               "volumeMm3": 4 / 3 * math.pi * SPH["r"] ** 3},
    "ellipsoid": {"center": list(ELL["center"]), "semiAxesMm": list(ELL["abc"]), "addedValue": ELL["v"],
                  "volumeMm3": 4 / 3 * math.pi * float(np.prod(ELL["abc"]))},
    "markers": {k: {"center": list(v), "radiusMm": MARK_R, "addedValue": MARK_V} for k, v in MARKS.items()},
    "distancesMm": {
        "M0-M1": float(np.linalg.norm(MARKS["M0"] - MARKS["M1"])),
        "M0-M2": float(np.linalg.norm(MARKS["M0"] - MARKS["M2"])),
        "M0-M3": float(np.linalg.norm(MARKS["M0"] - MARKS["M3"])),
        "M1-M3": float(np.linalg.norm(MARKS["M1"] - MARKS["M3"])),
    },
    "angleAtM0_M1_M3_deg": float(math.degrees(math.acos(
        np.dot(MARKS["M1"] - MARKS["M0"], MARKS["M3"] - MARKS["M0"])
        / np.linalg.norm(MARKS["M1"] - MARKS["M0"]) / np.linalg.norm(MARKS["M3"] - MARKS["M0"])))),
    "studyUid": str(study),
    "series": series,
    "seriesExtra": series_extra,
}
with open(os.path.join(out, "truth.json"), "w") as fh:
    json.dump(truth, fh, indent=1)
print("ok", out, [s["id"] for s in series])

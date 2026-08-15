#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-XA)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
GNBP-XA — GRAPHY-Next Benchmark Phantom, X-ray angiography series.

`fw/angio-design.md` §16.3。**アンギオ機能の検証の本命**。

なぜ要るのか
------------
公開されている冠動脈アンギオのデータセットは、そのほとんどが患者情報除去のため
**DICOM から PNG / npz へ変換済み**で配布されており、`ImagerPixelSpacing` /
`DistanceSourceTo*` / `PositionerPrimaryAngle` といった**幾何タグが失われている**。
実 DICOM が手に入る Rubo のサンプルも、確認したところ空間校正タグを一切持たない。

つまり **QCA の精度も、空間校正の分岐も、公開実データでは検証できない**。
実データで言えるのは「動くこと」「数値が内部整合すること」までで、
実際そこで止まっていた（設計 §8.5）。真値既知のファントムだけがこの壁を越えられる。

生成する系列
------------
    GNBP-XA-1   QCA 精度。既知径 3.0mm の直管に既知 %DS・既知長の狭窄。11 フレーム
    GNBP-XA-2   DSA。背景（骨相当）＋マスク 5 フレーム＋造影 20 フレーム、**既知の平行移動**を注入
    GNBP-XA-4   空間校正。既知外径のカテーテル＋**タグの書かれ方 4 変種**

GNBP-XA-3（2D→3D 再構成）は **A6 が未実装なので作らない**。使う側が無い状態で
生成しても、検証されないデータが増えるだけになる。A6 に着手するときにここへ足す。

物理モデル
----------
ビール則の順投影。造影剤で満たされた半径 r(x) の円柱に、軸から横方向 d だけ離れた
位置を通る線束の経路長は L = 2√(r² − d²)。透過強度 I = I0·exp(−μL) を
MONOCHROME2 で格納する（＝**血管は暗い**。実 XA と同じ向き）。

🚨 **円柱投影に対して半値法は幾何学的な直径を返さない**
------------------------------------------------------
弱吸収近似 exp(−x) ≈ 1−x では、プロファイルは p(d) ∝ −√(r²−d²) の形になる。
内側（d=0）と外側（背景）の中間値をよぎるのは √(r²−d²) = r/2、すなわち

    d = (√3/2)·r ≈ 0.866·r

であって **d = r ではない**。ぼけの無い理想投影では、半値法は直径を約 13% 過小に測る。
実機ではこれが焦点サイズと検出器 MTF によるぼけで押し戻される（ぼけると半値点は
外側の真のエッジへ寄る）。よってこのファントムは**ぼけを入れた版と入れない版の両方**を
持ち、その差そのものを測れるようにしてある（フレーム 8）。

%DS は MLD/RVD の**比**なので、径が一律の係数で偏っても打ち消される。打ち消されずに
残るのは「係数が半径に依存する」ぶん、つまりぼけ σ と半径の比が狭窄部と参照部で
違うことによる誤差 —— それがこのファントムで測りたい量。

再現性
------
既存の GNBP と同じ作法。UID は固定ルート＋パラメータの SHA-256、ノイズは固定シード、
Implementation Class UID も固定。同じコマンドで**バイト単位で同じ**ものが出る。

使い方:
    python3 make_phantom_xa.py --out ./phantom
    python3 make_phantom_xa.py --out ./phantom --series qca --force
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

from dicom_io import IMPLEMENTATION_CLASS_UID, deterministic_uid

XA_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.12.1"

# ── 幾何（すべての系列で共通）─────────────────────────────────────────
COLUMNS = 512
ROWS = 512
IMAGER_SPACING_MM = 0.30       # 検出器面の画素ピッチ（ImagerPixelSpacing）
SID_MM = 1000.0                # 線源→検出器
SOD_MM = 750.0                 # 線源→患者（アイソセンタ）
#: アイソセンタ面での mm/px。§7.2 の P4（幾何近似）が返すべき値そのもの。
MM_PER_PX = IMAGER_SPACING_MM * SOD_MM / SID_MM   # = 0.225

# ── 造影剤と背景 ──────────────────────────────────────────────────────
#: 造影剤の線減弱係数 [1/mm]。3mm 径の中心で exp(-0.5)=0.61 ＝ 約 39% 減衰。
MU_CONTRAST = 1.0 / 6.0
#: 12bit で格納する（実機の XA と同じ）。
STORED_MAX = 4095

REFERENCE_DIAMETER_MM = 3.0
#: 検出器ぼけ（焦点サイズ＋検出器 MTF）の標準偏差 [検出器 px]。
DEFAULT_BLUR_PX = 0.6
#: 面積平均の細分割数（1 画素を SUPERSAMPLE² 個に割って平均する）。
SUPERSAMPLE = 4


def _gaussian_blur(image: np.ndarray, sigma_px: float) -> np.ndarray:
    """分離可能ガウシアンで畳み込む（scipy を増やさないための自前実装）。

    🚨 端は**値の複製**で埋める。`np.convolve(mode="same")` は 0 で埋めるので、
    そのままだと画像の縁が暗くなる（透過率 1.0 の背景が縁だけ 0.5 に落ちる）。
    最初にこれを踏み、中心行の最小値が理論値より小さいことで気づいた。
    """
    if sigma_px <= 0:
        return image
    radius = max(1, int(np.ceil(3.0 * sigma_px)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-0.5 * (x / sigma_px) ** 2)
    k /= k.sum()

    def blur_1d(m: np.ndarray) -> np.ndarray:
        padded = np.pad(m, radius, mode="edge")
        return np.convolve(padded, k, mode="same")[radius:-radius]

    out = np.apply_along_axis(blur_1d, 1, image)
    out = np.apply_along_axis(blur_1d, 0, out)
    return out


def _radius_profile(
    x_mm: np.ndarray,
    percent_stenosis: float,
    lesion_length_mm: float,
    reference_diameter_mm: float,
) -> np.ndarray:
    """軸位置 x [mm] における血管半径 [mm]。狭窄は余弦テーパー。

    病変長の真値は「径が参照径を下回る区間の長さ」＝ ``lesion_length_mm``。
    余弦テーパーは区間の端でちょうど参照径に戻るので、この定義と一致する。
    """
    r_ref = reference_diameter_mm / 2.0
    r = np.full_like(x_mm, r_ref)
    if percent_stenosis <= 0 or lesion_length_mm <= 0:
        return r
    r_min = r_ref * (1.0 - percent_stenosis / 100.0)
    half = lesion_length_mm / 2.0
    d = np.abs(x_mm)
    inside = d < half
    f = 0.5 * (1.0 + np.cos(np.pi * d[inside] / half))
    r[inside] = r_ref - (r_ref - r_min) * f
    return r


def _project_vessel(
    percent_stenosis: float,
    lesion_length_mm: float,
    *,
    blur_px: float,
    axis_row: float = ROWS / 2.0,
    reference_diameter_mm: float = REFERENCE_DIAMETER_MM,
) -> np.ndarray:
    """血管 1 本の透過率画像（0..1、背景 1.0）を作る。

    面積平均で SUPERSAMPLE² 倍に細分割してから 1 画素へ落とす。実機の画素は
    有限面積の積分なので、これをやらないとエッジが階段になり、サブピクセル
    エッジ検出の精度がファントム側の都合で決まってしまう。
    """
    n = SUPERSAMPLE
    # 細分割格子の中心座標（画素中心が整数座標）。
    sub = (np.arange(n) + 0.5) / n - 0.5
    cols = (np.arange(COLUMNS)[:, None] + sub[None, :]).ravel()
    rows = (np.arange(ROWS)[:, None] + sub[None, :]).ravel()

    x_mm = (cols - COLUMNS / 2.0) * MM_PER_PX          # 血管軸方向 [mm]
    d_mm = (rows - axis_row) * MM_PER_PX               # 軸からの横ずれ [mm]

    r = _radius_profile(x_mm, percent_stenosis, lesion_length_mm, reference_diameter_mm)  # (COLUMNS*n,)
    # 経路長 L(d, x) = 2√(r(x)² − d²)
    inner = r[None, :] ** 2 - d_mm[:, None] ** 2
    np.maximum(inner, 0.0, out=inner)
    path_mm = 2.0 * np.sqrt(inner)                     # (ROWS*n, COLUMNS*n)

    transmit = np.exp(-MU_CONTRAST * path_mm)
    # 面積平均で 1 画素へ。
    transmit = transmit.reshape(ROWS, n, COLUMNS, n).mean(axis=(1, 3))
    return _gaussian_blur(transmit, blur_px)


def _to_stored(transmit: np.ndarray, photons: float | None, rng: np.random.Generator) -> np.ndarray:
    """透過率 → 12bit 格納値。``photons`` を与えるとポアソンノイズを載せる。"""
    if photons is None:
        values = transmit * STORED_MAX
    else:
        counts = rng.poisson(np.clip(transmit, 0.0, None) * photons)
        values = counts / photons * STORED_MAX
    return np.clip(np.rint(values), 0, STORED_MAX).astype(np.uint16)


def _xa_dataset(
    frames: np.ndarray,
    *,
    uid_key: str,
    study_key: str,
    series_description: str,
    series_number: int,
    frame_time_ms: float,
    patient_id: str,
    patient_name: str,
    calibration=None,
    include_geometry: bool = True,
) -> Dataset:
    """マルチフレーム XA インスタンスを組む。

    ``calibration`` は ``(pixel_spacing_mm, calibration_type)``。None なら
    ``PixelSpacing`` を書かない（＝ §7.2 の P4 以降へ落ちる）。
    ``include_geometry=False`` は SID/SOD も落とす（P6/P7 の確認用）。
    """
    n_frames = int(frames.shape[0])
    sop_uid = deterministic_uid("GNBP-XA", uid_key, "sop")

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = XA_IMAGE_STORAGE
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = IMPLEMENTATION_CLASS_UID

    ds = Dataset()
    ds.file_meta = meta
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.preamble = b"\0" * 128

    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.SOPClassUID = XA_IMAGE_STORAGE
    ds.SOPInstanceUID = sop_uid
    ds.Modality = "XA"
    ds.PatientID = patient_id
    ds.PatientName = patient_name
    ds.PatientBirthDate = "19700101"
    ds.PatientSex = "O"
    ds.StudyInstanceUID = deterministic_uid("GNBP-XA", study_key, "study")
    ds.SeriesInstanceUID = deterministic_uid("GNBP-XA", uid_key, "series")
    ds.StudyID = "GNBPXA"
    ds.AccessionNumber = "GNBPXA"
    ds.StudyDate = "20260101"
    ds.StudyTime = "120000"
    ds.SeriesDate = "20260101"
    ds.SeriesTime = "120000"
    ds.ContentDate = "20260101"
    ds.ContentTime = "120000"
    ds.StudyDescription = "GNBP-XA benchmark phantom"
    ds.SeriesDescription = series_description
    ds.SeriesNumber = series_number
    ds.InstanceNumber = 1
    ds.Manufacturer = "Visionary Imaging Services"
    ds.ManufacturerModelName = "GNBP-XA"
    ds.SoftwareVersions = "GNBP-XA/1"

    # ── 画像 ──────────────────────────────────────────────────────────
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = ROWS
    ds.Columns = COLUMNS
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = n_frames
    ds.PixelData = frames.astype("<u2").tobytes()

    # 時間軸（fps 連鎖の P2 を通す）。
    ds.FrameTime = f"{frame_time_ms:.3f}"
    ds.FrameIncrementPointer = 0x00181063  # FrameTime
    ds.CineRate = int(round(1000.0 / frame_time_ms))

    # 実 XA と同じく WindowCenter/Width は書かない（持たない装置が多い）。
    ds.PixelIntensityRelationship = "LIN"
    ds.PixelIntensityRelationshipSign = 1

    # ── 幾何 ──────────────────────────────────────────────────────────
    ds.ImagerPixelSpacing = [f"{IMAGER_SPACING_MM:.6f}", f"{IMAGER_SPACING_MM:.6f}"]
    if include_geometry:
        ds.DistanceSourceToDetector = f"{SID_MM:.1f}"
        ds.DistanceSourceToPatient = f"{SOD_MM:.1f}"
        ds.EstimatedRadiographicMagnificationFactor = f"{SID_MM / SOD_MM:.6f}"
    ds.PositionerPrimaryAngle = "0.0"
    ds.PositionerSecondaryAngle = "0.0"
    ds.KVP = "80"
    ds.ExposureTime = "8"

    if calibration is not None:
        spacing_mm, calib_type = calibration
        ds.PixelSpacing = [f"{spacing_mm:.6f}", f"{spacing_mm:.6f}"]
        if calib_type is not None:
            ds.PixelSpacingCalibrationType = calib_type
            ds.PixelSpacingCalibrationDescription = f"GNBP-XA synthetic ({calib_type})"
    return ds


def _save(ds: Dataset, path: str) -> None:
    ds.save_as(path, enforce_file_format=True)


def _file_md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ══════════════════════════════════════════════════════════════════════
# GNBP-XA-1 — QCA 精度
# ══════════════════════════════════════════════════════════════════════

#: (%DS, 病変長 mm, ぼけ σ px, I0 光子数 or None)
QCA_FRAMES = [
    (0.0, 0.0, DEFAULT_BLUR_PX, None),
    (30.0, 10.0, DEFAULT_BLUR_PX, None),
    (50.0, 10.0, DEFAULT_BLUR_PX, None),
    (70.0, 10.0, DEFAULT_BLUR_PX, None),
    (90.0, 10.0, DEFAULT_BLUR_PX, None),
    (50.0, 5.0, DEFAULT_BLUR_PX, None),
    (50.0, 20.0, DEFAULT_BLUR_PX, None),
    (50.0, 10.0, 0.0, None),          # ★ぼけ無し: 半値法の系統誤差を単離する
    (50.0, 10.0, DEFAULT_BLUR_PX, 20000.0),
    (50.0, 10.0, DEFAULT_BLUR_PX, 4000.0),
    (50.0, 10.0, DEFAULT_BLUR_PX, 800.0),
]


def build_qca(out_dir: str) -> dict:
    rng = np.random.default_rng(20260815)
    frames = np.zeros((len(QCA_FRAMES), ROWS, COLUMNS), dtype=np.uint16)
    truth_frames = []
    for i, (pct, length, blur, photons) in enumerate(QCA_FRAMES):
        transmit = _project_vessel(pct, length, blur_px=blur)
        frames[i] = _to_stored(transmit, photons, rng)
        r_ref = REFERENCE_DIAMETER_MM / 2.0
        mld = 2.0 * r_ref * (1.0 - pct / 100.0) if pct > 0 else REFERENCE_DIAMETER_MM
        truth_frames.append(
            {
                "frame": i + 1,
                "percentDiameterStenosis": pct,
                "percentAreaStenosis": (1.0 - (1.0 - pct / 100.0) ** 2) * 100.0,
                "referenceDiameterMm": REFERENCE_DIAMETER_MM,
                "mldMm": mld,
                "lesionLengthMm": length,
                "blurSigmaPx": blur,
                "photonsPerPixel": photons,
            }
        )

    ds = _xa_dataset(
        frames,
        uid_key="XA-1",
        study_key="XA-1",
        series_description="GNBP-XA-1 QCA accuracy",
        series_number=1,
        frame_time_ms=33.0,
        patient_id="GNBP-XA-1",
        patient_name="GNBPXA^QCA",
        # 装置が正しく校正した状態（P1）。QCA の精度だけを見たいので校正は既知にしておく。
        calibration=(MM_PER_PX, "GEOMETRY"),
    )
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "GNBP-XA-1.dcm")
    _save(ds, path)
    return {
        "sopInstanceUid": ds.SOPInstanceUID,
        "studyInstanceUid": ds.StudyInstanceUID,
        "seriesInstanceUid": ds.SeriesInstanceUID,
        "file": os.path.basename(path),
        "md5": _file_md5(path),
        "rows": ROWS,
        "columns": COLUMNS,
        "vesselAxisRow": ROWS / 2.0,
        "mmPerPx": MM_PER_PX,
        "muContrastPerMm": MU_CONTRAST,
        "frames": truth_frames,
    }


# ══════════════════════════════════════════════════════════════════════
# GNBP-XA-2 — DSA
# ══════════════════════════════════════════════════════════════════════

#: マスク（造影前）フレーム数と造影フレーム数。
DSA_MASK_FRAMES = 5
DSA_CONTRAST_FRAMES = 20
#: 造影フレームに注入する体動 [検出器 px]。フレーム番号 → (dx, dy)。
DSA_SHIFTS = {6: (0.0, 0.0), 15: (3.0, -2.0), 25: (-4.0, 5.0)}


def _background(shift_x: float, shift_y: float) -> np.ndarray:
    """骨に相当する高減衰の背景（斜めの帯 2 本＋緩い勾配）。

    DSA の意味は「造影以外を消す」ことなので、**背景は造影フレームでも同じ形**で
    なければならない。体動はこの背景ごと平行移動する（実際の体動と同じ）。
    """
    yy, xx = np.mgrid[0:ROWS, 0:COLUMNS].astype(np.float64)
    yy = yy - shift_y
    xx = xx - shift_x
    thickness = np.zeros((ROWS, COLUMNS), dtype=np.float64)
    for offset, width, mu_mm in ((-60.0, 34.0, 0.9), (110.0, 26.0, 1.2)):
        d = np.abs((yy - 0.55 * xx) - (ROWS / 2.0 + offset))
        thickness += mu_mm * np.clip(1.0 - d / width, 0.0, 1.0)
    # 体厚のゆるい変化（左右で透過が違う）。
    thickness += 0.35 * (xx / COLUMNS)
    return np.exp(-thickness)


def build_dsa(out_dir: str) -> dict:
    rng = np.random.default_rng(20260816)
    n = DSA_MASK_FRAMES + DSA_CONTRAST_FRAMES
    frames = np.zeros((n, ROWS, COLUMNS), dtype=np.uint16)
    shifts = []
    for i in range(n):
        frame_no = i + 1
        dx, dy = 0.0, 0.0
        for start, (sx, sy) in sorted(DSA_SHIFTS.items()):
            if frame_no >= start:
                dx, dy = sx, sy
        shifts.append({"frame": frame_no, "dxPx": dx, "dyPx": dy})
        bg = _background(dx, dy)
        if frame_no <= DSA_MASK_FRAMES:
            transmit = bg
        else:
            # 造影は 6 フレームかけて立ち上がり、以後一定（ボーラス到達）。
            ramp = min(1.0, (frame_no - DSA_MASK_FRAMES) / 6.0)
            vessel = _project_vessel(50.0, 10.0, blur_px=DEFAULT_BLUR_PX, axis_row=ROWS / 2.0 + dy)
            # 透過率どうしの積＝減弱の足し算（ビール則）。造影ぶんだけ ramp で効かせる。
            transmit = bg * (vessel ** ramp)
        frames[i] = _to_stored(transmit, 8000.0, rng)

    ds = _xa_dataset(
        frames,
        uid_key="XA-2",
        study_key="XA-2",
        series_description="GNBP-XA-2 DSA with known motion",
        series_number=2,
        frame_time_ms=66.0,
        patient_id="GNBP-XA-2",
        patient_name="GNBPXA^DSA",
        calibration=(MM_PER_PX, "GEOMETRY"),
    )
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "GNBP-XA-2.dcm")
    _save(ds, path)
    return {
        "sopInstanceUid": ds.SOPInstanceUID,
        "studyInstanceUid": ds.StudyInstanceUID,
        "seriesInstanceUid": ds.SeriesInstanceUID,
        "file": os.path.basename(path),
        "md5": _file_md5(path),
        "maskFrames": list(range(1, DSA_MASK_FRAMES + 1)),
        "contrastArrivalFrame": DSA_MASK_FRAMES + 1,
        "photonsPerPixel": 8000.0,
        "shifts": shifts,
    }


# ══════════════════════════════════════════════════════════════════════
# GNBP-XA-4 — 空間校正のフォールバック連鎖（§7.2）
# ══════════════════════════════════════════════════════════════════════

#: 校正の確認に使うカテーテルの外径 [mm]（6Fr = 2.0mm）。
CATHETER_FR = 6.0
CATHETER_OUTER_MM = CATHETER_FR / 3.0

#: (キー, PixelSpacing, CalibrationType, SID/SOD を書くか, 期待する source)
CALIB_VARIANTS = [
    ("a-fiducial", MM_PER_PX, "FIDUCIAL", True, "dicom-fiducial"),
    ("b-geometry", MM_PER_PX, "GEOMETRY", True, "dicom-geometry"),
    # ③ PixelSpacing == ImagerPixelSpacing。規格の明文で「未校正」なので降格し、
    #    SID/SOD があるので幾何近似（P4）へ落ちるのが正しい。
    ("c-equals-imager", IMAGER_SPACING_MM, None, True, "geometric-sid-sod"),
    # ④ PixelSpacing 無し。ImagerPixelSpacing ＋ SID/SOD だけ → P4。
    ("d-geometry-only", None, None, True, "geometric-sid-sod"),
    # ⑤ 幾何タグも無い（実データの Rubo がこれ）→ P6。**px 表示が正しい挙動**。
    ("e-nothing", None, None, False, "detector-plane"),
]


def build_calibration(out_dir: str) -> dict:
    """カテーテル（既知外径）と血管を並べた 1 フレームを、タグ違いで 5 本書く。

    画像の中身は 5 本とも**同一**にしてある。違うのはタグだけなので、
    「同じ画素から違う mm が出るか」で §7.2 の分岐を切り分けられる。
    """
    rng = np.random.default_rng(20260817)
    # 血管（3.0mm・アイソセンタ）と、その下にカテーテル（2.0mm 外径・造影より濃い）。
    vessel = _project_vessel(0.0, 0.0, blur_px=DEFAULT_BLUR_PX, axis_row=ROWS / 2.0 - 60.0)
    catheter = _project_vessel(
        0.0, 0.0, blur_px=DEFAULT_BLUR_PX,
        axis_row=ROWS / 2.0 + 60.0,
        reference_diameter_mm=CATHETER_OUTER_MM,
    )
    transmit = vessel * catheter
    frame = _to_stored(transmit, None, rng)[None, :, :]

    os.makedirs(out_dir, exist_ok=True)
    variants = []
    for i, (key, spacing, calib_type, geometry, expected) in enumerate(CALIB_VARIANTS):
        ds = _xa_dataset(
            frame,
            uid_key=f"XA-4-{key}",
            study_key="XA-4",
            series_description=f"GNBP-XA-4 calibration {key}",
            series_number=40 + i,
            frame_time_ms=40.0,
            patient_id="GNBP-XA-4",
            patient_name="GNBPXA^CALIB",
            calibration=None if spacing is None else (spacing, calib_type),
            include_geometry=geometry,
        )
        path = os.path.join(out_dir, f"GNBP-XA-4-{key}.dcm")
        _save(ds, path)
        variants.append(
            {
                "key": key,
                "file": os.path.basename(path),
                "md5": _file_md5(path),
                "sopInstanceUid": ds.SOPInstanceUID,
                "seriesInstanceUid": ds.SeriesInstanceUID,
                "pixelSpacingMm": spacing,
                "pixelSpacingCalibrationType": calib_type,
                "hasSidSod": geometry,
                "expectedSource": expected,
                # 期待する mm/px。P6（e-nothing）は「mm を出さない」が正解なので null。
                "expectedMmPerPx": None if expected == "detector-plane" else MM_PER_PX,
            }
        )
    return {
        "studyInstanceUid": deterministic_uid("GNBP-XA", "XA-4", "study"),
        "catheterFr": CATHETER_FR,
        "catheterOuterDiameterMm": CATHETER_OUTER_MM,
        "catheterAxisRow": ROWS / 2.0 + 60.0,
        "vesselDiameterMm": REFERENCE_DIAMETER_MM,
        "vesselAxisRow": ROWS / 2.0 - 60.0,
        "mmPerPx": MM_PER_PX,
        "variants": variants,
    }


# ══════════════════════════════════════════════════════════════════════

BUILDERS = {"qca": build_qca, "dsa": build_dsa, "calibration": build_calibration}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="./phantom", help="出力先ディレクトリ")
    ap.add_argument("--series", choices=sorted(BUILDERS), action="append", help="生成する系列（既定は全部）")
    ap.add_argument("--force", action="store_true", help="既存の出力を消してから生成する")
    args = ap.parse_args()

    out_root = os.path.join(args.out, "GNBP-XA")
    if args.force and os.path.isdir(out_root):
        shutil.rmtree(out_root)
    os.makedirs(out_root, exist_ok=True)

    wanted = args.series or sorted(BUILDERS)
    truth = {
        "phantom": "GNBP-XA",
        "design": "fw/angio-design.md §16.3",
        "geometry": {
            "rows": ROWS,
            "columns": COLUMNS,
            "imagerPixelSpacingMm": IMAGER_SPACING_MM,
            "distanceSourceToDetectorMm": SID_MM,
            "distanceSourceToPatientMm": SOD_MM,
            "mmPerPxAtIsocenter": MM_PER_PX,
        },
        "physics": {
            "model": "Beer-Lambert forward projection of a filled cylinder",
            "muContrastPerMm": MU_CONTRAST,
            "supersample": SUPERSAMPLE,
            "storedMax": STORED_MAX,
            "photometricInterpretation": "MONOCHROME2 (vessel is dark)",
            "halfMaxCaveat": (
                "For an unblurred cylinder projection the half-maximum crossing sits at "
                "sqrt(3)/2 * r ~= 0.866 r, not at r. Blur pushes it back out toward r. "
                "Frame 8 of GNBP-XA-1 is unblurred so this systematic effect can be isolated."
            ),
        },
    }
    for name in wanted:
        print(f"[GNBP-XA] {name} …", file=sys.stderr)
        truth[name] = BUILDERS[name](out_root)

    truth_path = os.path.join(out_root, "truth.json")
    with open(truth_path, "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=2, sort_keys=False)
    print(f"[GNBP-XA] wrote {out_root}", file=sys.stderr)
    for name in wanted:
        section = truth[name]
        if "md5" in section:
            print(f"  {section['file']}  md5 {section['md5']}", file=sys.stderr)
        else:
            for v in section.get("variants", []):
                print(f"  {v['file']}  md5 {v['md5']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

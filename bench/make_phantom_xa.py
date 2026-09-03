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
    GNBP-XA-3   2D→3D 再構成。既知の 3D 血管ツリーを既知角度で 4 方向へ順投影。
                **タグの角度に既知誤差を混ぜた版**も作る（バンドル調整が回収すべき量）
    GNBP-XA-4   空間校正。既知外径のカテーテル＋**タグの書かれ方 4 変種**
    GNBP-XA-6   QVA（末梢・脳血管）。既知径の直管に**既知の拡張（瘤）**。紡錘状／嚢状／
                軽度拡張／拡張無しの 6 フレーム
                （⚠️ XA-5 は設計 §16.3 で**左室ファントム**に予約済み。番号を使い回さない）

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
import math
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
    col_shift: float = 0.0,
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

    x_mm = (cols - COLUMNS / 2.0 - col_shift) * MM_PER_PX  # 血管軸方向 [mm]
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


def _dilated_profile(
    x_mm: np.ndarray,
    peak_diameter_mm: float,
    length_mm: float,
    reference_diameter_mm: float,
) -> tuple[np.ndarray, np.ndarray]:
    """瘤の半径 r(x) と軸のずれ c(x) を返す（どちらも [mm]）。

    膨らみは狭窄と同じ余弦テーパーの裏返しで、**区間の端でちょうど参照径に戻る**。
    したがって真値の「瘤長」は ``length_mm``（＝径が参照径を上回る区間）と一致する。

    嚢状（片側だけ）は ``c(x)`` を半径の増分の半分だけずらして作る。内腔は
    [-r_ref, +r_ref + 膨らみ] になり、**片方の壁は動かない**。
    """
    r_ref = reference_diameter_mm / 2.0
    r = np.full_like(x_mm, r_ref)
    c = np.zeros_like(x_mm)
    if peak_diameter_mm <= reference_diameter_mm or length_mm <= 0:
        return r, c
    half = length_mm / 2.0
    d = np.abs(x_mm)
    inside = d < half
    f = 0.5 * (1.0 + np.cos(np.pi * d[inside] / half))
    r[inside] = r_ref + (peak_diameter_mm / 2.0 - r_ref) * f
    return r, c


def _project_dilated(
    peak_diameter_mm: float,
    length_mm: float,
    *,
    saccular: bool,
    blur_px: float,
    axis_row: float = ROWS / 2.0,
    reference_diameter_mm: float = REFERENCE_DIAMETER_MM,
) -> np.ndarray:
    """瘤のある血管 1 本の透過率画像。``_project_vessel`` と同じ物理モデル。"""
    n = SUPERSAMPLE
    sub = (np.arange(n) + 0.5) / n - 0.5
    cols = (np.arange(COLUMNS)[:, None] + sub[None, :]).ravel()
    rows = (np.arange(ROWS)[:, None] + sub[None, :]).ravel()
    x_mm = (cols - COLUMNS / 2.0) * MM_PER_PX
    d_mm = (rows - axis_row) * MM_PER_PX

    r, c = _dilated_profile(x_mm, peak_diameter_mm, length_mm, reference_diameter_mm)
    if saccular:
        # 片側の壁を固定し、増えた分だけ軸をずらす（内腔の幅は同じ）。
        c = r - reference_diameter_mm / 2.0

    inner = r[None, :] ** 2 - (d_mm[:, None] - c[None, :]) ** 2
    np.maximum(inner, 0.0, out=inner)
    path_mm = 2.0 * np.sqrt(inner)
    transmit = np.exp(-MU_CONTRAST * path_mm)
    transmit = transmit.reshape(ROWS, n, COLUMNS, n).mean(axis=(1, 3))
    return _gaussian_blur(transmit, blur_px)


def _to_stored(
    transmit: np.ndarray,
    photons: float | None,
    rng: np.random.Generator,
    full_scale: float = STORED_MAX,
) -> np.ndarray:
    """透過率 → 12bit 格納値。``photons`` を与えるとポアソンノイズを載せる。

    🔴 ``full_scale`` は「透過率 1.0（＝素通し）を格納値のどこに置くか」。既定は最大値だが、
    **ノイズを載せるときは必ず下げる**。既定のままだと背景がちょうど飽和し、
    **ノイズの上半分が `clip` で消える**（実測: photons=40000 で σ が理論 20.5 → 11.9、
    平均も 4095 → 4086.8 に偏る・2026-09-02）。

    <p>これは実害がある。**エッジ検出も密度計測も「背景」を基準に取る**ので、
    基準の側だけノイズが片側に潰れていると、**ファントムが検出を有利にしてしまう**。
    ⚠️ 明るさの尺度が版ごとに変わるが、半値法も −lnT も**背景基準の相対量**なので測定値は動かない。
    """
    if photons is None:
        values = transmit * full_scale
    else:
        counts = rng.poisson(np.clip(transmit, 0.0, None) * photons)
        values = counts / photons * full_scale
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
    include_geometry=True,
) -> Dataset:
    """マルチフレーム XA インスタンスを組む。

    ``calibration`` は ``(pixel_spacing_mm, calibration_type)``。None なら
    ``PixelSpacing`` を書かない（＝ §7.2 の P4 以降へ落ちる）。

    ``include_geometry``:
        ``True``       … SID / SOD / 拡大率を書く（P4 が成立）
        ``False``      … 幾何タグを一切書かない（P6 / P7 の確認用）
        ``"mag-only"`` … **拡大率だけ**書く。SID/SOD が無い装置を模す＝ P5 だけが成立する枝。
                          これが無いと P5 は一度も通らない（P4 が先に成立してしまうため）。
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
    if include_geometry is True:
        ds.DistanceSourceToDetector = f"{SID_MM:.1f}"
        ds.DistanceSourceToPatient = f"{SOD_MM:.1f}"
        ds.EstimatedRadiographicMagnificationFactor = f"{SID_MM / SOD_MM:.6f}"
    elif include_geometry == "mag-only":
        # SID/SOD を書かず拡大率だけ。P4 が成立しないので P5 に落ちる。
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
#:
#: 🚨 **整数だけにしない。** 推定器は整数格子で粗探索してから 0.1px で詰めるので、
#: 整数の体動しか注入しないと**詰めの段が一度も試されない**まま「< 0.2px 達成」になる。
#: 22 以降の (1.4, -0.6) がその段を踏ませるためのもの。
#: 24 の dy=5 は**探索半径そのものを試す**（半径 4px の粗探索では届かない）。
DSA_SHIFTS = {6: (0.0, 0.0), 12: (3.0, -2.0), 17: (-4.0, 5.0), 22: (1.4, -0.6)}

#: 背景に置く局所的な高減衰（石灰化・椎弓根に相当）。(cx, cy, rx, ry, μ·mm)。
#: **点状の構造は、どちら向きの平行移動にも等しく効く**のでこれが要（下の警告）。
DSA_BLOBS = (
    (150.0, 150.0, 26.0, 20.0, 0.8),
    (330.0, 120.0, 18.0, 24.0, 0.7),
    (200.0, 380.0, 30.0, 22.0, 0.6),
    (390.0, 330.0, 20.0, 18.0, 0.9),
    (110.0, 270.0, 14.0, 14.0, 0.5),
)


def _background(shift_x: float, shift_y: float) -> np.ndarray:
    """骨に相当する高減衰の背景（斜めの帯・脊椎・局所の塊）。

    DSA の意味は「造影以外を消す」ことなので、**背景は造影フレームでも同じ形**で
    なければならない。体動はこの背景ごと平行移動する（実際の体動と同じ）。

    🚨 **斜めの帯だけで作ってはいけない**（2026-08-18 に実測して判明）。
    帯は帯の向きに**平行移動しても像が変わらない**ので、その向きの体動は
    画像から**原理的に回収できない**（アパーチャ問題）。旧版はこれで、
    帯に沿って 6px 動かしても残差が 6% しか動かず（＝ノイズと同程度）、
    推定器が何を返しても真値と 0.58px ずれていた。**推定器ではなくファントムの欠陥**で、
    この系列では「< 0.2px」を測ることが**そもそもできなかった**。
    §16.4 の箱型断面・§16.3 の回転楕円体と同じ形の罠（＝仮定に都合のよいファントム）。

    そこで **向きの違う構造を重ねる**: 斜めの帯（従来）＋縦の脊椎＋その縦方向の周期変調
    （椎体の切れ目）＋点状の塊。どの向きの平行移動にも残差が応答するようになる。
    その性質は `check_xa2_motion.py` が**毎回測って**確かめる（仮定しない）。

    実機と同じく**検出器ぼけを掛けてから**返す（掛けないと背景だけが理想的に鋭く、
    サブピクセル補間の誤差がファントム側の都合で決まってしまう）。
    """
    yy, xx = np.mgrid[0:ROWS, 0:COLUMNS].astype(np.float64)
    yy = yy - shift_y
    xx = xx - shift_x
    thickness = np.zeros((ROWS, COLUMNS), dtype=np.float64)
    # ① 肋骨に相当する斜めの帯 2 本。**帯に沿った向きだけは拘束しない**。
    for offset, width, mu_mm in ((-60.0, 34.0, 0.9), (110.0, 26.0, 1.2)):
        d = np.abs((yy - 0.55 * xx) - (ROWS / 2.0 + offset))
        thickness += mu_mm * np.clip(1.0 - d / width, 0.0, 1.0)
    # ② 脊椎に相当する縦の帯（＝横方向の平行移動を拘束する）と、
    #    椎体の切れ目に相当する縦方向の周期変調（＝縦方向を拘束する）。
    spine = np.clip(1.0 - np.abs(xx - (COLUMNS / 2.0 + 150.0)) / 46.0, 0.0, 1.0)
    thickness += 0.95 * spine * (0.55 + 0.45 * np.cos(2.0 * np.pi * yy / 58.0))
    # ③ 局所的な塊（石灰化・椎弓根）。向きを持たないので全方向に効く。
    for cx, cy, rx, ry, mu_mm in DSA_BLOBS:
        e = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        thickness += mu_mm * np.clip(1.0 - e, 0.0, 1.0)
    # ④ 体厚のゆるい変化（左右で透過が違う）。
    thickness += 0.35 * (xx / COLUMNS)
    return _gaussian_blur(np.exp(-thickness), DEFAULT_BLUR_PX)


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
            # 血管は体の中にあるので、背景と**同じだけ**動く（dx は軸方向なので狭窄の位置に効く）。
            vessel = _project_vessel(
                50.0, 10.0, blur_px=DEFAULT_BLUR_PX, axis_row=ROWS / 2.0 + dy, col_shift=dx,
            )
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
# GNBP-XA-3 — 2D→3D 再構成（§10 / A6）
# ══════════════════════════════════════════════════════════════════════
#
# 🚨 **直線や単純な円弧で作ってはいけない。**
# 三角測量は「対応点が正しく取れれば」厳密に解けるので、対応付けが自明な形状では
# 再構成器ではなく三角測量の式を検算しているだけになる（§16.3 の警告）。
# ここは **1.1 回転する先細りの螺旋 ＋ 分岐**:
#   - 投影で**自己交差する**（どの点とどの点が対応するかが自明でない）
#   - **曲率が場所で変わる**（一定曲率だと中心線抽出の誤差が均一になり実際と違う）
#   - 分岐がある（A6b の対応付けにも使える）
#
# ⚠️ **このファントムが検証できないもの**: 射影行列の DICOM 角度定義そのもの。
# 生成側と再構成側が同じ規約（下記 `_view_basis`）を共有しているので、**規約が
# 間違っていても一致してしまう**。角度定義の正しさは規格の読解と実機データでしか
# 確かめられない。ここで測れるのは「その規約のもとで三角測量とバンドル調整が
# 正しく働くか」まで。

#: 視点（PositionerPrimaryAngle, PositionerSecondaryAngle）[deg]。LAO+/CRA+。
RECON_VIEWS = [
    (-30.0, 0.0),    # RAO 30
    (60.0, 20.0),    # LAO 60 / CRA 20
    (-10.0, -30.0),  # RAO 10 / CAU 30
    (30.0, 30.0),    # LAO 30 / CRA 30
]
#: タグへ書く角度に混ぜる誤差 [deg]。**画像は真の角度で作り、タグだけ狂わせる**。
#: 装置の機械誤差（±2〜5°）と C アームのたわみを模す。バンドル調整が回収すべき量。
RECON_ANGLE_ERRORS = [(1.5, -1.0), (-2.5, 2.0), (3.0, 1.5), (-1.0, -2.5)]

#: ノイズ層（段 2b）。**形状も真値も a-exact と同一で、量子ノイズだけが違う。**
#:
#: 🔴 なぜ要るか: a-exact は**背景の標準偏差が 0.0000**（実測・2026-09-02）。実臨床の QCA は
#:    **エッジ検出の精度がノイズで決まる**ので、無ノイズのファントムだけで「精度」を語ると
#:    必ず楽観側に出る。文献の検証ファントム（Ishibashi ら）は実機で撮影しており、
#:    ノイズ・散乱・MTF を含んだ数字である。
#:
#: ⚠️ 見るのは**合否ではなく劣化の仕方**。急に壊れるなら、無ノイズでの合格は紙一重だった
#:    ということになる。
#:
#: 光子数の目安（背景の相対 σ ≒ 1/√photons）:
#:   40000 → 0.5%（十分に良い）／10000 → 1.0%（臨床相当）／2500 → 2.0%（厳しい）
RECON_NOISE_LEVELS = [("c-noise-low", 40000.0), ("d-noise-mid", 10000.0), ("e-noise-high", 2500.0)]

#: 3D 中心線の標本数（投影したとき隣接点が 1px 未満になる密度）。
RECON_SAMPLES = 900


def _view_basis(primary_deg: float, secondary_deg: float):
    """C アームの姿勢から、視線方向 d・画像の列方向 u・行方向 v・線源位置 S を作る。

    患者座標は **LPS 右手系**（X=左, Y=後, Z=頭）。
    DICOM の角度定義は primary=LAO 正（頭足軸まわり）、secondary=CRA 正（頭側へ振る）。

        d(α,β) = (sinα·cosβ, −cosα·cosβ, sinβ)      アイソセンタ → 検出器

    確認: α=β=0 で d=(0,−1,0)＝前方（PA 像）、α=90 で d=(1,0,0)＝患者の左、
    β=90 で d=(0,0,1)＝頭側。

    画像の向きは「正面像で患者の左が画像の右、頭が画像の上」に合わせる:
        u = normalize(z × d)   … 列方向（患者の左へ）
        v = u × d              … 行方向（足側へ）
    """
    a = np.radians(primary_deg)
    b = np.radians(secondary_deg)
    d = np.array([np.sin(a) * np.cos(b), -np.cos(a) * np.cos(b), np.sin(b)], dtype=np.float64)
    d /= np.linalg.norm(d)
    z = np.array([0.0, 0.0, 1.0])
    u = np.cross(z, d)
    n = np.linalg.norm(u)
    if n < 1e-9:
        # 真上/真下から見る縮退（β=±90）。列方向を患者の左に固定する。
        u = np.array([1.0, 0.0, 0.0])
    else:
        u = u / n
    v = np.cross(u, d)
    source = -d * SOD_MM
    return d, u, v, source


def _project_points(points_mm: np.ndarray, primary_deg: float, secondary_deg: float):
    """患者 LPS mm の点列 → 検出器画素座標 (col, row) と各点の拡大率 t=SID/(w·d)。"""
    d, u, v, source = _view_basis(primary_deg, secondary_deg)
    w = points_mm - source[None, :]
    denom = w @ d
    denom = np.where(np.abs(denom) < 1e-6, 1e-6, denom)
    t = SID_MM / denom
    q = source[None, :] + t[:, None] * w
    center = d * (SID_MM - SOD_MM)
    rel = q - center[None, :]
    col = (rel @ u) / IMAGER_SPACING_MM + COLUMNS / 2.0
    row = (rel @ v) / IMAGER_SPACING_MM + ROWS / 2.0
    return col, row, t


def _recon_tree():
    """既知の 3D 血管ツリー（患者 LPS mm）。主枝＝先細りの螺旋、0.45 から娘枝。"""
    t = np.linspace(0.0, 1.0, RECON_SAMPLES)
    theta = 2.2 * np.pi * t
    radius_mm = 30.0 - 12.0 * t                     # 螺旋の半径（曲率が場所で変わる）
    main = np.stack(
        [
            radius_mm * np.cos(theta) - 5.0,
            22.0 * np.sin(theta),
            40.0 - 70.0 * t,
        ],
        axis=1,
    )
    # 血管半径 [mm]: 1.75 → 1.00 のテーパー ＋ 50% 狭窄。
    r_main = 1.75 - 0.75 * t
    lesion_center, lesion_half, lesion_pct = 0.66, 0.045, 50.0
    dd = np.abs(t - lesion_center)
    inside = dd < lesion_half
    f = 0.5 * (1.0 + np.cos(np.pi * dd[inside] / lesion_half))
    r_main[inside] = r_main[inside] * (1.0 - (lesion_pct / 100.0) * f)

    i0 = int(0.45 * (RECON_SAMPLES - 1))
    origin = main[i0]
    tangent = main[i0 + 1] - main[i0 - 1]
    tangent /= np.linalg.norm(tangent)
    side = np.cross(tangent, np.array([0.0, 0.0, 1.0]))
    side /= np.linalg.norm(side)
    s = np.linspace(0.0, 1.0, RECON_SAMPLES // 2)
    direction = (tangent + side) / np.linalg.norm(tangent + side)
    bend = np.cross(direction, side)
    daughter = (
        origin[None, :]
        + 38.0 * s[:, None] * direction[None, :]
        + 9.0 * (s[:, None] ** 2) * bend[None, :]
    )
    r_daughter = 1.05 - 0.35 * s

    return [
        {"id": "main", "points": main, "radii": r_main},
        {"id": "daughter", "points": daughter, "radii": r_daughter},
    ]


def _project_tree(branches, primary_deg: float, secondary_deg: float, blur_px: float) -> np.ndarray:
    """3D ツリーの透過率画像（背景 1.0・血管が暗い）。

    各枝は「中心線標本ごとの円板の **最大**」で経路長を作り、枝どうしは **和**を取る。
    同じ枝の隣接標本は同じ管の断面なので足すと二重計上になるが、別の枝が重なる画素は
    本当に 2 本ぶん減弱する（実際の投影と同じ）。
    """
    n = 3  # 面積平均の細分割
    total_path = np.zeros((ROWS * n, COLUMNS * n), dtype=np.float64)
    for br in branches:
        col, row, t_ratio = _project_points(br["points"], primary_deg, secondary_deg)
        # 検出器 1px が物体面の何 mm か（点ごとの拡大率で変わる）。
        mm_per_px_at_point = IMAGER_SPACING_MM / t_ratio
        path = np.zeros_like(total_path)
        for i in range(len(col)):
            r_mm = float(br["radii"][i])
            mmpp = float(mm_per_px_at_point[i])
            rad = (r_mm / mmpp) * n
            cx = col[i] * n + (n - 1) / 2.0
            cy = row[i] * n + (n - 1) / 2.0
            x0 = max(0, int(np.floor(cx - rad)) - 1)
            y0 = max(0, int(np.floor(cy - rad)) - 1)
            x1 = min(COLUMNS * n, int(np.ceil(cx + rad)) + 2)
            y1 = min(ROWS * n, int(np.ceil(cy + rad)) + 2)
            if x1 <= x0 or y1 <= y0:
                continue
            yy, xx = np.mgrid[y0:y1, x0:x1]
            dist_mm = np.hypot(xx - cx, yy - cy) / n * mmpp
            inner = r_mm * r_mm - dist_mm * dist_mm
            np.maximum(inner, 0.0, out=inner)
            chord = 2.0 * np.sqrt(inner)
            np.maximum(path[y0:y1, x0:x1], chord, out=path[y0:y1, x0:x1])
        total_path += path
    transmit = np.exp(-MU_CONTRAST * total_path)
    transmit = transmit.reshape(ROWS, n, COLUMNS, n).mean(axis=(1, 3))
    return _gaussian_blur(transmit, blur_px)


def _polyline_length(points: np.ndarray) -> float:
    return float(np.sum(np.linalg.norm(np.diff(points, axis=0), axis=1)))


def build_recon3d(out_dir: str) -> dict:
    """4 方向の投影を**単一フレームの XA インスタンス**として書く（ランごとに別シリーズ）。"""
    rng = np.random.default_rng(20260818)
    branches = _recon_tree()
    os.makedirs(out_dir, exist_ok=True)

    views = []
    for i, (primary, secondary) in enumerate(RECON_VIEWS):
        transmit = _project_tree(branches, primary, secondary, DEFAULT_BLUR_PX)
        frame = _to_stored(transmit, None, rng)[None, :, :]
        err_p, err_s = RECON_ANGLE_ERRORS[i]
        view_entry = {
            "view": i + 1,
            "truePrimaryAngleDeg": primary,
            "trueSecondaryAngleDeg": secondary,
        }
        # 角度は真値のまま、**ノイズだけ**を変えた版（段 2b）。角度誤差版とは目的が違う。
        variants: list[tuple[str, float, float, float | None]] = [
            ("a-exact", primary, secondary, None),
            ("b-angle-error", primary + err_p, secondary + err_s, None),
        ]
        variants += [(name, primary, secondary, photons) for name, photons in RECON_NOISE_LEVELS]
        for suffix, tag_primary, tag_secondary, photons in variants:
            # 🔴 **透過率は同じものを使い、格納値だけ作り直す。** こうすると形状は 1 画素も
            #    変わらず、**ノイズだけが違う**——劣化の原因を切り分けられる。
            # 背景（透過率 1.0）を 5σ ぶん下げた位置に置き、ノイズの上側が飽和しないようにする。
            full_scale = STORED_MAX * (1.0 - 5.0 / math.sqrt(photons)) if photons else STORED_MAX
            variant_frame = (
                frame if photons is None else _to_stored(transmit, photons, rng, full_scale)[None, :, :]
            )
            ds = _xa_dataset(
                variant_frame,
                uid_key=f"XA-3-{suffix}-{i}",
                study_key=f"XA-3-{suffix}",
                series_description=f"GNBP-XA-3 {suffix} view{i + 1} ({primary:+.0f}/{secondary:+.0f})",
                series_number=(
                    (30 + i)
                    if suffix == "a-exact"
                    else (130 + i)
                    if suffix == "b-angle-error"
                    else (230 + 10 * next(k for k, (nm, _) in enumerate(RECON_NOISE_LEVELS) if nm == suffix) + i)
                ),
                frame_time_ms=40.0,
                patient_id=f"GNBP-XA-3-{suffix}",
                patient_name="GNBPXA^RECON3D",
                calibration=(MM_PER_PX, "GEOMETRY"),
            )
            # 🚨 **タグの角度だけ狂わせる**（画像は真の角度で作ってある）。
            #    素直にタグを信じると再投影誤差が残り、バンドル調整がそれを回収する。
            ds.PositionerPrimaryAngle = f"{tag_primary:.3f}"
            ds.PositionerSecondaryAngle = f"{tag_secondary:.3f}"
            path = os.path.join(out_dir, f"GNBP-XA-3-{suffix}-view{i + 1}.dcm")
            _save(ds, path)
            entry = {
                "file": os.path.basename(path),
                "md5": _file_md5(path),
                "sopInstanceUid": ds.SOPInstanceUID,
                "seriesInstanceUid": ds.SeriesInstanceUID,
                "studyInstanceUid": ds.StudyInstanceUID,
            }
            if photons is not None:
                entry["photons"] = photons
                # 🔴 **実測値を書く**（理論値 1/√photons ではない）。丸め・クリップ・素通し位置の
                #    決め方で理論からずれるので、「作ったつもりの値」を真値にしない。
                bg = variant_frame[0][transmit >= transmit.max() - 1e-9].astype(float)
                entry["backgroundMean"] = round(float(bg.mean()), 2)
                entry["backgroundSigma"] = round(float(bg.std()), 3)
                entry["backgroundRelativeSigma"] = round(float(bg.std() / bg.mean()), 5)
                entry["nominalRelativeSigma"] = round(float(1.0 / math.sqrt(photons)), 5)
                view_entry.setdefault("noise", {})[suffix] = entry
            elif suffix == "a-exact":
                view_entry["exact"] = entry
            else:
                entry.update(
                    {
                        "taggedPrimaryAngleDeg": tag_primary,
                        "taggedSecondaryAngleDeg": tag_secondary,
                        "primaryErrorDeg": err_p,
                        "secondaryErrorDeg": err_s,
                    }
                )
                view_entry["angleError"] = entry
        # この視点での**真値の 2D 中心線**（画素）。3D 真値と同じ間引きで書くので 1:1 に対応する。
        # これがあると、アプリが画像から抽出した中心線を真値と直接比べられる（実機検証で使う）。
        view_entry["branchesPx"] = []
        for br in branches:
            pts = br["points"]
            step = max(1, len(pts) // 60)
            col, row, _ = _project_points(pts[::step], primary, secondary)
            view_entry["branchesPx"].append(
                {
                    "id": br["id"],
                    "pointsPx": [[round(float(c), 3), round(float(r), 3)] for c, r in zip(col, row)],
                }
            )
        views.append(view_entry)

    truth_branches = []
    for br in branches:
        pts = br["points"]
        # 真値は間引いて書く（900 点は JSON に重い。形の検証には 60 点で足りる）。
        step = max(1, len(pts) // 60)
        truth_branches.append(
            {
                "id": br["id"],
                "lengthMm": _polyline_length(pts),
                "diameterProximalMm": float(br["radii"][0] * 2.0),
                "diameterDistalMm": float(br["radii"][-1] * 2.0),
                "minDiameterMm": float(np.min(br["radii"]) * 2.0),
                "pointsLps": [[round(float(v), 4) for v in p] for p in pts[::step]],
                "pointStrideOfFull": step,
                "fullPointCount": int(len(pts)),
            }
        )

    # ── 分岐部（A6b）の真値 ────────────────────────────────────────────
    # 生成器の作りから**幾何学的に決まる**量を、測り方の約束（カリーナから 5mm の窓で
    # 平均方向を取り、3 本とも「カリーナから出ていく向き」に揃える）ごと書き出す。
    # ⚠️ 分岐角は `direction = normalize(tangent + side)`（tangent ⊥ side）から
    #    **厳密に 45°**。ただし娘枝には曲がりがあるので、窓を取って測ると少し増える。
    main_br = next(b for b in branches if b["id"] == "main")
    daughter_br = next(b for b in branches if b["id"] == "daughter")
    main_pts = main_br["points"]
    i0 = int(0.45 * (len(main_pts) - 1))
    carina = main_pts[i0]

    # 🔴 角度の窓は**除外域の外から**取る（`xaBifurcation.ts` の `directionFrom` と同じ）。
    #    カリーナ周辺は 3 本が重なって 1 本の血管として見られないので、径だけでなく
    #    中心線も信用できない。除外域は「母血管 1 径ぶん」。
    #    ⚠️ アプリ側は**実測の**母血管径からこの半径を決めるので、真値とは 0.2mm 程度ずれる
    #    （系統誤差で細く出るため）。角度の許容は ±8° なので、この差は効かない。
    angle_inner_mm = float(main_br["radii"][i0] * 2.0)

    def _mean_direction(pts, window_mm=5.0, inner_mm=angle_inner_mm):
        # 🔴 **正規化せずに足す**（＝窓の中の点の重心への向き）。単位ベクトルの平均にすると
        #    カリーナのすぐ近くの点——向きの情報を持たない点——が遠い点と同じ重みで効き、
        #    角度が数度ずれる。`frontend/src/viewer/xaBifurcation.ts` の `directionFrom` と
        #    同じ式でなければならない（約束が食い違うと正しい実装が不合格になる）。
        acc = np.zeros(3)
        used = 0
        for p in pts:
            v = p - carina
            n = float(np.linalg.norm(v))
            if n < 1e-9 or n <= inner_mm:
                continue
            if n > inner_mm + window_mm:
                break
            acc += v
            used += 1
        if used == 0:
            return None
        return acc / np.linalg.norm(acc)

    d_distal = _mean_direction(main_pts[i0:])
    d_proximal = _mean_direction(main_pts[: i0 + 1][::-1])
    d_side = _mean_direction(daughter_br["points"])

    def _angle(a, b):
        return float(np.degrees(np.arccos(np.clip(float(np.dot(a, b)), -1.0, 1.0))))

    d_prox_mm = float(main_br["radii"][i0] * 2.0)
    d_dist_mm = float(main_br["radii"][i0] * 2.0)
    d_side_mm = float(daughter_br["radii"][0] * 2.0)
    finet_expected = 0.678 * (d_dist_mm + d_side_mm)
    murray_expected = float((d_dist_mm ** 3 + d_side_mm ** 3) ** (1.0 / 3.0))

    bifurcation = {
        "note": (
            "Angles follow the convention used by frontend/src/viewer/xaBifurcation.ts: all three "
            "directions point AWAY from the carina (the proximal one is reversed), averaged over a "
            "5 mm window. The exact take-off angle of the generator is 45 deg; the windowed value "
            "differs slightly because the daughter branch bends."
        ),
        "carinaLps": [round(float(v), 4) for v in carina],
        "mainIndex": i0,
        "exactTakeOffDeg": 45.0,
        "angleWindowMm": 5.0,
        "angleInnerMm": round(angle_inner_mm, 4),
        # 🔑 **枝ごとの向きも出す。** 角度が合わないとき、対の角度だけ見ても
        #    「3 本のうちどれがずれているのか」が分からない（実機で、側枝だけが
        #    11° ずれているのに 2 つの角度が同時に外れて原因を見誤りかけた）。
        "directionProximal": [round(float(v), 6) for v in d_proximal],
        "directionDistal": [round(float(v), 6) for v in d_distal],
        "directionSide": [round(float(v), 6) for v in d_side],
        "distalToSideDeg": round(_angle(d_distal, d_side), 3),
        "proximalToSideDeg": round(_angle(d_proximal, d_side), 3),
        "proximalToDistalDeg": round(_angle(d_proximal, d_distal), 3),
        "diameterProximalMm": round(d_prox_mm, 4),
        "diameterDistalMm": round(d_dist_mm, 4),
        "diameterSideMm": round(d_side_mm, 4),
        # 🚨 このファントムは Finet / Murray を**満たさない**（合成の木なので当然）。
        #    「式に合わない」ことを検出できるかが A6b の検査になる（式で径を書き換えないこと）。
        "finetExpectedMm": round(finet_expected, 4),
        "finetDeviationPercent": round((d_prox_mm - finet_expected) / finet_expected * 100.0, 3),
        "murrayExpectedMm": round(murray_expected, 4),
        "murrayDeviationPercent": round((d_prox_mm - murray_expected) / murray_expected * 100.0, 3),
    }

    return {
        "bifurcation": bifurcation,
        "note": (
            "Known 3D vessel tree projected from 4 known C-arm poses. "
            "The 'b-angle-error' study contains the SAME images but the positioner angle "
            "tags are offset by a known amount, so bundle adjustment has something to recover."
        ),
        "coordinateSystem": "patient LPS mm (X=left, Y=posterior, Z=head), isocenter at origin",
        "projection": (
            "d = (sin(primary)cos(secondary), -cos(primary)cos(secondary), sin(secondary)); "
            "source = -d*SOD; detector plane at SID from source; "
            "u = normalize(z x d) (image column, toward patient left), v = u x d (image row, toward feet)"
        ),
        "caveat": (
            "The generator and the reconstruction share this angle convention, so a WRONG "
            "convention would still agree. This phantom validates triangulation and bundle "
            "adjustment, NOT the DICOM angle definition itself."
        ),
        "views": views,
        "branches": truth_branches,
        "bifurcationFractionOfMain": 0.45,
        "lesion": {
            "branch": "main",
            "fractionOfMain": 0.66,
            "percentDiameterStenosis": 50.0,
            "lengthFraction": 0.09,
        },
        "targets": {
            "centerlineRmsMm": 1.0,
            "segmentLengthErrorPercent": 3.0,
            "angleRecoveryDeg": 1.0,
        },
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
    # ⑥ PixelSpacing はあるが CalibrationType が無く、**ImagerPixelSpacing とも違う**。
    #    規格には反するが実在する書かれ方で、「何かで補正済み」とみなす（P3）。
    #    🚨 ③（c-equals-imager）と**タグの顔ぶれは同じ**で、違うのは値が一致するかどうかだけ。
    #    画面の文言では見分けが付きにくいので、出自の識別子で突き合わせること。
    ("f-uncalibrated-type", MM_PER_PX * 1.05, None, True, "dicom-calibrated-unspecified"),
    # ⑦ PixelSpacing 無し・SID/SOD も無く、**拡大率だけ**ある → P5。
    #    P4 が成立しないときだけ通る枝なので、SID/SOD を書いてしまうと一生通らない。
    ("g-magfactor", None, None, "mag-only", "geometric-magfactor"),
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
                # 期待する mm/px。
                #   P6（detector-plane）  … 「mm を出さない」が正解なので null
                #   P4 / P5（geometric-*）… アイソセンタ面の計算値 MM_PER_PX
                #   P1 / P2 / P3          … PixelSpacing をそのまま採る
                # 🚨 ③（c-equals-imager）は PixelSpacing を持つが**降格して P4 になる**ので、
                #    「PixelSpacing があるならそれ」ではなく**解決先の source で決める**。
                "expectedMmPerPx": (
                    None
                    if expected == "detector-plane"
                    else MM_PER_PX
                    if expected.startswith("geometric-")
                    else spacing
                ),
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

# ══════════════════════════════════════════════════════════════════════
# GNBP-XA-6 — QVA（末梢・脳血管の瘤）
# ══════════════════════════════════════════════════════════════════════

#: (最大径 mm, 瘤長 mm, 嚢状か, ぼけ σ px, I0)。参照径は 3.0mm。
#: 🔑 **比（最大径 / 参照径）が判定基準**なので、1.5 倍ちょうどの境界も入れてある。
QVA_FRAMES = [
    (6.0, 20.0, False, DEFAULT_BLUR_PX, None),   # 紡錘状・比 2.0
    (4.5, 15.0, False, DEFAULT_BLUR_PX, None),   # 紡錘状・比 1.5（瘤と呼ぶ境界ちょうど）
    (3.6, 20.0, False, DEFAULT_BLUR_PX, None),   # 軽度拡張・比 1.2（瘤ではない）
    (6.0, 15.0, True, DEFAULT_BLUR_PX, None),    # ★嚢状（片側だけ）・比 2.0
    (6.0, 15.0, True, DEFAULT_BLUR_PX, 4000.0),  # ★嚢状＋ノイズ
    (3.0, 0.0, False, DEFAULT_BLUR_PX, None),    # 拡張無し（瘤を作り出さないこと）
]


def build_qva(out_dir: str) -> dict:
    rng = np.random.default_rng(20260816)
    frames = np.zeros((len(QVA_FRAMES), ROWS, COLUMNS), dtype=np.uint16)
    truth_frames = []
    for i, (peak, length, saccular, blur, photons) in enumerate(QVA_FRAMES):
        transmit = _project_dilated(peak, length, saccular=saccular, blur_px=blur)
        frames[i] = _to_stored(transmit, photons, rng)
        dilated = peak > REFERENCE_DIAMETER_MM and length > 0
        truth_frames.append(
            {
                "frame": i + 1,
                "referenceDiameterMm": REFERENCE_DIAMETER_MM,
                "maxDiameterMm": peak if dilated else REFERENCE_DIAMETER_MM,
                # 半値法の 13% 過小は比では打ち消される（§16.4）。判定はこの比で行う。
                "ratio": (peak / REFERENCE_DIAMETER_MM) if dilated else 1.0,
                "aneurysmLengthMm": length if dilated else 0.0,
                # 片側だけの膨らみ = 偏心度 1.0、全周性 = 0.0。
                "eccentricity": (1.0 if saccular else 0.0) if dilated else None,
                "saccular": bool(saccular and dilated),
                # 1.5 倍以上を「瘤」と呼ぶ（`frontend/src/viewer/qva.ts` の ANEURYSM_RATIO）。
                "aneurysmal": bool(dilated and peak / REFERENCE_DIAMETER_MM >= 1.5),
                "blurSigmaPx": blur,
                "photonsPerPixel": photons,
            }
        )

    ds = _xa_dataset(
        frames,
        uid_key="XA-6",
        study_key="XA-6",
        series_description="GNBP-XA-6 QVA aneurysm",
        series_number=6,
        frame_time_ms=33.0,
        patient_id="GNBP-XA-6",
        patient_name="GNBPXA^QVA",
        calibration=(MM_PER_PX, "GEOMETRY"),
    )
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "GNBP-XA-6.dcm")
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
        "aneurysmRatio": 1.5,
        "frames": truth_frames,
    }


# ══════════════════════════════════════════════════════════════════════
# GNBP-XA-7 — 非円形断面（エッジ検出の方式を分けるための系列）
# ══════════════════════════════════════════════════════════════════════
#
# 🚨 **なぜ要るのか**: XA-1 は円柱で作ってある。円柱に対しては
# 「シルエットの幅」＝「面積等価直径」＝「真の直径」が全部同じ値になるので、
# **エッジを測る方式（半値法）と面積を測る方式（密度計測）の違いが出ない**。
# 設計 §16.5 で密度計測を採ると決めたが、その利点はこの系列でしか測れない。
# §16.4 の教訓（箱型ファントムは半値法を「厳密に正しい」と見せた）と同じ構図。
#
# この系列は**断面の形だけを変え、他をすべて揃える**。とくに 3 本は
# **断面積が厳密に等しく、シルエットの幅だけが違う**（3.00 / 4.24 / 2.12 mm）。
# 密度計測は 3 本とも等価直径 3.00mm を返すはずで、半値法はシルエットを追うはず。
# **どちらが「正しい」かは測る量の定義の問題**なので、真値は両方を持つ。

#: (名前, 断面の判定関数を作る引数) の並び。断面は (d, z) 平面で定義する。
#: d = 検出器上の横ずれ（＝行方向）、z = 線束の進行方向（＝投影で潰れる方向）。
SHAPE_FRAMES: tuple[tuple[str, str, float, float, float, float], ...] = (
    # 名前,           種類,        p(d半径), q(z半径), 侵入量, 侵入中心
    ("circle", "ellipse", 1.5, 1.5, 0.0, 0.0),
    ("ellipse-wide", "ellipse", 2.1213203435596424, 1.0606601717798212, 0.0, 0.0),
    ("ellipse-tall", "ellipse", 1.0606601717798212, 2.1213203435596424, 0.0, 0.0),
    ("crescent", "crescent", 1.5, 1.5, 1.2, 1.35),
    ("d-shape", "flat", 1.5, 1.5, 0.0, 0.75),
)

#: 断面を積分するときの z 方向の刻み [mm]。細かいほど真値が正確になる。
SHAPE_DZ_MM = 0.002


def _chord_profile(kind: str, p: float, q: float, cut_r: float, cut_c: float, d_mm: np.ndarray) -> np.ndarray:
    """横ずれ d [mm] における**経路長** L(d) [mm]（＝断面を z 方向に積分した長さ）。

    円柱なら L(d) = 2√(r²−d²) の解析解で済むが、三日月や D 型には解析解が無い。
    **全部の形を同じ数値積分で通す**（形ごとに別の式を使うと、真値が形ごとに別の
    近似で決まってしまい、方式の比較が形の比較と混ざる）。
    """
    z = np.arange(-max(p, q) - 0.01, max(p, q) + 0.01, SHAPE_DZ_MM)
    inside = (d_mm[:, None] / p) ** 2 + (z[None, :] / q) ** 2 <= 1.0
    if kind == "crescent":
        # 偏心したプラーク: 内腔から、+d 側にずらした円を引く。
        inside &= (d_mm[:, None] - cut_c) ** 2 + z[None, :] ** 2 > cut_r**2
    elif kind == "flat":
        # D 型: z 方向の片側を弦で切り落とす（＝壁が平ら）。
        inside &= z[None, :] < cut_c
    return inside.sum(axis=1) * SHAPE_DZ_MM


def _project_shape(kind: str, p: float, q: float, cut_r: float, cut_c: float, blur_px: float) -> np.ndarray:
    """断面の形を指定して、まっすぐな血管 1 本の透過率画像を作る。

    軸方向には一様（＝狭窄なし）。**形だけを見たい**ので、他の要因を入れない。
    """
    n = SUPERSAMPLE
    sub = (np.arange(n) + 0.5) / n - 0.5
    rows = (np.arange(ROWS)[:, None] + sub[None, :]).ravel()
    d_mm = (rows - ROWS / 2.0) * MM_PER_PX
    path = _chord_profile(kind, p, q, cut_r, cut_c, d_mm)          # (ROWS*n,)
    transmit_row = np.exp(-MU_CONTRAST * path)
    transmit_row = transmit_row.reshape(ROWS, n).mean(axis=1)      # 面積平均で 1 画素へ
    transmit = np.repeat(transmit_row[:, None], COLUMNS, axis=1)
    return _gaussian_blur(transmit, blur_px)


def build_shapes(out_dir: str) -> dict:
    rng = np.random.default_rng(20260817)
    frames = np.zeros((len(SHAPE_FRAMES), ROWS, COLUMNS), dtype=np.uint16)
    truth_frames = []
    blur = DEFAULT_BLUR_PX
    for i, (name, kind, p, q, cut_r, cut_c) in enumerate(SHAPE_FRAMES):
        transmit = _project_shape(kind, p, q, cut_r, cut_c, blur)
        frames[i] = _to_stored(transmit, None, rng)

        # 真値は**投影に使ったのと同じ経路長**から出す（別の式で出すと真値と画像がずれる）。
        d_fine = np.arange(-max(p, q) - 0.02, max(p, q) + 0.02, SHAPE_DZ_MM)
        path = _chord_profile(kind, p, q, cut_r, cut_c, d_fine)
        area = float(path.sum() * SHAPE_DZ_MM)                     # ∫L(d)dd ＝ 断面積
        lit = d_fine[path > 0]
        silhouette = float(lit.max() - lit.min()) if lit.size else 0.0
        truth_frames.append(
            {
                "frame": i + 1,
                "shape": name,
                # 密度計測が返すべき量。−ln T の横積分は μ·A なので、形に依らずこれになる。
                "areaMm2": area,
                "equivalentDiameterMm": 2.0 * math.sqrt(area / math.pi),
                # 半値法が返すべき量。エッジは**投影の外形**しか見ていない。
                "silhouetteWidthMm": silhouette,
                # 参考: 一番厚いところの経路長（＝z 方向の差し渡し）。
                "maxChordMm": float(path.max()),
                "blurSigmaPx": blur,
                "photonsPerPixel": None,
            }
        )

    ds = _xa_dataset(
        frames,
        uid_key="XA-7",
        study_key="XA-7",
        series_description="GNBP-XA-7 non-circular cross sections",
        series_number=7,
        frame_time_ms=33.0,
        patient_id="GNBP-XA-7",
        patient_name="GNBPXA^SHAPE",
        calibration=(MM_PER_PX, "GEOMETRY"),
    )
    os.makedirs(out_dir, exist_ok=True)
    path_out = os.path.join(out_dir, "GNBP-XA-7.dcm")
    _save(ds, path_out)
    return {
        "sopInstanceUid": ds.SOPInstanceUID,
        "studyInstanceUid": ds.StudyInstanceUID,
        "seriesInstanceUid": ds.SeriesInstanceUID,
        "file": os.path.basename(path_out),
        "md5": _file_md5(path_out),
        "rows": ROWS,
        "columns": COLUMNS,
        "vesselAxisRow": ROWS / 2.0,
        "mmPerPx": MM_PER_PX,
        "muContrastPerMm": MU_CONTRAST,
        "note": (
            "断面の形だけが違う。circle / ellipse-wide / ellipse-tall は断面積が等しく、"
            "シルエットの幅だけが違う（密度計測は 3 本とも等価直径 3.00mm を返すはず）。"
        ),
        "frames": truth_frames,
    }


# ══════════════════════════════════════════════════════════════════════
#  GNBP-XA-8: **健常部は円・病変部だけ非円形**（A4c の実機検証用）
# ══════════════════════════════════════════════════════════════════════
#
# 🔴 **なぜ XA-7 では足りないのか**（`fw/angio-design.md` §16.5.2）
# XA-7 は各フレームが**一様な非円形断面**なので、アプリのように
# 「健常部に円柱を当てはめて μ を得る」運用だと**健常部の当てはめが必ず外れる**。
# 結果、密度計測の利点（形に依らない）が実機では示せない。
#
# この系列は**健常部を円柱に保ち、病変部だけ形を変える**。アプリの運用そのままで
# 「病変の形は問わない」を確かめられる。
#
# 🔑 検査の要は「**病変の断面積を固定したまま、シルエットだけを変える**」こと:
#   - ellipse-wide は**シルエットが健常部と同じ**なので、**半値法は狭窄を見落とす**。
#   - ellipse-tall は逆に**実際より強い狭窄に見える**。
#   - どちらも断面積は同じなので、密度計測は同じ %DS を返すはず。

#: 病変部の断面積 ÷ 健常部の断面積。0.5 ＝ 面積狭窄 50%（径では 29.3%）。
LESION_AREA_RATIO = 0.5
#: 病変の長さ [mm]（この区間だけ形が変わる）。
LESION_SHAPE_LENGTH_MM = 10.0
#: 健常 → 病変の移行に使う長さ [mm]（段差にしないため）。
LESION_SHAPE_RAMP_MM = 2.0

#: (名前, 種類, 説明) — 断面の寸法は「面積を LESION_AREA_RATIO に合わせる」ように解く。
LESION_SHAPE_FRAMES: tuple[tuple[str, str, str], ...] = (
    ("circle", "circle", "同心円の狭窄（対照。半値法でも正しく出る）"),
    ("ellipse-wide", "ellipse-wide", "面積は半分だがシルエットは健常部と同じ＝半値法は見落とす"),
    ("ellipse-tall", "ellipse-tall", "面積は半分なのにシルエットは更に細い＝半値法は過大に見る"),
    ("crescent", "crescent", "偏心プラーク（臨床的に一番ありふれた形）"),
    ("d-shape", "flat", "片側が平ら"),
)


def _lesion_chord(kind: str, r_ref: float, param: float, d_mm: np.ndarray) -> np.ndarray:
    """病変断面の経路長 L(d)。`param` は形ごとの自由度（面積を合わせるために解く）。"""
    if kind == "circle":
        return _chord_profile("ellipse", param, param, 0.0, 0.0, d_mm)
    if kind == "ellipse-wide":
        # シルエット（d 方向の半径）は健常部と同じに固定し、**厚みだけ**を薄くする。
        return _chord_profile("ellipse", r_ref, param, 0.0, 0.0, d_mm)
    if kind == "ellipse-tall":
        # 厚み（z 方向）は健常部と同じに固定し、**シルエットだけ**を細くする。
        return _chord_profile("ellipse", param, r_ref, 0.0, 0.0, d_mm)
    if kind == "crescent":
        # 偏心プラーク: 健常部の円から、+d 側にずらした円を引く（param = 侵入円の半径）。
        return _chord_profile("crescent", r_ref, r_ref, param, r_ref * 0.9, d_mm)
    if kind == "flat":
        # D 型: z 方向の片側を弦で切る（param = 切る位置。小さいほど深く切る）。
        return _chord_profile("flat", r_ref, r_ref, 0.0, param, d_mm)
    raise ValueError(kind)


def _solve_lesion_param(kind: str, r_ref: float, target_area: float) -> float:
    """断面積が `target_area` になる形のパラメータを二分法で解く。

    🔑 **解析解を形ごとに書かない**。形ごとに別の式を使うと、真値が形ごとに別の近似で
    決まってしまう（`_chord_profile` の設計思想と同じ）。面積は投影に使うのと
    **同じ数値積分**で測るので、真値と画像が必ず一致する。
    """
    d = np.arange(-r_ref * 1.6, r_ref * 1.6, SHAPE_DZ_MM)

    def area_of(param: float) -> float:
        return float(_lesion_chord(kind, r_ref, param, d).sum() * SHAPE_DZ_MM)

    # 面積が単調になる向きに lo/hi を取る（flat は「切る位置」が大きいほど面積が増える）。
    lo, hi = 1e-3, r_ref * 0.999
    if kind == "flat":
        lo, hi = -r_ref * 0.999, r_ref * 0.999
    elif kind == "crescent":
        # 侵入円が大きいほど面積は減る → 向きが逆。lo/hi を入れ替えて扱う。
        lo, hi = 1e-3, r_ref * 1.8
    for _ in range(80):
        mid = (lo + hi) / 2.0
        a = area_of(mid)
        increasing = kind != "crescent"
        if (a < target_area) == increasing:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def _project_lesion_shape(kind: str, param: float, blur_px: float) -> np.ndarray:
    """健常部は円柱・病変部だけ指定の断面、という血管 1 本の透過率画像。"""
    n = SUPERSAMPLE
    sub = (np.arange(n) + 0.5) / n - 0.5
    cols = (np.arange(COLUMNS)[:, None] + sub[None, :]).ravel()
    rows = (np.arange(ROWS)[:, None] + sub[None, :]).ravel()
    x_mm = (cols - COLUMNS / 2.0) * MM_PER_PX
    d_mm = (rows - ROWS / 2.0) * MM_PER_PX
    r_ref = REFERENCE_DIAMETER_MM / 2.0

    healthy = _chord_profile("ellipse", r_ref, r_ref, 0.0, 0.0, d_mm)   # (ROWS*n,)
    lesion = _lesion_chord(kind, r_ref, param, d_mm)                    # (ROWS*n,)

    # 病変の重み w(x): 中央 LESION_SHAPE_LENGTH_MM は 1、その外側 RAMP で余弦で 0 へ。
    half = LESION_SHAPE_LENGTH_MM / 2.0
    ax = np.abs(x_mm)
    w = np.zeros_like(x_mm)
    w[ax <= half] = 1.0
    ramp = (ax > half) & (ax < half + LESION_SHAPE_RAMP_MM)
    w[ramp] = 0.5 * (1.0 + np.cos(np.pi * (ax[ramp] - half) / LESION_SHAPE_RAMP_MM))

    # 🔑 **経路長そのものを混ぜる**（形を混ぜるのではない）。中央では w=1 なので、
    #    計測点での真値は病変断面の面積ちょうどになる。
    path = healthy[:, None] * (1.0 - w[None, :]) + lesion[:, None] * w[None, :]
    transmit = np.exp(-MU_CONTRAST * path)
    transmit = transmit.reshape(ROWS, n, COLUMNS, n).mean(axis=(1, 3))
    return _gaussian_blur(transmit, blur_px)


def build_lesion_shapes(out_dir: str) -> dict:
    rng = np.random.default_rng(20260818)
    frames = np.zeros((len(LESION_SHAPE_FRAMES), ROWS, COLUMNS), dtype=np.uint16)
    truth_frames = []
    blur = DEFAULT_BLUR_PX
    r_ref = REFERENCE_DIAMETER_MM / 2.0
    d_fine = np.arange(-r_ref * 1.6, r_ref * 1.6, SHAPE_DZ_MM)
    healthy_area = float(_chord_profile("ellipse", r_ref, r_ref, 0.0, 0.0, d_fine).sum() * SHAPE_DZ_MM)
    target = healthy_area * LESION_AREA_RATIO

    for i, (name, kind, note) in enumerate(LESION_SHAPE_FRAMES):
        param = _solve_lesion_param(kind, r_ref, target)
        frames[i] = _to_stored(_project_lesion_shape(kind, param, blur), None, rng)

        path = _lesion_chord(kind, r_ref, param, d_fine)
        area = float(path.sum() * SHAPE_DZ_MM)
        lit = d_fine[path > 0]
        silhouette = float(lit.max() - lit.min()) if lit.size else 0.0
        equiv = 2.0 * math.sqrt(area / math.pi)
        truth_frames.append(
            {
                "frame": i + 1,
                "shape": name,
                "note": note,
                "solvedParam": param,
                "lesionAreaMm2": area,
                # 密度計測が返すべき MLD。
                "equivalentDiameterMm": equiv,
                # 半値法が返すべき MLD（＝投影の外形）。
                "silhouetteWidthMm": silhouette,
                "referenceDiameterMm": REFERENCE_DIAMETER_MM,
                # 面積で見た狭窄率（真値）。
                "percentAreaStenosis": (1.0 - area / healthy_area) * 100.0,
                # 等価直径で見た狭窄率＝密度計測が返すべき %DS。
                "percentDiameterStenosis": (1.0 - equiv / REFERENCE_DIAMETER_MM) * 100.0,
                # シルエットで見た狭窄率＝半値法が返すはずの %DS（**別の量**）。
                "percentDiameterStenosisBySilhouette": (1.0 - silhouette / REFERENCE_DIAMETER_MM) * 100.0,
                "lesionLengthMm": LESION_SHAPE_LENGTH_MM,
                "blurSigmaPx": blur,
                "photonsPerPixel": None,
            }
        )

    ds = _xa_dataset(
        frames,
        uid_key="XA-8",
        study_key="XA-8",
        series_description="GNBP-XA-8 non-circular lesion in a circular vessel",
        series_number=8,
        frame_time_ms=33.0,
        patient_id="GNBP-XA-8",
        patient_name="GNBPXA^LESIONSHAPE",
        calibration=(MM_PER_PX, "GEOMETRY"),
    )
    os.makedirs(out_dir, exist_ok=True)
    path_out = os.path.join(out_dir, "GNBP-XA-8.dcm")
    _save(ds, path_out)
    return {
        "sopInstanceUid": ds.SOPInstanceUID,
        "studyInstanceUid": ds.StudyInstanceUID,
        "seriesInstanceUid": ds.SeriesInstanceUID,
        "file": os.path.basename(path_out),
        "md5": _file_md5(path_out),
        "rows": ROWS,
        "columns": COLUMNS,
        "vesselAxisRow": ROWS / 2.0,
        "mmPerPx": MM_PER_PX,
        "muContrastPerMm": MU_CONTRAST,
        "healthyAreaMm2": healthy_area,
        "lesionAreaRatio": LESION_AREA_RATIO,
        "note": (
            "健常部は円柱・病変部だけ断面の形が違う。5 フレームとも病変の断面積は同じ"
            "（健常部の 50%）で、シルエットの幅だけが違う。密度計測は 5 本とも同じ %DS を"
            "返すはずで、半値法はシルエットを追う（ellipse-wide は狭窄を見落とす）。"
        ),
        "frames": truth_frames,
    }


BUILDERS = {
    "qca": build_qca,
    "dsa": build_dsa,
    "recon3d": build_recon3d,
    "calibration": build_calibration,
    "qva": build_qva,
    "shapes": build_shapes,
    "lesionshapes": build_lesion_shapes,
}

#: 系列ごとの出力ファイル名の接頭辞。`--series X --force` で**その系列だけ**消すために要る。
#: 🚨 新しい系列を足したらここにも足すこと（漏れると `--force` がその系列の古い出力を残す）。
SERIES_PREFIX = {
    "qca": "GNBP-XA-1",
    "dsa": "GNBP-XA-2",
    "recon3d": "GNBP-XA-3",
    "calibration": "GNBP-XA-4",
    "qva": "GNBP-XA-6",
    "shapes": "GNBP-XA-7",
    "lesionshapes": "GNBP-XA-8",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="./phantom", help="出力先ディレクトリ")
    ap.add_argument("--series", choices=sorted(BUILDERS), action="append", help="生成する系列（既定は全部）")
    ap.add_argument("--force", action="store_true", help="既存の出力を消してから生成する")
    args = ap.parse_args()

    out_root = os.path.join(args.out, "GNBP-XA")
    wanted = args.series or sorted(BUILDERS)
    # 🚨 **`--series X --force` で他の系列を巻き添えにしない。**
    #    ディレクトリごと消していたため、recon3d だけ作り直したつもりで qca / dsa /
    #    calibration / qva の DICOM が消え、他のスパイクが「ファントムがありません」で
    #    落ちた（2026-08-16 に実際に踏んだ。truth.json は更新方式にしてあったのに、
    #    **DICOM 側が消える**ので同じ事故が別の顔で再発した）。
    if args.force and os.path.isdir(out_root):
        if args.series:
            prefixes = tuple(SERIES_PREFIX[s] for s in wanted)
            for name in os.listdir(out_root):
                if name.startswith(prefixes):
                    os.remove(os.path.join(out_root, name))
        else:
            shutil.rmtree(out_root)
    os.makedirs(out_root, exist_ok=True)
    # 🚨 **`--series` で一部だけ作り直しても truth.json の他の系列を消さない。**
    #    ここを上書きにしていたため、qva だけ生成した時点で qca / dsa / recon3d /
    #    calibration の真値が truth.json から消え、他のスパイクが「ファントムが無い」で
    #    落ちる状態になった（DICOM は残っているので気づきにくい）。既存を読んで**更新する**。
    truth_path = os.path.join(out_root, "truth.json")
    truth: dict = {}
    if os.path.isfile(truth_path):
        try:
            with open(truth_path, encoding="utf-8") as f:
                truth = json.load(f)
        except (OSError, ValueError):
            truth = {}
    truth.update({
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
    })
    for name in wanted:
        print(f"[GNBP-XA] {name} …", file=sys.stderr)
        truth[name] = BUILDERS[name](out_root)

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
            for v in section.get("views", []):
                print(f"  {v['exact']['file']}  md5 {v['exact']['md5']}", file=sys.stderr)
                print(f"  {v['angleError']['file']}  md5 {v['angleError']['md5']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

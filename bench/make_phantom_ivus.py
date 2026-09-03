#!/usr/bin/env python3
"""GNBP-IVUS — 血管内超音波（IVUS）プルバックの合成ファントム（fw/angio-design.md §12 / A8）。

なぜ合成で足りるのか
--------------------
A8 で検証したいのは **対応づけの規則**（フレーム f → プルバック距離 d → アンギオ経路上の位置）
であって、断層画像の中身ではない。必要なのは

  * ``NumberOfFrames`` が入ったマルチフレーム US（Modality=IVUS）
  * ``IVUSPullbackRate`` / ``IVUSGatedRate`` / ``IVUSPullbackStartFrameNumber`` /
    ``IVUSPullbackStopFrameNumber``
  * **既知の距離に置いたマーカー**（対応づけが合っているかを画像から確かめられる）

の 3 つだけ。写実性（リングダウン・ガイドワイヤ影・スペックル）は要らない。

🔑 **これは「測る側と同じモデルで的を作る」罠に当たらない。** 真値は
「マーカーを何 mm の位置に置いたか」で、これは**生成器の外にある独立した約束**である。
計測側は画像からマーカーを見つけるのではなく、**タグと規則から距離を計算する**ので、
両者は別の経路になる。

⚠️ **「合成で通った」は「実データで通る」を意味しない。** 実 IVUS はリングダウン・
ガイドワイヤ影・非一様な引き抜き速度・心拍による前後動を含む。**画面と文書に、
合成でしか確かめていないと明記すること。**

出力
----
``<out>/GNBP-IVUS/GNBP-IVUS-1.dcm`` と ``truth.json``。

使い方
------
    python3 bench/make_phantom_ivus.py --out ./phantom
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

from dicom_io import IMPLEMENTATION_CLASS_UID, deterministic_uid

#: US Multi-frame Image Storage。**IVUS の実体**（Modality で血管内かを区別する）。
US_MULTI_FRAME_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.3.1"

ROWS = 256
COLUMNS = 256
#: 断層 1 画素の実寸 [mm]。IVUS は 10mm 四方くらいを 256px で見る装置が多い。
PIXEL_SPACING_MM = 0.04

#: 引き抜き速度 [mm/s]。実機の既定でよく使われる値。
PULLBACK_RATE_MM_PER_S = 0.5
#: フレームレート [fps]。
FRAME_RATE = 30.0
#: プルバックのフレーム数。先頭 2 秒の静止 ＋ 9.15mm ぶんの引き抜き。
FRAME_COUNT = 610
#: 実際に引き抜いている区間（1 origin・DICOM の規約に合わせる）。
PULLBACK_START_FRAME = 61   # 先頭 2 秒は静止（カテーテル位置合わせ）
PULLBACK_STOP_FRAME = 610

#: マーカーを置く「プルバック開始からの距離」[mm]。**これが真値**。
MARKER_DISTANCES_MM = [1.0, 3.0, 5.0, 7.0, 9.0]

STORED_MAX = 255


def _lumen_radius_mm(distance_mm: float) -> float:
    """プルバック位置ごとの内腔半径 [mm]。中央に狭窄を 1 つ置く。

    ⚠️ この形は **A8 の検証には使わない**（A8 が見るのは位置の対応づけ）。
    「どのフレームを見ているか」を人が目で分かるようにするためだけのもの。
    """
    base = 1.6
    # 5mm 付近に半径が 0.6 倍になる狭窄。
    narrowing = 0.4 * np.exp(-(((distance_mm - 5.0) / 1.2) ** 2))
    return float(base * (1.0 - narrowing))


def _frame(distance_mm: float, marker: bool) -> np.ndarray:
    """1 フレームの断層像。同心円の内腔＋血管壁、マーカー位置では明るい点を 4 つ置く。"""
    cy, cx = ROWS / 2.0, COLUMNS / 2.0
    yy, xx = np.mgrid[0:ROWS, 0:COLUMNS]
    r_mm = np.hypot(yy - cy, xx - cx) * PIXEL_SPACING_MM

    lumen = _lumen_radius_mm(distance_mm)
    wall_outer = lumen + 0.5

    img = np.full((ROWS, COLUMNS), 40.0)          # 内腔（暗い）
    img[r_mm >= lumen] = 170.0                    # 内膜〜中膜（明るい）
    img[r_mm >= wall_outer] = 90.0                # 外膜側（中間）
    # カテーテル本体（中心の不可視域）。実機のリングダウンの位置にあたる。
    img[r_mm < 0.35] = 20.0

    if marker:
        # 🔑 **既知の距離にだけ置く印**。対応づけが 1 フレームでもずれれば、
        #    「期待した距離のフレーム」に印が無いことで分かる。
        for ang in (0, 90, 180, 270):
            a = np.deg2rad(ang)
            my = cy + np.sin(a) * (wall_outer + 0.25) / PIXEL_SPACING_MM
            mx = cx + np.cos(a) * (wall_outer + 0.25) / PIXEL_SPACING_MM
            spot = np.hypot(yy - my, xx - mx) * PIXEL_SPACING_MM
            img[spot < 0.12] = STORED_MAX

    return np.clip(img, 0, STORED_MAX)


def build(out_dir: str) -> dict:
    os.makedirs(out_dir, exist_ok=True)

    # フレーム → プルバック開始からの距離 [mm]。
    #   d(f) = (f − startFrame) / frameRate × pullbackRate     （f は 0 origin）
    start0 = PULLBACK_START_FRAME - 1
    distances = [(f - start0) / FRAME_RATE * PULLBACK_RATE_MM_PER_S for f in range(FRAME_COUNT)]

    # マーカーを置くフレーム（距離がいちばん近いもの）。**真値として truth.json に書く**。
    markers = []
    for d in MARKER_DISTANCES_MM:
        frame = start0 + int(round(d / PULLBACK_RATE_MM_PER_S * FRAME_RATE))
        # 🚨 範囲外のマーカーを黙って truth に書かない。書くと「そこに印があるはず」という
        #    真値が生まれ、**実在しない位置を期待する検査**ができてしまう。
        if not (0 <= frame < FRAME_COUNT):
            raise SystemExit(
                f"マーカー {d}mm はフレーム {frame} に落ち、収集（0..{FRAME_COUNT - 1}）の外です。"
                f" FRAME_COUNT か MARKER_DISTANCES_MM を直してください。"
            )
        markers.append({"distanceMm": d, "frame": frame, "frameOneBased": frame + 1})
    marker_frames = {m["frame"] for m in markers}

    frames = np.stack(
        [_frame(distances[f], f in marker_frames) for f in range(FRAME_COUNT)]
    ).astype(np.uint8)

    ds = _ivus_dataset(frames)
    path = os.path.join(out_dir, "GNBP-IVUS-1.dcm")
    ds.save_as(path, enforce_file_format=True)

    with open(path, "rb") as fh:
        md5 = hashlib.md5(fh.read()).hexdigest()

    truth = {
        "note": (
            "合成 IVUS プルバック。検証できるのは『フレーム→距離→経路上の位置』の対応づけであって、"
            "断層画像の中身ではない。実 IVUS のリングダウン・ガイドワイヤ影・非一様な引き抜き・"
            "心拍による前後動は含んでいない。"
        ),
        "file": "GNBP-IVUS-1.dcm",
        "md5": md5,
        "sopClassUid": US_MULTI_FRAME_SOP_CLASS,
        "sopInstanceUid": ds.SOPInstanceUID,
        "seriesInstanceUid": ds.SeriesInstanceUID,
        "studyInstanceUid": ds.StudyInstanceUID,
        "modality": "IVUS",
        "frameCount": FRAME_COUNT,
        "rows": ROWS,
        "columns": COLUMNS,
        "pixelSpacingMm": PIXEL_SPACING_MM,
        "frameRate": FRAME_RATE,
        "pullbackRateMmPerS": PULLBACK_RATE_MM_PER_S,
        "pullbackStartFrame": PULLBACK_START_FRAME,
        "pullbackStopFrame": PULLBACK_STOP_FRAME,
        # 🔑 これが対応づけの真値。生成器の外にある約束。
        "markers": markers,
        "totalPullbackLengthMm": round(
            (PULLBACK_STOP_FRAME - PULLBACK_START_FRAME) / FRAME_RATE * PULLBACK_RATE_MM_PER_S, 4
        ),
        "stenosis": {
            "atDistanceMm": 5.0,
            "minLumenRadiusMm": round(_lumen_radius_mm(5.0), 4),
            "referenceLumenRadiusMm": round(_lumen_radius_mm(0.0), 4),
            "caveat": "内腔の形は目視でフレームを見分けるためのもので、A8 の受け入れ条件には使わない。",
        },
    }
    with open(os.path.join(out_dir, "truth.json"), "w", encoding="utf-8") as fh:
        json.dump(truth, fh, ensure_ascii=False, indent=1)
    return truth


def _ivus_dataset(frames: np.ndarray) -> Dataset:
    n_frames = int(frames.shape[0])
    sop_uid = deterministic_uid("GNBP-IVUS", "1", "sop")

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = US_MULTI_FRAME_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = IMPLEMENTATION_CLASS_UID

    ds = Dataset()
    ds.file_meta = meta
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.preamble = b"\0" * 128

    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.SOPClassUID = US_MULTI_FRAME_SOP_CLASS
    ds.SOPInstanceUID = sop_uid
    # 🔴 **ここが血管内かどうかの唯一の目印**（US Multi-frame は心エコーでも使われる）。
    ds.Modality = "IVUS"
    ds.PatientID = "GNBP-IVUS"
    ds.PatientName = "GNBP^IVUS"
    ds.PatientBirthDate = "19700101"
    ds.PatientSex = "O"
    ds.StudyInstanceUID = deterministic_uid("GNBP-IVUS", "study")
    ds.SeriesInstanceUID = deterministic_uid("GNBP-IVUS", "1", "series")
    ds.StudyID = "GNBPIVUS"
    ds.AccessionNumber = "GNBPIVUS"
    ds.StudyDate = "20260101"
    ds.StudyTime = "120000"
    ds.SeriesDate = "20260101"
    ds.SeriesTime = "120000"
    ds.ContentDate = "20260101"
    ds.ContentTime = "120000"
    ds.StudyDescription = "GNBP-IVUS benchmark phantom"
    ds.SeriesDescription = "IVUS pullback (synthetic)"
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.Manufacturer = "Visionary Imaging Services"
    ds.ManufacturerModelName = "GNBP-IVUS"
    ds.SoftwareVersions = "GNBP-IVUS/1"

    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = ROWS
    ds.Columns = COLUMNS
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = n_frames
    ds.PixelData = frames.astype("<u1").tobytes()

    # 時間軸。
    ds.FrameTime = f"{1000.0 / FRAME_RATE:.3f}"
    ds.FrameIncrementPointer = 0x00181063  # FrameTime
    ds.CineRate = int(round(FRAME_RATE))

    # 断層 1 画素の実寸。US では PixelSpacing ではなく SequenceOfUltrasoundRegions で
    # 与える装置もあるが、ここでは読み手を選ばない PixelSpacing も書いておく。
    ds.PixelSpacing = [f"{PIXEL_SPACING_MM:.6f}", f"{PIXEL_SPACING_MM:.6f}"]

    # ── 🔑 プルバックのタグ（§12.1）──────────────────────────────────
    ds.IVUSAcquisition = "MOTOR"
    ds.IVUSPullbackRate = f"{PULLBACK_RATE_MM_PER_S:.4f}"
    ds.IVUSGatedRate = f"{FRAME_RATE:.4f}"
    ds.IVUSPullbackStartFrameNumber = PULLBACK_START_FRAME
    ds.IVUSPullbackStopFrameNumber = PULLBACK_STOP_FRAME

    ds.WindowCenter = "128"
    ds.WindowWidth = "255"
    return ds


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="./phantom", help="出力先（既定 ./phantom）")
    args = ap.parse_args()
    out_dir = os.path.join(args.out, "GNBP-IVUS")
    truth = build(out_dir)
    print(f"{truth['file']}  md5 {truth['md5']}")
    print(f"  {truth['frameCount']} フレーム / 引き抜き {truth['pullbackRateMmPerS']} mm/s "
          f"/ 全長 {truth['totalPullbackLengthMm']} mm")
    for m in truth["markers"]:
        print(f"  マーカー {m['distanceMm']:>4} mm → フレーム {m['frameOneBased']}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-4D)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
GNBP-4D — degradation series: data that is *deliberately incomplete*.

The other phantoms answer "is the answer right?". This one answers a different
question: **when the data cannot support a feature, does the application say so
instead of producing something wrong?**

That path is normally untested because real incomplete data is awkward to obtain
and awkward to keep around. It is also the path where failures are worst: a
viewer that silently registers a series with no patient-space frame, or saves a
PET series that has lost the attributes SUV needs, produces a result that looks
finished and is not.

    GNBP-4D-nonspatial     No IOP / IPP / FrameOfReferenceUID (as CR and DX are).
                           Registration and manual alignment must be refused,
                           with a reason the user can read.

    GNBP-4D-pet-complete   PET with everything SUV needs. The positive control —
                           without it, "SUV did not appear" proves nothing.

    GNBP-4D-pet-incomplete PET missing Units, PatientWeight and the
                           radiopharmaceutical sequence. SUV must be refused, and
                           saving a derived series from it must be rejected
                           (fw/registration-design.md §8.3).

Usage:
    python3 make_phantom_4d.py --out ./phantom
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import numpy as np
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence

from dicom_io import series_checksum, write_series

PHANTOM_ID = "GNBP-4D"
PHANTOM_VERSION = "1.0"

# 小さくてよい。ここで測るのは精度ではなく「拒否されるか」なので、
# 大きくしても得られるものが無く、生成と取り込みが遅くなるだけ。
ROWS = COLUMNS = 128
PIXEL_SPACING = (1.0, 1.0)

PET_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.128"        # Positron Emission Tomography Image Storage
DX_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.1.1"         # Digital X-Ray Image Storage - For Presentation

# PET も DX も Rescale を持たない／恒等なので、格納値がそのまま表示値になる。
DX_MAX = 4095                                        # 12bit 相当（上限クリップ）
PET_MAX = 1800                                       # 下の pet_volume の最大集積


def full_range_window(volume: np.ndarray) -> tuple[float, float]:
    """内容の値域をちょうど覆う窓 (center, width)。

    定数で書くと、内容を変えたときに窓だけ古いまま残る。CT の軟部条件（40/400）を
    PET と DX にそのまま流用していたために、**画素の 100 % が窓の上に振り切れて
    真っ白**になった（実際になった）。値域から導けばその破綻は起きない。
    """
    lo, hi = float(volume.min()), float(volume.max())
    width = max(1.0, hi - lo)
    return ((lo + hi) / 2.0, width)


def radiograph(rows: int, cols: int) -> np.ndarray:
    """DX 様の 1 枚（勾配 ＋ いくつかの構造）。決定的。

    DX は Rescale を持たない前提なので、値域は **0 以上**でなければならない
    （格納値がそのまま表示値になる）。HU のように負を許すと符号無し 16bit に
    収まらず、黙って巻き付いた画になる。
    """
    y, x = np.mgrid[0:rows, 0:cols]
    img = 200 + 600 * (y / rows)                       # 素抜けから体部への勾配
    body = ((x - cols / 2) / (cols * 0.32)) ** 2 + ((y - rows / 2) / (rows * 0.42)) ** 2 < 1
    img = np.where(body, img + 400, img * 0.15)        # 体外は減弱が無く低信号
    for cx in (cols * 0.35, cols * 0.5, cols * 0.65):  # 肋骨様
        img = np.where(np.abs(x - cx) < 2.5, img + 500, img)
    return np.clip(np.rint(img), 0, DX_MAX).astype(np.int16)[None, :, :]


def pet_volume(n_slices: int, rows: int, cols: int) -> np.ndarray:
    """PET 様の小さなボリューム（集積の塊がいくつか）。"""
    vol = np.zeros((n_slices, rows, cols), dtype=np.float64)
    zz, yy, xx = np.mgrid[0:n_slices, 0:rows, 0:cols]
    body = (((xx - cols / 2) / (cols * 0.34)) ** 2
            + ((yy - rows / 2) / (rows * 0.34)) ** 2
            + ((zz - n_slices / 2) / (n_slices * 0.42)) ** 2) < 1
    vol = np.where(body, 300.0, 0.0)
    for (cz, cy, cx, r, v) in [
        (n_slices * 0.4, rows * 0.4, cols * 0.6, 6, 1800),
        (n_slices * 0.6, rows * 0.62, cols * 0.38, 5, 1200),
    ]:
        d = np.sqrt((zz - cz) ** 2 + (yy - cy) ** 2 + (xx - cx) ** 2)
        vol = np.where(d < r, v, vol)
    return np.clip(np.rint(vol), 0, PET_MAX).astype(np.int16)


def pet_attributes(complete: bool):
    """SUV に要る属性を書く（`complete=False` なら**わざと落とす**）。"""
    def customize(ds: Dataset, _k: int) -> None:
        ds.ImageType = ["DERIVED", "SECONDARY"]
        if not complete:
            # ここで落とすものが、そのまま「SUV が出ない理由」になる。
            # RescaleType も消す（Units が無いので決めようがない）。
            del ds.RescaleType
            return
        ds.Units = "BQML"
        ds.CorrectedImage = ["DECY", "ATTN"]
        ds.DecayCorrection = "START"
        ds.PatientWeight = 62.5
        ds.PatientSize = 1.70
        ds.SeriesTime = "101500"
        ds.AcquisitionTime = "101500"

        item = Dataset()
        item.RadionuclideTotalDose = 240000000.0        # 240 MBq
        item.RadiopharmaceuticalStartTime = "093000"
        item.RadionuclideHalfLife = 6586.2              # F-18
        code = Dataset()
        code.CodeValue = "C-111A1"
        code.CodingSchemeDesignator = "SRT"
        code.CodeMeaning = "Fluorodeoxyglucose F^18^"
        item.RadionuclideCodeSequence = Sequence([code])
        ds.RadiopharmaceuticalInformationSequence = Sequence([item])
    return customize


def nonspatial_attributes(ds: Dataset, _k: int) -> None:
    # CR/DX は Rescale を持たないことが多い。持たせないことで
    # 「幾何も校正も無い」素の 2D 画像に近づける。格納値がそのまま表示値になるよう、
    # 呼び出し側で intercept 0 を指定してある（消すだけでは値がずれる）。
    ds.ImageType = ["DERIVED", "SECONDARY"]
    ds.PresentationLUTShape = "IDENTITY"
    for tag in ("RescaleIntercept", "RescaleSlope", "RescaleType",
                "SpacingBetweenSlices", "PatientPosition"):
        if tag in ds:
            delattr(ds, tag)


# SeriesDescription は ASCII に保つ。SpecificCharacterSet が ISO_IR 100 なので、
# 日本語を入れると latin-1 に落ちて置換文字で化ける（実際に化けた）。
# 日本語の説明は manifest（`expects`）に持たせる。
SERIES = {
    "nonspatial": {
        "number": 1,
        "description": "GNBP-4D nonspatial (no IOP/IPP)",
        "expects": "位置調整・自動位置合わせが無効化され、理由が表示されること",
    },
    "pet-complete": {
        "number": 2,
        "description": "GNBP-4D PET complete (SUV computable, control)",
        "expects": "SUV が計算でき、派生シリーズも保存できること",
    },
    "pet-incomplete": {
        "number": 3,
        "description": "GNBP-4D PET incomplete (SUV attributes removed)",
        "expects": "SUV が拒否され、派生シリーズの保存も拒否されること",
    },
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="./phantom")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--series", choices=sorted(SERIES), action="append")
    args = ap.parse_args()

    wanted = args.series or list(SERIES)
    manifest = {}

    for name in SERIES:
        if name not in wanted:
            continue
        spec = SERIES[name]
        series_id = f"{PHANTOM_ID}-{name}"
        out_dir = os.path.join(args.out, series_id)
        if os.path.exists(out_dir):
            if not args.force:
                print(f"skip (exists): {out_dir}", file=sys.stderr)
                continue
            shutil.rmtree(out_dir)

        if name == "nonspatial":
            volume = radiograph(ROWS, COLUMNS)
            kwargs = dict(
                modality="DX", sop_class_uid=DX_SOP_CLASS,
                spatial=False, customize=nonspatial_attributes,
                slice_thickness=1.0, body_part="CHEST",
                rescale_intercept=0, rescale_type="US",
                window=full_range_window(volume), window_explanation="FULL RANGE",
            )
        else:
            volume = pet_volume(24, ROWS, COLUMNS)
            kwargs = dict(
                modality="PT", sop_class_uid=PET_SOP_CLASS,
                spatial=True, customize=pet_attributes(name == "pet-complete"),
                slice_thickness=4.0, body_part="WHOLEBODY",
                z_origin_mm=-(24 - 1) / 2.0 * 4.0,
                rescale_intercept=0, rescale_type="BQML",
                window=full_range_window(volume), window_explanation="PET",
            )

        print(f"building {series_id}: {volume.shape[0]} slices", file=sys.stderr)
        write_series(
            volume,
            out_dir,
            series_description=spec["description"],
            patient_id=PHANTOM_ID,
            patient_name="GNBP^4D",
            pixel_spacing=PIXEL_SPACING,
            series_number=spec["number"],
            uid_key=f"{series_id}-{PHANTOM_VERSION}",
            study_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}",
            study_description="GRAPHY-Next degradation phantom (deliberately incomplete)",
            model_name=f"{series_id} v{PHANTOM_VERSION}",
            protocol_name=f"{PHANTOM_ID} degradation phantom",
            **kwargs,
        )
        total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
        md5 = series_checksum(out_dir)
        manifest[name] = {
            "series": series_id,
            "series_number": spec["number"],
            "expects": spec["expects"],
            "files": len(os.listdir(out_dir)),
            "bytes": total,
            "series_md5": md5,
        }
        print(f"  {len(os.listdir(out_dir))} files, {total / 1024 / 1024:.1f} MiB, md5 {md5}", file=sys.stderr)
        print(f"  期待する挙動: {spec['expects']}", file=sys.stderr)

    path = os.path.join(args.out, f"{PHANTOM_ID}_manifest.json")
    existing = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            existing = json.load(fh).get("series", {})
    existing.update(manifest)
    # 🚨 Windows の既定は cp932。encoding を省略すると非 ASCII で落ちる
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({
            "phantom": PHANTOM_ID,
            "version": PHANTOM_VERSION,
            "purpose": (
                "degradation: deliberately incomplete data. The application must refuse the "
                "affected feature and say why, rather than produce a result that looks finished."
            ),
            "series": existing,
        }, fh, indent=2, ensure_ascii=False)
    print(f"  manifest -> {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# GRAPHY-Next Benchmark — public dataset wrapper
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
公開データセットの画像を **XA マルチフレーム DICOM に包む**。

`fw/angio-design.md` §16.1 / §16.2 / §16.2.1。

なぜ要るのか
------------
商用利用可と確認できた公開データ（ARCADE / CADICA / DIAS / Mendeley の狭窄データ。
§16.2.1）は**すべて PNG などの画像形式**で配布されている。GRAPHY-Next は DICOM しか
開かないので、そのままでは 1 枚も取り込めない。§16.1-2 に「`bench/` の生成器で
XA DICOM に包んでから取り込む」と方針だけが書かれていたものの実体である。

🚨 幾何タグを「それらしく」埋めてはいけない
-------------------------------------------
これらのデータは患者情報除去のため DICOM から画像へ変換されており、
``ImagerPixelSpacing`` / ``PixelSpacing`` / ``DistanceSourceToDetector`` /
``DistanceSourceToPatient`` / ``PositionerPrimaryAngle`` が**失われている**。
復元する方法は無い。

したがってこのラッパは **空間校正と投影幾何に関わるタグを一切書かない**。結果として
§7.2 の校正連鎖は P7（none）へ落ち、GRAPHY-Next は px で表示する。**それが正しい挙動**。

もっともらしい既定値（例 0.3 mm/px）を書くと、受け手は未校正の画像を mm で測り、
**値がそれらしいので誰も気付かない**。host API H35 で「未校正を数値で埋めない」と
決めたのと同じ判断である（§22.3）。mm が要るなら画面上でカテーテル法／ルーラー法で
校正すること（§7.3）。

⚠️ **精度の検証には使えない。** 真値が無いので言えるのは「動く」「内部整合する」まで。
   精度の合否は真値既知のファントム（GNBP-XA・§16.3）で判定する。

🔴 単一フレームにしかできないデータがある
-----------------------------------------
XA の解析（QCA / QVA / LV）は**フレーム軸を持つスタック**にしか出ない。互いに無関係な
静止画を 1 本のマルチフレームへ束ねると、フレームごとに別患者・別血管という嘘のシリーズに
なるので、**このラッパはそれをしない**。

    CADICA … 1 ビデオ = 10 連続フレーム   → マルチフレーム。解析できる
    DIAS   … DSA シーケンス               → マルチフレーム。解析できる
    ARCADE / Mendeley の狭窄データ … 独立した静止画 → **単一フレーム**。表示のみ

単一フレームで出力するときは、その旨を警告する。

ライセンス
----------
CC BY 4.0 のデータは**出典表記が必須**なので、帰属をタグへ焼き込んで持ち回る
（画像だけが独り歩きしても出典が残るように）。

使い方
------
    # 既知のデータセット（グループ化の規則を内蔵）
    python3 bench/wrap_public_xa.py --dataset cadica --src <展開先> --out <出力先>

    # それ以外。1 ディレクトリ = 1 シリーズとして束ねる
    python3 bench/wrap_public_xa.py --dataset generic --src <dir> --out <dir> \
        --attribution "..." --fps 15

    python3 bench/wrap_public_xa.py --dataset arcade --src <dir> --out <dir> --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dicom_io import IMPLEMENTATION_CLASS_UID, deterministic_uid  # noqa: E402

XA_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.12.1"
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".pgm")


@dataclass
class DatasetSpec:
    """公開データセット 1 件の素性。ライセンスは §16.2.1 で確認した値。"""

    key: str
    title: str
    license: str
    attribution: str
    fps: float
    #: True なら連続フレームとして束ねる、False なら 1 枚 1 シリーズ。
    frames_are_a_sequence: bool
    note: str = ""
    verified: bool = True
    #: 相対パスがこれに一致するものだけを使う（None なら全部）。
    #: 正解マスクなど「画像だが投影像ではない」ものを外すために要る。
    path_include: str | None = None
    #: シリーズの切り分け。None ならディレクトリ単位。
    #: 指定するとファイル名から鍵を取る（1 ディレクトリに複数シーケンスが入る配布形式向け）。
    group_pattern: str | None = None
    #: フレームの並び順。None なら名前順。指定すると最初の捕獲群を整数として使う
    #: （i10 が i2 より先に来る名前順の罠を避ける）。
    frame_index_pattern: str | None = None


SPECS: dict[str, DatasetSpec] = {
    "cadica": DatasetSpec(
        key="cadica",
        title="CADICA",
        license="CC BY 4.0",
        attribution=(
            "CADICA: a new dataset for coronary artery disease detection by using "
            "invasive coronary angiography (Mendeley Data p9bpx9ctcv, CC BY 4.0)"
        ),
        fps=10.0,
        frames_are_a_sequence=True,
        note="1 ビデオあたり 10 連続フレーム。解析できる数少ない公開データ。",
    ),
    "dias": DatasetSpec(
        key="dias",
        title="DIAS",
        license="CC BY 4.0",
        attribution=(
            "DIAS: A dataset and benchmark for intracranial artery segmentation in "
            "DSA sequences (Zenodo 11401368, CC BY 4.0)"
        ),
        fps=6.0,
        frames_are_a_sequence=True,
        note=("頭蓋内動脈の DSA シーケンス（60 本 × 4〜9 フレーム・800×800）。"
              "⚠️ 差分済みなのでマスクフレームは含まれない。"),
        # 実データで確認（2026-08-27）: 1 ディレクトリに 60 シーケンスが平置きで、
        # 同じ階層に正解マスク（labels/ · scribble_labels/）もある。
        # ディレクトリ単位で束ねると 60 本が 1 本に潰れ、マスクまで混ざる。
        path_include=r"/(?:images|unlabeled_DSA)/",
        group_pattern=r"_s(\d+)_",
        frame_index_pattern=r"_i(\d+)\.",
    ),
    "arcade": DatasetSpec(
        key="arcade",
        title="ARCADE",
        license="CC0 1.0",
        attribution=(
            "ARCADE: Automatic Region-based Coronary Artery Disease diagnostics "
            "using x-ray angiography images (Zenodo 10390295, CC0 1.0)"
        ),
        fps=15.0,
        frames_are_a_sequence=False,
        note="独立した静止画。単一フレームになるので解析ボタンは出ない（表示のみ）。",
    ),
    "mendeley-stenosis": DatasetSpec(
        key="mendeley-stenosis",
        title="Angiographic dataset for stenosis detection",
        license="CC BY 4.0",
        attribution=(
            "Angiographic dataset for stenosis detection "
            "(Mendeley Data ydrm75xywg, CC BY 4.0)"
        ),
        fps=15.0,
        frames_are_a_sequence=False,
        note="独立した静止画。単一フレームになるので解析ボタンは出ない（表示のみ）。",
    ),
    "generic": DatasetSpec(
        key="generic",
        title="(generic)",
        license="",
        attribution="",
        fps=15.0,
        frames_are_a_sequence=True,
        note="--attribution でライセンス表記を渡すこと。",
        verified=False,
    ),
}


@dataclass
class SeriesJob:
    """1 シリーズぶんの入力。"""

    group_key: str
    paths: list[str] = field(default_factory=list)


def _iter_images(root: str) -> list[str]:
    out: list[str] = []
    for base, _dirs, files in os.walk(root):
        for name in sorted(files):
            if name.lower().endswith(IMAGE_SUFFIXES):
                out.append(os.path.join(base, name))
    return sorted(out)


def collect_jobs(src: str, spec: DatasetSpec) -> list[SeriesJob]:
    """入力をシリーズ単位へ束ねる。

    連続フレームを持つデータは、既定では **同じディレクトリのものだけ**を 1 本にする。
    ただし配布形式によっては 1 ディレクトリに何本ものシーケンスが平置きされているので
    （DIAS が実際そうだった）、``group_pattern`` があればファイル名から鍵を取る。
    無関係な静止画を束ねるとフレームごとに別患者になるので、その場合は 1 枚 1 本。
    """
    paths = _iter_images(src)
    if spec.path_include:
        keep = re.compile(spec.path_include)
        paths = [p for p in paths if keep.search(p.replace(os.sep, "/"))]
    if not paths:
        return []

    if not spec.frames_are_a_sequence:
        return [SeriesJob(os.path.relpath(p, src), [p]) for p in paths]

    group_re = re.compile(spec.group_pattern) if spec.group_pattern else None
    order_re = re.compile(spec.frame_index_pattern) if spec.frame_index_pattern else None

    buckets: dict[str, list[str]] = {}
    for p in paths:
        if group_re is None:
            key = os.path.relpath(os.path.dirname(p), src)
            key = "." if key == "." else key
        else:
            m = group_re.search(os.path.basename(p))
            if m is None:
                # 黙って 1 本目へ混ぜない。鍵が取れないものは飛ばして報告する。
                print(f"  ! シリーズ鍵が取れないので飛ばします: {p}", file=sys.stderr)
                continue
            # 配布形式によっては連番が split をまたいで重複する。
            # ディレクトリも鍵に含めて衝突を避ける。
            parent = os.path.relpath(os.path.dirname(p), src).replace(os.sep, "-")
            key = f"{parent}-s{m.group(1)}" if parent != "." else f"s{m.group(1)}"
        buckets.setdefault(key, []).append(p)

    def frame_key(path: str):
        if order_re is None:
            return (0, os.path.basename(path))
        m = order_re.search(os.path.basename(path))
        # 名前順だと i10 が i2 より先に来る。整数として並べる。
        return (int(m.group(1)), "") if m else (10**9, os.path.basename(path))

    return [SeriesJob(k, sorted(buckets[k], key=frame_key)) for k in sorted(buckets)]


def _load_frames(paths: list[str]) -> tuple[np.ndarray, int]:
    """画像を読み、(frames, bits_stored) を返す。

    8bit はそのまま、16bit も受ける。シリーズ内で寸法が違えば弾く
    （引き伸ばして揃えると計測の意味が変わるので、黙って直さない）。
    """
    frames = []
    shape = None
    bits = 8
    for p in paths:
        with Image.open(p) as im:
            if im.mode in ("I;16", "I;16B", "I;16L", "I"):
                arr = np.asarray(im.convert("I"), dtype=np.uint16)
                bits = 16
            else:
                arr = np.asarray(im.convert("L"), dtype=np.uint8)
        if shape is None:
            shape = arr.shape
        elif arr.shape != shape:
            raise ValueError(
                f"シリーズ内で画像の寸法が違う: {paths[0]} は {shape}, {p} は {arr.shape}。"
                f" 引き伸ばして揃えると計測の意味が変わるので、ここでは直さない。"
            )
        frames.append(arr)
    stacked = np.stack(frames, axis=0)
    if bits == 16:
        return stacked.astype("<u2"), 16
    return stacked.astype(np.uint8), 8


def build_xa(
    frames: np.ndarray,
    bits: int,
    *,
    spec: DatasetSpec,
    group_key: str,
    attribution: str,
    fps: float,
) -> Dataset:
    """マルチフレーム（または単一フレーム）XA インスタンスを組む。

    🚨 空間校正・投影幾何のタグは**意図的に一切書かない**。冒頭の docstring を参照。
    """
    n_frames, rows, columns = int(frames.shape[0]), int(frames.shape[1]), int(frames.shape[2])
    uid_key = f"{spec.key}/{group_key}"
    sop_uid = deterministic_uid("wrap-public-xa", uid_key, "sop")

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

    # 患者は仮名。元データが既に匿名化されているので、こちらで新たな同定情報は作らない。
    pseudo = hashlib.sha256(uid_key.encode("utf-8")).hexdigest()[:8].upper()
    ds.PatientID = f"{spec.key.upper()}-{pseudo}"
    ds.PatientName = f"{spec.title}^{pseudo}"
    ds.PatientBirthDate = ""
    ds.PatientSex = "O"
    ds.PatientIdentityRemoved = "YES"
    ds.DeidentificationMethod = "published de-identified by the source dataset"

    ds.StudyInstanceUID = deterministic_uid("wrap-public-xa", spec.key, group_key, "study")
    ds.SeriesInstanceUID = deterministic_uid("wrap-public-xa", uid_key, "series")
    ds.StudyID = spec.key.upper()[:16]
    ds.AccessionNumber = ""
    ds.StudyDate = "20260101"
    ds.StudyTime = "120000"
    ds.SeriesDate = "20260101"
    ds.SeriesTime = "120000"
    ds.ContentDate = "20260101"
    ds.ContentTime = "120000"
    ds.StudyDescription = f"{spec.title} (public dataset)"
    ds.SeriesDescription = f"{spec.title} {group_key}"[:64]
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.Manufacturer = "Visionary Imaging Services"
    ds.ManufacturerModelName = "wrap_public_xa"
    ds.SoftwareVersions = "wrap_public_xa/1"

    # 出典を画像そのものに焼き込む（CC BY は帰属が必須で、画像だけが独り歩きしうる）。
    ds.ImageComments = attribution[:10240]
    ds.DerivationDescription = (
        "wrapped from a public image dataset by bench/wrap_public_xa.py; "
        "no spatial calibration or projection geometry is available"
    )

    # ── 画像 ──────────────────────────────────────────────────────────
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = rows
    ds.Columns = columns
    ds.BitsAllocated = 16 if bits == 16 else 8
    ds.BitsStored = 16 if bits == 16 else 8
    ds.HighBit = 15 if bits == 16 else 7
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = n_frames
    ds.PixelData = frames.tobytes()

    # 時間軸。マルチフレームのときだけ書く（§5.4 の fps 連鎖 P2 を通す）。
    if n_frames > 1:
        frame_time_ms = 1000.0 / float(fps)
        ds.FrameTime = f"{frame_time_ms:.3f}"
        ds.FrameIncrementPointer = 0x00181063  # FrameTime
        ds.CineRate = int(round(fps))

    ds.PixelIntensityRelationship = "LIN"
    ds.PixelIntensityRelationshipSign = 1

    # 🚨 ImagerPixelSpacing / PixelSpacing / DistanceSourceTo* / Positioner*Angle は
    #    **書かない**。元データに無く、埋めると未校正の画像が mm で測られてしまう。
    return ds


def run(src: str, out: str, spec: DatasetSpec, *, attribution: str, fps: float,
        limit: int | None, dry_run: bool) -> int:
    jobs = collect_jobs(src, spec)
    if not jobs:
        print(f"入力に画像が見つかりません: {src}", file=sys.stderr)
        return 1
    if limit is not None:
        jobs = jobs[:limit]

    if not spec.frames_are_a_sequence:
        print(f"⚠️  {spec.title} は独立した静止画なので **単一フレーム** で出力します。")
        print("    XA の解析（QCA / QVA / LV）はフレーム軸を持つスタックにしか出ないため、")
        print("    取り込んでも解析ボタンは出ません（表示・見た目の確認用）。")

    if not dry_run:
        os.makedirs(out, exist_ok=True)

    written = 0
    total_frames = 0
    for job in jobs:
        try:
            frames, bits = _load_frames(job.paths)
        except ValueError as e:
            print(f"  ! 飛ばしました（{job.group_key}）: {e}", file=sys.stderr)
            continue
        name = job.group_key.replace(os.sep, "_").replace(".", "_") or "series"
        path = os.path.join(out, f"{spec.key}_{name}.dcm")
        total_frames += int(frames.shape[0])
        if dry_run:
            print(f"  [dry-run] {path}  {frames.shape[0]} frames  "
                  f"{frames.shape[2]}x{frames.shape[1]}  {bits}bit")
        else:
            ds = build_xa(frames, bits, spec=spec, group_key=job.group_key,
                          attribution=attribution, fps=fps)
            ds.save_as(path, enforce_file_format=True)
            print(f"  + {path}  {frames.shape[0]} frames  "
                  f"{frames.shape[2]}x{frames.shape[1]}  {bits}bit")
        written += 1

    print(f"\n{written} シリーズ / {total_frames} フレーム"
          f"{'（dry-run。書き出していません）' if dry_run else ''}")
    if not dry_run and spec.license:
        print(f"ライセンス: {spec.license}")
        print(f"出典表記  : {attribution}")
        if spec.license.startswith("CC BY"):
            print("⚠️ CC BY は出典表記が必須です。記事・スライドの図キャプションにも入れてください。")
    print("⚠️ 空間校正のタグは書いていません。GRAPHY-Next では px 表示になります（正しい挙動）。")
    print("⚠️ 精度の検証には使えません。真値が要るなら GNBP-XA（§16.3）を使ってください。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="公開データセットの画像を XA マルチフレーム DICOM に包む",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="対応データセット: " + ", ".join(sorted(SPECS)),
    )
    ap.add_argument("--dataset", required=True, choices=sorted(SPECS))
    ap.add_argument("--src", required=True, help="展開済みの画像があるディレクトリ")
    ap.add_argument("--out", required=True, help="DICOM の出力先")
    ap.add_argument("--fps", type=float, default=None, help="シネの再生速度（既定はデータセットごと）")
    ap.add_argument("--attribution", default=None, help="出典表記（generic では必須）")
    ap.add_argument("--limit", type=int, default=None, help="先頭 N シリーズだけ処理する")
    ap.add_argument("--dry-run", action="store_true", help="何ができるかだけ表示する")
    args = ap.parse_args()

    spec = SPECS[args.dataset]
    attribution = args.attribution or spec.attribution
    if not attribution:
        print("--attribution が要ります（ライセンス表記の無いデータは包みません）。",
              file=sys.stderr)
        return 2
    if not spec.verified:
        print("⚠️ generic モードです。**ライセンスは自分で確認してください**"
              "（§16.2.1 に確認済みの一覧があります）。")

    if spec.note:
        print(f"{spec.title}: {spec.note}")
    return run(args.src, args.out, spec,
               attribution=attribution, fps=args.fps or spec.fps,
               limit=args.limit, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())

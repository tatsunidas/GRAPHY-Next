#!/usr/bin/env python3
"""動画（AVI 等）を DICOM Ultrasound Multi-frame（H.264 encapsulated）へラップする。

用途
----
胎児心エコーの動画要約プラグイン（`fw/uvs-plugin-design.md`）の**入力サンプルを作る**ため。
元アプリ `UltrasoundVideoSummarization-Web` の取り込み（`importer/VideoImportService` ＋
`video/DicomVideoWriter`）と**同じ形**の DICOM を作る。

🔴 **これは検証用のサンプルを作る道具であって、製品の取り込み経路ではない。**
本体の取り込みは `NonDicomImporter`（`fw/nondicom-ffmpeg.md`）が担当する。

⚠️ 出力は実データ由来なので**リポジトリに置かない**（`bench/` は「ファントムと検証コードのみ」）。

使い方
------
    python3 scripts/wrap-video-as-us-multiframe.py IN.avi OUT.dcm [--frames 600] [--fps 29.97]

要件
----
ffmpeg / ffprobe（PATH 上）、pydicom。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import UID, generate_uid

#: Ultrasound Multi-frame Image Storage。
US_MULTIFRAME_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.3.1"
#: MPEG-4 AVC/H.264 High Profile / Level 4.1。
MPEG4_HP41 = "1.2.840.10008.1.2.4.102"


def probe(path: str) -> dict:
    """動画の諸元（幅・高さ・fps・フレーム数）を読む。"""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
            "-of", "json", path,
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    st = json.loads(out)["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    return {
        "width": int(st["width"]),
        "height": int(st["height"]),
        "fps": float(num) / float(den),
        "frames": int(st.get("nb_frames") or 0),
    }


def transcode(src: str, dst: str, frames: int | None) -> None:
    """H.264 High / Level 4.1 の MP4 へ変換する。

    🔴 **`-bf 0`（B フレーム無し）は必須。** dcm4che の `MP4Parser` が B フレームを含む
    ストリームを受け付けない（元アプリが実際に踏んでいる制約）。
    🔴 **`-pix_fmt yuv420p`** なので **縦横は偶数**でなければならない。奇数なら scale で丸める。
    """
    meta = probe(src)
    w = meta["width"] - (meta["width"] % 2)
    h = meta["height"] - (meta["height"] % 2)
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", src]
    if frames:
        cmd += ["-frames:v", str(frames)]
    if (w, h) != (meta["width"], meta["height"]):
        cmd += ["-vf", f"scale={w}:{h}"]
    cmd += [
        "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
        "-bf", "0",                 # ← dcm4che MP4Parser の制約
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",  # Range シーク用
        "-an",                      # 音声は落とす
        dst,
    ]
    subprocess.run(cmd, check=True)


def build_dataset(mp4_path: str, meta: dict, patient_id: str, patient_name: str,
                  description: str) -> Dataset:
    n_frames = meta["frames"]
    fps = meta["fps"]

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = UID(US_MULTIFRAME_SOP_CLASS)
    sop_uid = generate_uid()
    file_meta.MediaStorageSOPInstanceUID = sop_uid
    file_meta.TransferSyntaxUID = UID(MPEG4_HP41)

    ds = Dataset()
    ds.file_meta = file_meta
    ds.preamble = b"\0" * 128

    now = datetime.datetime.now()
    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.SOPClassUID = UID(US_MULTIFRAME_SOP_CLASS)
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = "US"
    ds.PatientID = patient_id
    ds.PatientName = patient_name
    ds.PatientBirthDate = "19700101"
    ds.PatientSex = "O"
    ds.StudyID = "UVS"
    ds.AccessionNumber = "UVS"
    ds.StudyDate = now.strftime("%Y%m%d")
    ds.StudyTime = now.strftime("%H%M%S")
    ds.SeriesDate = ds.StudyDate
    ds.SeriesTime = ds.StudyTime
    ds.ContentDate = ds.StudyDate
    ds.ContentTime = ds.StudyTime
    ds.StudyDescription = "Fetal echocardiography (sample)"
    ds.SeriesDescription = description
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.Manufacturer = "Visionary Imaging Services"
    ds.ManufacturerModelName = "wrap-video-as-us-multiframe"

    # ── 画像記述（H.264 4:2:0 に載せるので、元が白黒でも 3 サンプルになる）──
    ds.SamplesPerPixel = 3
    ds.PhotometricInterpretation = "YBR_PARTIAL_420"
    ds.PlanarConfiguration = 0
    ds.Rows = meta["height"]
    ds.Columns = meta["width"]
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = n_frames
    ds.ImageType = ["ORIGINAL", "PRIMARY"]

    # ── 時間軸 ──
    ds.FrameTime = f"{1000.0 / fps:.4f}"
    ds.FrameIncrementPointer = 0x00181063  # FrameTime
    ds.CineRate = int(round(fps))
    ds.StartTrim = 1
    ds.StopTrim = n_frames

    ds.UltrasoundColorDataPresent = 0
    ds.LossyImageCompression = "01"
    ds.LossyImageCompressionMethod = "ISO_14496_10"

    # ── PixelData: 未定義長 ＋ 空の BOT ＋ MP4 を 1 フラグメント ──
    # 🔴 元アプリ（`DicomVideoWriter#write`）と同じ形にする。フレームごとに分割しない。
    with open(mp4_path, "rb") as fh:
        mp4 = fh.read()
    ds.PixelData = encapsulate([mp4], has_bot=False)
    ds["PixelData"].is_undefined_length = True

    ds.is_little_endian = True
    ds.is_implicit_VR = False
    return ds


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="元の動画（AVI/MP4 等）")
    ap.add_argument("output", help="出力する DICOM")
    ap.add_argument("--frames", type=int, default=None, help="先頭 N フレームだけ使う（検証用）")
    ap.add_argument("--patient-id", default="UVS-SAMPLE")
    ap.add_argument("--patient-name", default="UVS^SAMPLE")
    ap.add_argument("--description", default="Fetal heart cine (wrapped)")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"入力がありません: {args.input}")

    src_meta = probe(args.input)
    print(f"入力: {src_meta['width']}x{src_meta['height']} "
          f"{src_meta['fps']:.3f}fps {src_meta['frames']} フレーム")

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = os.path.join(tmp, "video.mp4")
        print("H.264 High / Level 4.1 へ変換中（-bf 0）…")
        transcode(args.input, mp4, args.frames)
        mp4_meta = probe(mp4)
        # 🔑 **フレーム数は変換後の実測を使う。** 元の nb_frames は容器によっては嘘をつく。
        if mp4_meta["frames"] <= 0:
            sys.exit("変換後のフレーム数を読めませんでした")
        print(f"変換後: {mp4_meta['width']}x{mp4_meta['height']} "
              f"{mp4_meta['fps']:.3f}fps {mp4_meta['frames']} フレーム "
              f"({os.path.getsize(mp4) / 1e6:.1f} MB)")

        ds = build_dataset(mp4, mp4_meta, args.patient_id, args.patient_name, args.description)
        ds.save_as(args.output, enforce_file_format=True)

    size = os.path.getsize(args.output)
    print(f"出力: {args.output}  ({size / 1e6:.1f} MB)")
    print(f"  SOPClass  {US_MULTIFRAME_SOP_CLASS}（US Multi-frame）")
    print(f"  TS        {MPEG4_HP41}（MPEG-4 AVC/H.264 HP@4.1）")
    print(f"  Modality  US / YBR_PARTIAL_420 / SamplesPerPixel 3")
    print(f"  Frames    {ds.NumberOfFrames} / FrameTime {ds.FrameTime} ms")


if __name__ == "__main__":
    main()

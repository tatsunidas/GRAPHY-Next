#!/usr/bin/env python3
"""MPEG2 の DICOM video（Video Photographic）を合成する検証用スクリプト。

なぜ必要か: 取込経路（NonDicomImporter → VideoConverter）は非 H.264 を **取込時に H.264 へ変換**して
しまうため、「MPEG2 転送構文の DICOM」は取込では作れない。P4（配信時の ffmpeg 変換）を実機で確かめるには
**MPEG2 のまま encapsulate された DICOM** が必要なので、ここで直接組み立てる。

生成物の中身: MPEG-2 video の**基本ストリーム**（コンテナ無し）。正規 DICOM の MPEG2 と同じ形。
フレームごとに輝度が飛び飛びに変わる（`16 + mod(N*13,30)*7`）ので、変換後にフレームが入れ替わったり
落ちたりしていないかを数値で確認できる。

使い方:
    python3 make-mpeg2-video-dicom.py <出力.dcm> [--frames 30] [--fps 15] [--ffmpeg ffmpeg]

必要: ffmpeg（映像の生成）と pydicom（DICOM の組み立て）。
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import tempfile


def synthesize_mpeg2(ffmpeg: str, frames: int, fps: int, out: pathlib.Path) -> bytes:
    """フレームごとに輝度が変わる MPEG-2 基本ストリームを作る。"""
    duration = frames / fps
    # ⚠ 生の MPEG-2 映像は muxer 名が mpeg2video / demuxer 名が mpegvideo で異なる（出力側は mpeg2video）。
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black:s=320x240:r={fps}:d={duration}",
        "-vf", f"geq=lum='16 + mod(N*13,{frames})*7':cb=128:cr=128,format=yuv420p",
        "-an", "-c:v", "mpeg2video", "-f", "mpeg2video", str(out),
    ]
    subprocess.run(cmd, check=True)
    return out.read_bytes()


def build_dicom(payload: bytes, frames: int, fps: int, dest: pathlib.Path) -> str:
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.encaps import encapsulate
    from pydicom.uid import UID, generate_uid

    mpeg2_mp_ml = UID("1.2.840.10008.1.2.4.100")  # MPEG2 Main Profile @ Main Level
    video_photographic = UID("1.2.840.10008.5.1.4.1.1.77.1.4.1")
    sop_uid = generate_uid()

    ds = Dataset()
    ds.SOPClassUID = video_photographic
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.PatientName = "VIDEO^MPEG2"
    ds.PatientID = "VIDEO-MPEG2"
    ds.PatientBirthDate = ""
    ds.PatientSex = ""
    ds.StudyDate = "20260730"
    ds.StudyTime = "120000"
    ds.StudyDescription = "automator mpeg2"
    ds.SeriesDescription = "mpeg2 video"
    ds.AccessionNumber = ""
    ds.Modality = "XC"
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    # 動画のピクセル諸元（MPEG2 は YBR_PARTIAL_420 / 3 サンプル）。
    ds.SamplesPerPixel = 3
    ds.PhotometricInterpretation = "YBR_PARTIAL_420"
    ds.PlanarConfiguration = 0
    ds.Rows = 240
    ds.Columns = 320
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = frames
    ds.FrameTime = 1000.0 / fps
    ds.CineRate = fps
    ds.FrameIncrementPointer = 0x00181063  # FrameTime
    ds.LossyImageCompression = "01"
    ds.PixelData = encapsulate([payload])
    ds["PixelData"].is_undefined_length = True

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = video_photographic
    fm.MediaStorageSOPInstanceUID = sop_uid
    fm.TransferSyntaxUID = mpeg2_mp_ml
    fm.ImplementationClassUID = generate_uid()
    ds.file_meta = fm
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    dest.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(str(dest), enforce_file_format=True)
    return sop_uid


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dest", type=pathlib.Path)
    ap.add_argument("--frames", type=int, default=30)
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        es = synthesize_mpeg2(args.ffmpeg, args.frames, args.fps, pathlib.Path(tmp) / "src.m2v")
    sop = build_dicom(es, args.frames, args.fps, args.dest)
    print(f"{args.dest} ({len(es)} bytes MPEG-2 ES, {args.frames} frames, sop={sop})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

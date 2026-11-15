#!/usr/bin/env python3
"""細い縞の合成 CT（DICOM）を作る。患者情報を含まない。シネマティックの解像度の効果の実アプリ検査（cinematicStepsCheck）で使う。

空気（-1000 HU）の中に、**x 方向の幅が 1 ボクセル**・y と z に伸びた板（縞、HU 1000）を、x 方向に周期 4 ボクセルで並べる。
z 方向から見ると、縦の細い線が 0.5 mm（既定）の幅で並ぶ。位置は `--phase`（縞の x ≡ phase mod 4）で決める。
旧コードは各軸を 256 に最近傍で間引く（512 → 256 は偶数列だけを拾う）ので、phase が奇数だと縞を全部落とす（phase が偶数なら残る）。
どちらの位相でも作れるようにして、どちらを使ったかを検査の記録に残す。

使い方:
  python3 make-stripes-ct-phantom.py <出力フォルダ> --dims 512,512,64 --spacing 0.5,0.5,1.0 [--phase 1] [--patient-id PH-STRIPE]
出力: <出力フォルダ>/z0001.dcm …、<出力フォルダ>/expected.json（寸法・間隔・phase・縞の範囲）
"""
import argparse
import json
import os

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

PERIOD = 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--dims", required=True)
    ap.add_argument("--spacing", required=True)
    ap.add_argument("--phase", type=int, default=1)
    ap.add_argument("--patient-id", default="PH-STRIPE")
    a = ap.parse_args()
    nx, ny, nz = (int(x) for x in a.dims.split(","))
    sx, sy, sz = (float(x) for x in a.spacing.split(","))
    x0, x1 = nx // 8, nx - nx // 8        # 縞のある x の範囲（箱の縁から離す）
    y0, y1 = ny // 8, ny - ny // 8
    os.makedirs(a.out, exist_ok=True)
    study, series, frame = generate_uid(), generate_uid(), generate_uid()
    hu = np.full((ny, nx), -1000.0)
    for x in range(x0, x1):
        if x % PERIOD == a.phase % PERIOD:
            hu[y0:y1, x] = 1000.0
    for k in range(nz):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientID, ds.PatientName = a.patient_id, "PHANTOM^STRIPE"
        ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "CT", 1, k + 1
        ds.ImagePositionPatient = [f"{-(nx - 1) * sx / 2:.6f}", f"{-(ny - 1) * sy / 2:.6f}", f"{k * sz:.6f}"]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing = [f"{sy}", f"{sx}"]
        ds.SliceThickness = sz
        ds.Rows, ds.Columns = ny, nx
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
        ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = 1, 0, "HU"
        ds.WindowCenter, ds.WindowWidth = 0, 2200
        ds.PixelData = hu.astype("<i2").tobytes()
        ds.save_as(os.path.join(a.out, f"z{k + 1:04d}.dcm"), write_like_original=False)
    json.dump({"dims": [nx, ny, nz], "spacing": [sx, sy, sz], "phase": a.phase, "period": PERIOD, "xRange": [x0, x1], "yRange": [y0, y1]}, open(os.path.join(a.out, "expected.json"), "w"))
    print(f"made {nx}x{ny}x{nz} spacing {sx},{sy},{sz}  縞: x ≡ {a.phase % PERIOD} (mod {PERIOD}), x in [{x0},{x1}), y in [{y0},{y1})")


if __name__ == "__main__":
    main()

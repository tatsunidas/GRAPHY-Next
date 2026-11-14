#!/usr/bin/env python3
"""任意の寸法・間隔の合成 CT（DICOM）と、読み戻し検査用の期待値を作る。患者情報を含まない。シネマティックの 3D テクスチャの実アプリ検査（cinematicResolutionCheck）で使う。

値は「ボクセルの添字だけで決まる式」: HU = floor(-950 + 1900·(0.5·i/(nx-1) + 0.3·j/(ny-1) + 0.2·k/(nz-1)) + 0.5) + 40·(-1)^(i+j+k)
（ゆるい傾斜に 1 ボクセルごとの市松の細かい成分を足したもの。市松があるので、最近傍・平均・位置のずれで値が変わる）。
中央に半径 R の球（HU 1000）を置いて、画面に像が出るようにする。傾斜と球の外は空気ではない（表示の窓で見える値）。
向きは IOP が単位行列・IPP が z 方向に等間隔（LPS）。RescaleSlope=1・Intercept=0（保存値＝HU。符号つき 16 bit）。

使い方:
  python3 make-ramp-ct-phantom.py <出力フォルダ> --dims 288,288,272 --spacing 0.8,0.8,1.0 [--patient-id PH-RAMP] [--layers 0,136,271]
出力: <出力フォルダ>/z0001.dcm …、<出力フォルダ>/expected.json
  expected.json = { dims, spacing, min, max, layers: { "<k>": [正規化した期待値 nx*ny（x が最速）] } }
  正規化は (HU − min) / (max − min)（min・max は全ボクセルの最小・最大。パストレーサが使う値域と同じ定義）。
"""
import argparse
import json
import os

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


def hu_slab(nx, ny, nz, k, radius):
    i = np.arange(nx)[None, :]
    j = np.arange(ny)[:, None]
    r = 0.5 * i / max(nx - 1, 1) + 0.3 * j / max(ny - 1, 1) + 0.2 * k / max(nz - 1, 1)
    hu = np.floor(-950.0 + 1900.0 * r + 0.5) + 40.0 * np.where((i + j + k) % 2 == 0, 1.0, -1.0)
    cx, cy, cz = (nx - 1) / 2.0, (ny - 1) / 2.0, (nz - 1) / 2.0
    d2 = (i - cx) ** 2 + (j - cy) ** 2 + (k - cz) ** 2
    hu = np.where(d2 <= radius**2, 1000.0, hu)
    return hu


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--dims", required=True)
    ap.add_argument("--spacing", required=True)
    ap.add_argument("--patient-id", default="PH-RAMP")
    ap.add_argument("--layers", default="")
    a = ap.parse_args()
    nx, ny, nz = (int(x) for x in a.dims.split(","))
    sx, sy, sz = (float(x) for x in a.spacing.split(","))
    radius = min(nx, ny, nz) / 6.0
    os.makedirs(a.out, exist_ok=True)
    study, series, frame = generate_uid(), generate_uid(), generate_uid()
    lo, hi = float("inf"), float("-inf")
    for k in range(nz):
        s = hu_slab(nx, ny, nz, k, radius)
        lo, hi = min(lo, float(s.min())), max(hi, float(s.max()))
    layers = [int(x) for x in a.layers.split(",") if x] or [0, nz // 2, nz - 1]
    expected = {}
    for k in range(nz):
        hu = hu_slab(nx, ny, nz, k, radius)
        if k in layers:
            expected[str(k)] = ((hu - lo) / (hi - lo)).astype(np.float32).ravel().tolist()
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientID, ds.PatientName = a.patient_id, "PHANTOM^RAMP"
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
    json.dump({"dims": [nx, ny, nz], "spacing": [sx, sy, sz], "min": lo, "max": hi, "layers": expected}, open(os.path.join(a.out, "expected.json"), "w"))
    print(f"made {nx}x{ny}x{nz} spacing {sx},{sy},{sz}  HU range [{lo}, {hi}]  layers {layers}")


if __name__ == "__main__":
    main()

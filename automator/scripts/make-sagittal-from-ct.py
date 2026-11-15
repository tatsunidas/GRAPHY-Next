#!/usr/bin/env python3
"""実 CT（軸位）から、補間なしの軸の入れ替えで矢状断の DICOM シリーズを作る（NIfTI 書き出しの向きの目視用）。

  python make-sagittal-from-ct.py <軸位 CT の DICOM フォルダ> <出力フォルダ>

元は、列が患者の左（+x）へ・行が後方（+y）へ・スライスが上（+z）へ進む標準の軸位 CT（IOP = 1,0,0,0,1,0）。
矢状断の画像 i（x = x0 + i·Δx）は、列 c が後方（+y）へ、行 r が下（−z）へ進む: IOP = 0,1,0, 0,0,−1。
  画素 [r, c] = 元の [k = nz−1−r（上が先）, j = c, i]。IPP = (x0 + i·Δx, y0, z_top)。
補間しない（画素値は元のまま）。PixelSpacing = [行間隔 = 元のスライス間隔, 列間隔 = 元の行間隔]、SliceThickness = 元の画素間隔(x)。
作った後に、IOP が単位ベクトルで直交・IPP の差が法線方向に等間隔であることを検算して表示する。
UID はすべて新しく振る（古い宣言のメタデータを引きずらない）。患者情報は元から引き継がない（ID・名前は固定の仮名）。
元の実 CT は公開データ（匿名化済み）だが、派生もリポジトリに入れない（出力は scratchpad 等へ）。
"""
import glob
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

slices = []
for f in glob.glob(os.path.join(src, "*")):
    try:
        d = pydicom.dcmread(f)
    except Exception:
        continue
    if getattr(d, "Modality", "") == "CT" and "PixelData" in d:
        slices.append(d)
assert slices, "CT のスライスが見つかりません"
iop0 = np.array([float(x) for x in slices[0].ImageOrientationPatient])
assert np.allclose(iop0, [1, 0, 0, 0, 1, 0], atol=1e-6), f"標準の軸位ではありません: {iop0}"
slices.sort(key=lambda d: float(d.ImagePositionPatient[2]))  # 下 → 上
nz = len(slices)
zs = np.array([float(d.ImagePositionPatient[2]) for d in slices])
dz = np.diff(zs)
assert np.allclose(dz, dz[0], atol=1e-3), f"スライス間隔が不均一です: {np.unique(np.round(dz, 4))}"
ny, nx = int(slices[0].Rows), int(slices[0].Columns)
dy, dx = (float(v) for v in slices[0].PixelSpacing)  # [行間隔(y), 列間隔(x)]
x0, y0 = float(slices[0].ImagePositionPatient[0]), float(slices[0].ImagePositionPatient[1])
slope = float(slices[0].get("RescaleSlope", 1)); inter = float(slices[0].get("RescaleIntercept", 0))
vol = np.stack([d.pixel_array for d in slices], axis=0)  # [k, j, i] stored 値
assert vol.shape == (nz, ny, nx)
z_top = float(zs[-1])
dslice = float(dz[0])

study, series, frame = generate_uid(), generate_uid(), generate_uid()
for i in range(nx):
    img = vol[::-1, :, i]  # [r, c] = vol[nz-1-r, c, i]
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    sop = generate_uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
    ds.PatientID, ds.PatientName = "DERIVED-SAGITTAL", "Derived^Sagittal"
    ds.StudyDate, ds.StudyDescription = "20260101", "sagittal from real CT"
    ds.Modality, ds.SeriesNumber, ds.SeriesDescription, ds.InstanceNumber = "CT", 7, "sagittal (axis swap)", i + 1
    ds.ImageOrientationPatient = [0, 1, 0, 0, 0, -1]
    ds.ImagePositionPatient = [x0 + i * dx, y0, z_top]
    ds.PixelSpacing = [dslice, dy]          # [行間隔（z 方向）, 列間隔（y 方向）]
    ds.SliceThickness = dx
    ds.Rows, ds.Columns = nz, ny
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = int(slices[0].PixelRepresentation)
    ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = slope, inter, "HU"
    ds.PixelData = np.ascontiguousarray(img).astype(np.int16 if ds.PixelRepresentation else np.uint16).tobytes()
    ds.save_as(os.path.join(out, f"s{i:04d}.dcm"), write_like_original=False)

# 検算（作った DICOM を読み直す）
fs = sorted(glob.glob(os.path.join(out, "*.dcm")))
ds0 = [pydicom.dcmread(f, stop_before_pixels=True) for f in fs]
r = np.array(ds0[0].ImageOrientationPatient[:3], float); c = np.array(ds0[0].ImageOrientationPatient[3:], float)
n = np.cross(r, c)
ipp = np.array([[float(v) for v in d.ImagePositionPatient] for d in ds0])
steps = np.diff(ipp @ n)
print(f"slices={len(fs)} rows={nz} cols={ny} | |r|={np.linalg.norm(r):.6f} |c|={np.linalg.norm(c):.6f} r·c={r@c:.2e} normal={n}")
print(f"IPP 差と法線の内積: min={steps.min():.6f} max={steps.max():.6f}（Δx={dx}）; IPP 差の法線以外の成分の最大={np.abs(np.diff(ipp, axis=0) - np.outer(steps, n)).max():.2e}")
assert abs(np.linalg.norm(r) - 1) < 1e-9 and abs(np.linalg.norm(c) - 1) < 1e-9 and abs(r @ c) < 1e-9
assert np.allclose(steps, steps[0], atol=1e-6) and np.abs(np.diff(ipp, axis=0) - np.outer(steps, n)).max() < 1e-6
print("OK")

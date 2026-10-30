"""NIfTI の 3D T1 を、DICOM MR の 1 シリーズ（1 スライス 1 ファイル）に書き出す。実機検証（spike）用。

向きは NIfTI のアフィンをそのまま DICOM の患者座標（LPS）へ写す（再サンプルしない）。
使い方: python niftiToDicomSeries.py <in.nii.gz> <out_dir> --age 72 --sex M --field 3 [--patient-name X --birth-date YYYYMMDD --study-date YYYYMMDD]
依存: nibabel, numpy, pydicom
"""
import argparse
import os

import nibabel as nib
import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

MR_STORAGE = "1.2.840.10008.5.1.4.1.1.4"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("nifti")
    ap.add_argument("out_dir")
    ap.add_argument("--age", type=int, required=True)
    ap.add_argument("--sex", choices=["M", "F"], required=True)
    ap.add_argument("--field", type=float, required=True)
    ap.add_argument("--patient-id", default="SPIKE-IXI-0001")
    ap.add_argument("--patient-name", default="SPIKE^IXI")
    ap.add_argument("--birth-date", default="", help="YYYYMMDD（PatientBirthDate。空なら書かない）")
    ap.add_argument("--study-date", default="20260101", help="YYYYMMDD（StudyDate）")
    ap.add_argument("--manufacturer", default="", help="Manufacturer（空なら書かない。撮像条件の自動入力の検査用）")
    a = ap.parse_args()

    img = nib.load(a.nifti)
    data = np.asarray(img.dataobj)
    if data.ndim != 3:
        raise SystemExit(f"3 次元ではありません: {data.shape}")
    if data.min() < 0 or data.max() > 32767:
        raise SystemExit(f"int16 に収まりません: {data.min()}..{data.max()}")
    data = data.astype(np.int16)
    aff = img.affine.copy()
    aff[:2, :] *= -1  # RAS → LPS
    sx, sy, sz = (np.linalg.norm(aff[:3, i]) for i in range(3))
    row_dir = aff[:3, 0] / sx  # 画像の行に沿って（列番号 i が増える向き）
    col_dir = aff[:3, 1] / sy  # 画像の列に沿って（行番号 j が増える向き）
    os.makedirs(a.out_dir, exist_ok=True)

    study, series, frame = generate_uid(), generate_uid(), generate_uid()
    n_i, n_j, n_k = data.shape
    for k in range(n_k):
        meta = FileMetaDataset()
        sop = generate_uid()
        meta.MediaStorageSOPClassUID = MR_STORAGE
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = MR_STORAGE, sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientName, ds.PatientID = a.patient_name, a.patient_id
        if a.birth_date:
            ds.PatientBirthDate = a.birth_date
        ds.PatientSex, ds.PatientAge = a.sex, f"{a.age:03d}Y"
        ds.StudyDate, ds.StudyID, ds.AccessionNumber = a.study_date, "1", "SPIKE1"
        ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "MR", 1, k + 1
        ds.StudyDescription, ds.SeriesDescription = "spike", "T1 3D (IXI)"
        ds.MagneticFieldStrength = a.field
        if a.manufacturer:
            ds.Manufacturer = a.manufacturer
        ds.ImageType = ["ORIGINAL", "PRIMARY", "M", "NORM"]
        pos = (aff @ np.array([0, 0, k, 1.0]))[:3]
        ds.ImagePositionPatient = [f"{v + 0.0:.6f}" for v in pos]   # +0.0 で -0.0 を 0 にする
        ds.ImageOrientationPatient = [f"{v + 0.0:.8f}" for v in (*row_dir, *col_dir)]
        ds.PixelSpacing = [f"{sy:.6f}", f"{sx:.6f}"]  # [行間隔（j 方向）, 列間隔（i 方向）]
        ds.SliceThickness = f"{sz:.6f}"
        ds.SpacingBetweenSlices = f"{sz:.6f}"
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.Rows, ds.Columns = n_j, n_i
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 1
        ds.RescaleIntercept, ds.RescaleSlope = "0", "1"
        ds.PixelData = np.ascontiguousarray(data[:, :, k].T).tobytes()
        ds.save_as(os.path.join(a.out_dir, f"s{k + 1:04d}.dcm"), enforce_file_format=True)
    print(f"{n_k} slices -> {a.out_dir}  spacing=({sx:.4f},{sy:.4f},{sz:.4f})")


if __name__ == "__main__":
    main()

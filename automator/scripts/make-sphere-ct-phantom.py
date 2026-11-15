#!/usr/bin/env python3
"""球だけの合成 CT（DICOM）を作る。患者情報を含まない。3D の視点・クリップ面の実アプリ検査（viewer3dCameraClipCheck）で使う。

空気（-1000 HU）の立方体に、患者座標 LPS（mm）の中心と半径を式で置いた球（既定 +1000 HU）を作る。
立方体は 1 mm 等方、中心が LPS の原点。向きは IOP が単位行列・IPP が z 方向に等間隔（LPS）。

使い方:
  python3 make-sphere-ct-phantom.py <出力フォルダ> --spheres '[{"c":[x,y,z],"r":6},…]' [--n 160] [--patient-id PH-SPH]
出力: <出力フォルダ>/z001.dcm …
"""
import argparse
import json
import os

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--spheres", required=True)
    ap.add_argument("--n", type=int, default=160)
    ap.add_argument("--patient-id", default="PH-SPH")
    a = ap.parse_args()
    spheres = json.loads(a.spheres)
    n = a.n
    coords = np.arange(n) - (n - 1) / 2.0  # 立方体の中心が LPS の原点（mm）
    yy, xx = np.meshgrid(coords, coords, indexing="ij")
    study_uid, series_uid, for_uid = generate_uid(), generate_uid(), generate_uid()
    os.makedirs(a.out, exist_ok=True)
    for k in range(n):
        z = coords[k]
        hu = np.full((n, n), -1000.0)
        for s in spheres:
            cx, cy, cz = s["c"]
            d2 = (xx - cx) ** 2 + (yy - cy) ** 2 + (z - cz) ** 2
            hu = np.where(d2 <= s["r"] ** 2, s.get("v", 1000.0), hu)
        pix = np.clip(np.rint(hu + 1024), 0, 65535).astype("<u2")
        sop = generate_uid()
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID = meta.MediaStorageSOPClassUID
        ds.SOPInstanceUID = sop
        ds.PatientName = "PHANTOM^SPHERES"
        ds.PatientID = a.patient_id
        ds.StudyInstanceUID = study_uid
        ds.StudyDate = "20261110"
        ds.StudyDescription = "Digital sphere CT phantom"
        ds.SeriesInstanceUID = series_uid
        ds.SeriesNumber = 1
        ds.SeriesDescription = "Spheres"
        ds.Modality = "CT"
        ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
        ds.FrameOfReferenceUID = for_uid
        ds.InstanceNumber = k + 1
        ds.Rows, ds.Columns = n, n
        ds.PixelSpacing = [1.0, 1.0]
        ds.SliceThickness = 1.0
        ds.SpacingBetweenSlices = 1.0
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [float(coords[0]), float(coords[0]), float(z)]
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleIntercept = -1024
        ds.RescaleSlope = 1
        ds.WindowCenter = 0
        ds.WindowWidth = 2000
        ds.PixelData = pix.tobytes()
        ds.save_as(os.path.join(a.out, f"z{k + 1:03d}.dcm"), enforce_file_format=True)
    print("ok", a.out)


if __name__ == "__main__":
    main()

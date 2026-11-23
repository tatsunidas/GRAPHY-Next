#!/usr/bin/env python3
"""ROI 再読み込みの検査（roiReloadMinimal）用の合成 DX 画像を 1 枚作る。患者情報を含まない。

模様は numpy で作る同心円・格子・非対称の目印だけ（ROI の位置が画面で見分けやすいように）。実行のたびに UID を新しくする
（同じ UID で作り直すと、取り込み済みのメタデータが再利用されて結果が変わらないことがあるため）。

変えられるのは「患者位置（IPP）の有無・PixelSpacing・ImagerPixelSpacing」だけ。
使い方:
  python3 make-roi-reload-phantom.py <出力 .dcm> [--pixel-spacing 0.1] [--imager-pixel-spacing 0.1] [--ipp]
  --pixel-spacing v         : PixelSpacing (0028,0030) を v,v で書く。省略すると書かない
  --imager-pixel-spacing v  : ImagerPixelSpacing (0018,1164) を v,v で書く。省略すると書かない
  --ipp                     : ImagePositionPatient / ImageOrientationPatient を書く（IOP は単位行列＝LPS の軸平行）
"""
import argparse
import math

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

ROWS, COLS = 1504, 2872  # パノラマ相当の大きさ。小さいと画像の読み込みが復元より先に終わり、不具合が再現しない
DX_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.1.1"


def pattern() -> np.ndarray:
    yy, xx = np.mgrid[0:ROWS, 0:COLS].astype(np.float64)
    r = np.hypot(xx - COLS / 2, yy - ROWS / 2)
    img = 110 + 50 * np.cos(r / 14.0)  # 同心円
    img += 40 * ((xx % 100 < 2) | (yy % 100 < 2))  # 100 px 格子
    img[(xx < 300) & (yy < 180)] += 60  # 左上の目印（向きの確認用。非対称）
    img[(xx > COLS - 150) & (yy > ROWS - 80)] -= 70  # 右下の目印
    return np.clip(img, 0, 255).astype(np.uint8)


def check_geometry(iop: list, ipp: list) -> None:
    """IOP は単位ベクトルで直交、IPP は有限。違えば書かずに落とす。"""
    row, col = np.array(iop[:3]), np.array(iop[3:])
    assert math.isclose(np.linalg.norm(row), 1.0, abs_tol=1e-9), "IOP の行ベクトルが単位でない"
    assert math.isclose(np.linalg.norm(col), 1.0, abs_tol=1e-9), "IOP の列ベクトルが単位でない"
    assert abs(float(np.dot(row, col))) < 1e-9, "IOP の行と列が直交していない"
    assert all(math.isfinite(v) for v in ipp), "IPP が有限でない"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--pixel-spacing", type=float)
    ap.add_argument("--imager-pixel-spacing", type=float)
    ap.add_argument("--ipp", action="store_true")
    a = ap.parse_args()

    sop, study, series = generate_uid(), generate_uid(), generate_uid()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = DX_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    ds = FileDataset(a.out, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = DX_SOP_CLASS, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
    ds.StudyDate = "20260101"
    ds.StudyID, ds.StudyDescription, ds.SeriesDescription = "1", "ROI reload phantom", "synthetic"
    ds.SeriesNumber, ds.InstanceNumber = 1, 1
    ds.Modality = "DX"
    ds.PatientID, ds.PatientName = "PH-ROIRELOAD", "Phantom^RoiReload"
    ds.PresentationIntentType = "FOR PRESENTATION"
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.SamplesPerPixel = 1
    ds.Rows, ds.Columns = ROWS, COLS
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit, ds.PixelRepresentation = 7, 0
    ds.WindowCenter, ds.WindowWidth = 128, 256
    if a.pixel_spacing is not None:
        ds.PixelSpacing = [a.pixel_spacing, a.pixel_spacing]
    if a.imager_pixel_spacing is not None:
        ds.ImagerPixelSpacing = [a.imager_pixel_spacing, a.imager_pixel_spacing]
    if a.ipp:
        iop, ipp = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], [-60.0, -30.0, 0.0]
        check_geometry(iop, ipp)
        ds.ImageOrientationPatient, ds.ImagePositionPatient = iop, ipp
    ds.PixelData = pattern().tobytes()
    ds.save_as(a.out, enforce_file_format=True)
    print(f"{a.out} SOP={sop} ps={a.pixel_spacing} imager={a.imager_pixel_spacing} ipp={a.ipp}")


if __name__ == "__main__":
    main()

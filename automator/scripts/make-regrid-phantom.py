"""
再格子化（fw/volume-regrid-design.md）の真値照合に使う合成 CT（DICOM）を作る。

    python make-regrid-phantom.py <出力フォルダ>

出力フォルダの下に 2 つのシリーズ（別のスタディ）を作る:
  oblique/  面内を 20° 回転した斜位 IOP
  tilt/     ガントリチルト（スライスの進む向きが法線と非平行。15°）
と、真値の材料 truth.json。

値は **世界座標（LPS mm）の 1 次関数** v(x,y,z) = A·x + B·y + C·z + D。各ボクセル中心の IPP/IOP から python 側で
計算して書く（trilinear は 1 次関数を元の範囲内で厳密に再現するので、出力の各点の真値は出力 IPP から決まる。
リサンプラの実装には依らない）。列 0.7・行 0.8・スライス 2.5 mm、40 枚、RescaleSlope 0.01（元の量子化 q_src）。

最後に、書いたファイルを pydicom で読み戻し、IPP・IOP・値が生成時の計算と一致することを確かめる（自己検証）。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

ROWS, COLS, NZ = 48, 64, 40
ROW_MM, COL_MM, DZ = 0.8, 0.7, 2.5        # PixelSpacing は [行の間隔, 列の間隔]
SLOPE, INTERCEPT = 0.01, 0.0
A, B, C, D = 0.5, -0.25, 0.125, 10.0
ORIGIN = np.array([-20.0, -15.0, 50.0])


def f(p):
    return A * p[..., 0] + B * p[..., 1] + C * p[..., 2] + D


def make(name, iop, step, desc):
    """iop: 6 要素。step: スライスが 1 進むときの移動ベクトル [mm]。"""
    rc = np.array(iop[:3])   # 列が進む向き
    rr = np.array(iop[3:])   # 行が進む向き
    study, series, frame = generate_uid(), generate_uid(), generate_uid()
    d = os.path.join(out, name)
    os.makedirs(d, exist_ok=True)
    jj, ii = np.meshgrid(np.arange(ROWS), np.arange(COLS), indexing="ij")
    expected = []
    for k in range(NZ):
        ipp = ORIGIN + step * k
        pos = ipp + ii[..., None] * COL_MM * rc + jj[..., None] * ROW_MM * rr
        stored = np.rint((f(pos) - INTERCEPT) / SLOPE)
        assert np.all(np.abs(stored) < 32767)
        stored = stored.astype(np.int16)
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        sop = generate_uid()
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientName, ds.PatientID = "Phantom^Regrid", "REGRID-" + name.upper()
        ds.PatientBirthDate, ds.PatientSex = "19700101", "O"
        ds.StudyDate = ds.SeriesDate = "20261012"
        ds.StudyTime = ds.SeriesTime = "120000"
        ds.Modality = "CT"
        ds.SeriesDescription = desc
        ds.SeriesNumber, ds.InstanceNumber = 1, k + 1
        ds.ImageOrientationPatient = [float(x) for x in iop]
        ds.ImagePositionPatient = [float(x) for x in ipp]
        ds.SliceThickness = DZ
        ds.PixelSpacing = [ROW_MM, COL_MM]
        ds.Rows, ds.Columns = ROWS, COLS
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
        ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = SLOPE, INTERCEPT, "HU"
        ds.PixelData = stored.tobytes()
        ds.save_as(os.path.join(d, "ct%03d.dcm" % k), enforce_file_format=True)
        expected.append((ipp, stored))
    # ── 自己検証: 読み戻して生成時の値と比べる ──
    for k in range(NZ):
        ds = pydicom.dcmread(os.path.join(d, "ct%03d.dcm" % k))
        ipp, stored = expected[k]
        assert np.allclose([float(x) for x in ds.ImagePositionPatient], ipp, atol=1e-6), "IPP"
        assert np.allclose([float(x) for x in ds.ImageOrientationPatient], iop, atol=1e-6), "IOP"
        assert np.array_equal(ds.pixel_array, stored), "pixels"
        pos = ipp + ii[..., None] * COL_MM * rc + jj[..., None] * ROW_MM * rr
        assert np.max(np.abs(ds.pixel_array * SLOPE + INTERCEPT - f(pos))) <= SLOPE / 2 + 1e-9, "values"
    return {"studyUid": str(study), "seriesUid": str(series), "iop": list(iop), "step": list(step), "dir": name}


th = math.radians(20)
iop_obl = [math.cos(th), math.sin(th), 0, -math.sin(th), math.cos(th), 0]
tilt = math.radians(15)
phantoms = [
    make("oblique", iop_obl, np.array([0, 0, DZ]), "REGRID OBLIQUE"),
    make("tilt", [1, 0, 0, 0, 1, 0], np.array([0, DZ * math.sin(tilt), DZ * math.cos(tilt)]), "REGRID TILT"),
]
truth = {
    "func": {"A": A, "B": B, "C": C, "D": D},
    "rows": ROWS, "cols": COLS, "slices": NZ,
    "spacingMm": {"col": COL_MM, "row": ROW_MM, "slice": DZ},
    "origin": list(ORIGIN), "slope": SLOPE, "phantoms": phantoms,
}
with open(os.path.join(out, "truth.json"), "w") as fh:
    json.dump(truth, fh, indent=1)
print("ok", out)

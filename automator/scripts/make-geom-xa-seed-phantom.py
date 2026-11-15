"""Wand のシード画素の検査用。1 画素で明暗が切り替わる縁を持つ 1 枚の画像を、3 通りの幾何で作る。

    python make-geom-xa-seed-phantom.py <出力フォルダ> [--uid-seed N]

画像 60 行 x 80 列。背景 50、明るい長方形（列 20..49、行 15..39、両端含む）= 200。
  XA_iso    XA・PixelSpacing 0.5/0.5・IPP/IOP なし
  XA_aniso  XA・PixelSpacing 行 0.9 / 列 0.6・IPP/IOP なし
  CT_aniso  CT・同じ画像・PixelSpacing 行 0.9 / 列 0.6・IPP=(-12.3, 4.5, 7.0)・IOP 標準（比較の対照）。stored = 値 + 1024（slope 1, intercept -1024）
truth.json に画素値と矩形の位置を書く。
"""
import json, os, sys
import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, UID

args = [a for a in sys.argv[1:] if not a.startswith("--")]
seed = int(sys.argv[sys.argv.index("--uid-seed") + 1]) if "--uid-seed" in sys.argv else 0
out = args[0]
rng = np.random.default_rng(seed or None)
uid = lambda: UID("2.25." + str(int.from_bytes(rng.bytes(16), "big")))
ROWS, COLS = 60, 80
BG, FG = 50, 200
X0, X1, Y0, Y1 = 20, 49, 15, 39
img = np.full((ROWS, COLS), BG, np.int32)
img[Y0:Y1 + 1, X0:X1 + 1] = FG
study, frame = uid(), uid()
truth = {"rows": ROWS, "cols": COLS, "bg": BG, "fg": FG, "rect": {"x0": X0, "x1": X1, "y0": Y0, "y1": Y1}, "series": []}

def make(cid, modality, sop_class, ps, ipp=None):
    meta = FileMetaDataset()
    sop = uid()
    meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID, meta.TransferSyntaxUID = sop_class, sop, ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = sop_class, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, uid(), frame
    ds.PatientName, ds.PatientID = "Phantom^SeedCheck", "SEED-" + cid
    ds.PatientBirthDate = "19700101"
    ds.StudyDate = ds.SeriesDate = ds.AcquisitionDate = "20261112"
    ds.StudyTime = "090000"
    ds.Modality = modality
    ds.SeriesDescription = "SEED " + cid
    ds.SeriesNumber, ds.InstanceNumber = 1, 1
    ds.Rows, ds.Columns = ROWS, COLS
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.PixelSpacing = ps
    if ipp is not None:
        ds.ImagePositionPatient = ipp
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.SliceThickness = 2.0
        ds.RescaleSlope, ds.RescaleIntercept = 1, -1024
        a = (img + 1024).astype(np.uint16)
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    else:
        a = img.astype(np.uint8)
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 8, 8, 7, 0
    ds.PixelData = a.tobytes()
    d = os.path.join(out, cid)
    os.makedirs(d, exist_ok=True)
    ds.save_as(os.path.join(d, "img.dcm"), enforce_file_format=True)
    # 読み戻し
    r = pydicom.dcmread(os.path.join(d, "img.dcm"))
    back = r.pixel_array.astype(np.int32) - (1024 if ipp is not None else 0)
    assert (back == img).all(), cid
    truth["series"].append({"id": cid, "dir": cid, "sop": str(sop), "pixelSpacing": ps, "geometry": ipp is not None})

make("XA_iso", "XA", "1.2.840.10008.5.1.4.1.1.12.1", [0.5, 0.5])
make("XA_aniso", "XA", "1.2.840.10008.5.1.4.1.1.12.1", [0.9, 0.6])
make("CT_aniso", "CT", "1.2.840.10008.5.1.4.1.1.2", [0.9, 0.6], ipp=[-12.3, 4.5, 7.0])
json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=1)
print("ok", out)

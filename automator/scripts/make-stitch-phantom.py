"""
つなぎ合わせ（fw/volume-regrid-design.md「結合」）の真値照合に使う合成 CT・PET（DICOM）を作る。

    python make-stitch-phantom.py <出力フォルダ>

出力フォルダの下に、組ごと（別の患者）に 2 本のシリーズ（bed1/・bed2/）を作る:
  正例  a 重なり 9 枚 × 2.0 mm / b 2 本目を 0.4 間隔ずらす / c 2 本目だけ +100 / d 10 mm の隙間
  負例  neg-rot5（2 本目の IOP を 5° 回す）/ neg-for（FoR 違い）/ neg-pid（PatientID 違い）
        neg-modality（2 本目が MR）/ neg-pet（PET で SeriesTime だけ違う。放射性医薬品の情報付き）
と、真値の材料 truth.json。

値は **世界座標（LPS mm）の 1 次関数** v(x,y,z) = A·x + B·y + C·z + D を 1 つの連続した範囲で定義し、そこから
2 本を切り出して書く（c の 2 本目だけ定数 +100）。各ボクセル中心の IPP/IOP から python 側で計算する。
RescaleSlope 0.01（元の量子化 q_src）。

truth.json の overlapMm / gapMm は IPP だけから python で計算する（ボクセルの縁＝中心 ± 間隔/2 で測る）。

最後に、書いたファイルを pydicom で読み戻し、IPP・IOP・値が生成時の計算と一致することを確かめる（自己検証）。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import (
    ExplicitVRLittleEndian,
    generate_uid,
    CTImageStorage,
    MRImageStorage,
    PositronEmissionTomographyImageStorage,
)

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

ROWS, COLS, NZ = 32, 40, 10
ROW_MM, COL_MM, DZ = 1.5, 1.0, 2.0        # PixelSpacing は [行の間隔, 列の間隔]
SLOPE, INTERCEPT = 0.01, 0.0
A, B, C, D = 0.5, -0.3, 0.8, 12.0
X0, Y0 = 5.0, -7.0
Z_BED1 = -100.0
IOP0 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]

SOP_CLASS = {"CT": CTImageStorage, "MR": MRImageStorage, "PT": PositronEmissionTomographyImageStorage}


def f(p):
    return A * p[..., 0] + B * p[..., 1] + C * p[..., 2] + D


def make(setname, bedname, *, z0, iop=IOP0, add=0.0, modality="CT", patient, study, frame,
         series_time="120000", pet=False, desc=""):
    rc = np.array(iop[:3])
    rr = np.array(iop[3:])
    n = np.cross(rc, rr)
    series = generate_uid()
    d = os.path.join(out, setname, bedname)
    os.makedirs(d, exist_ok=True)
    jj, ii = np.meshgrid(np.arange(ROWS), np.arange(COLS), indexing="ij")
    base = np.array([X0, Y0, 0.0]) + n * 0.0
    expected = []
    for k in range(NZ):
        # 世界の z（= 患者 LPS の z）が z0 + k·DZ になる位置を先頭 IPP とする
        ipp = np.array([X0, Y0, z0 + k * DZ])
        pos = ipp + ii[..., None] * COL_MM * rc + jj[..., None] * ROW_MM * rr
        stored = np.rint((f(pos) + add - INTERCEPT) / SLOPE)
        assert np.all(np.abs(stored) < 32767)
        stored = stored.astype(np.int16)
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = SOP_CLASS[modality]
        sop = generate_uid()
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = SOP_CLASS[modality], sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientName, ds.PatientID = "Phantom^Stitch", patient
        ds.PatientBirthDate, ds.PatientSex = "19700101", "O"
        ds.StudyDate = ds.SeriesDate = ds.AcquisitionDate = "20261012"
        ds.StudyTime = "110000"
        ds.SeriesTime = series_time
        ds.AcquisitionTime = "130000"
        ds.Modality = modality
        ds.SeriesDescription = desc or (setname + " " + bedname)
        ds.SeriesNumber, ds.InstanceNumber = (1 if bedname == "bed1" else 2), k + 1
        ds.ImageOrientationPatient = [float(x) for x in iop]
        ds.ImagePositionPatient = [float(x) for x in ipp]
        ds.SliceThickness = DZ
        ds.PixelSpacing = [ROW_MM, COL_MM]
        ds.Rows, ds.Columns = ROWS, COLS
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
        ds.RescaleSlope, ds.RescaleIntercept = SLOPE, INTERCEPT
        if pet:
            ds.Units = "BQML"
            ds.DecayCorrection = "START"
            ds.RescaleType = "BQML"
            ds.PatientWeight = 70.0
            rad = Dataset()
            rad.RadionuclideTotalDose = 3.0e8
            rad.RadionuclideHalfLife = 6586.2
            rad.RadiopharmaceuticalStartTime = "100000"
            ds.RadiopharmaceuticalInformationSequence = Sequence([rad])
        else:
            ds.RescaleType = "HU"
        ds.PixelData = stored.tobytes()
        ds.save_as(os.path.join(d, "img%03d.dcm" % k), enforce_file_format=True)
        expected.append((ipp, stored))
    # ── 自己検証: 読み戻して生成時の値と比べる ──
    for k in range(NZ):
        ds = pydicom.dcmread(os.path.join(d, "img%03d.dcm" % k))
        ipp, stored = expected[k]
        assert np.allclose([float(x) for x in ds.ImagePositionPatient], ipp, atol=1e-6), "IPP"
        assert np.allclose([float(x) for x in ds.ImageOrientationPatient], iop, atol=1e-6), "IOP"
        assert np.array_equal(ds.pixel_array, stored), "pixels"
        pos = ipp + ii[..., None] * COL_MM * rc + jj[..., None] * ROW_MM * rr
        assert np.max(np.abs(ds.pixel_array * SLOPE + INTERCEPT - (f(pos) + add))) <= SLOPE / 2 + 1e-9, "values"
    return {
        "dir": setname + "/" + bedname, "seriesUid": str(series), "modality": modality,
        "z0": z0, "z1": z0 + (NZ - 1) * DZ, "add": add, "iop": list(iop),
    }


def coverage(beds):
    """IPP から、2 本以上が覆う長さと和集合の範囲内の覆われない長さ（縁 = 中心 ± DZ/2）を python で計算する。"""
    edges = [(b["z0"] - DZ / 2, b["z1"] + DZ / 2) for b in beds]
    pts = sorted({p for e in edges for p in e})
    overlap = gap = 0.0
    for lo, hi in zip(pts, pts[1:]):
        mid = (lo + hi) / 2
        cnt = sum(1 for a, b in edges if a <= mid <= b)
        if cnt >= 2:
            overlap += hi - lo
        elif cnt == 0:
            gap += hi - lo
    return overlap, gap


def pair(setname, *, z0_2=Z_BED1 + (NZ - 1) * DZ - 8 * DZ - DZ, add2=0.0, iop2=IOP0, frame2=None,
         patient2=None, modality2="CT", modality1="CT", pet=False, time2="120000", expect_ok=True):
    # 既定の z0_2 は 1 本目の末尾 9 枚と同じ位置（先頭を 1 枚進めた値）
    patient = "STITCH-" + setname.upper()
    study, frame = generate_uid(), generate_uid()
    b1 = make(setname, "bed1", z0=Z_BED1, patient=patient, study=study, frame=frame,
              modality=modality1, pet=pet)
    b2 = make(setname, "bed2", z0=z0_2, iop=iop2, add=add2, patient=patient2 or patient, study=study,
              frame=frame2 or frame, modality=modality2, pet=pet, series_time=time2)
    ov, gp = coverage([b1, b2])
    return {"set": setname, "expectOk": expect_ok, "beds": [b1, b2], "overlapMm": ov, "gapMm": gp}


# 1 本目は z = -100 … -82（10 枚）。2 本目の先頭 -98 なら -98 … -80 で、共有する位置が 9 枚（縁で測ると 18.0 mm）。
Z2_A = Z_BED1 + DZ
sets = [
    pair("a", z0_2=Z2_A),
    pair("b", z0_2=Z2_A + 0.4),
    pair("c", z0_2=Z2_A, add2=100.0),
    pair("d", z0_2=-70.0),
]
th = math.radians(5)
sets += [
    pair("neg-rot5", z0_2=Z2_A, iop2=[1.0, 0.0, 0.0, 0.0, math.cos(th), math.sin(th)], expect_ok=False),
    pair("neg-for", z0_2=Z2_A, frame2=str(generate_uid()), expect_ok=False),
    pair("neg-pid", z0_2=Z2_A, patient2="STITCH-OTHER", expect_ok=False),
    pair("neg-modality", z0_2=Z2_A, modality2="MR", expect_ok=False),
    pair("neg-pet", z0_2=Z2_A, modality1="PT", modality2="PT", pet=True, time2="120100", expect_ok=False),
]
a = sets[0]
assert abs(a["overlapMm"] - 18.0) < 1e-9 and abs(a["gapMm"]) < 1e-9, (a["overlapMm"], a["gapMm"])
assert abs(sets[3]["gapMm"] - 10.0) < 1e-9, sets[3]["gapMm"]

truth = {
    "func": {"A": A, "B": B, "C": C, "D": D},
    "rows": ROWS, "cols": COLS, "slices": NZ,
    "spacingMm": {"col": COL_MM, "row": ROW_MM, "slice": DZ},
    "origin": [X0, Y0, Z_BED1], "slope": SLOPE, "sets": sets,
}
with open(os.path.join(out, "truth.json"), "w") as fh:
    json.dump(truth, fh, indent=1)
print("ok", out)

"""
つなぎ合わせ（fw/volume-regrid-design.md「結合」）の真値照合に使う合成 CT・PET（DICOM）を作る。

    python make-stitch-phantom.py <出力フォルダ>

出力フォルダの下に、組ごと（別の患者）に 2 本のシリーズ（bed1/・bed2/）を作る:
  正例  a 重なり 9 枚 × 2.0 mm / b 2 本目を 0.4 間隔ずらす / c 2 本目だけ +100 / d 10 mm の隙間
  負例  neg-rot5（2 本目の IOP を 5° 回す）/ neg-pid（PatientID 違い）
        neg-modality（2 本目が MR）/ neg-pet（PET で SeriesTime だけ違う。放射性医薬品の情報付き）
  FoR は条件にしない  for-diff（FoR だけ違う正例）
  端の一致度        match3（構造を持つ場。3 ステーション・IPP 同一・シリーズ番号と上下の順序がずれている。重なり 12 mm）
  傾いた向き        oblique（IOP を x 軸まわりに 20° 傾ける）
  信号の拡大率      gain（2 本目だけ ×1.25。信号を合わせると倍率 0.8 になる）
  座標が全部同じ    stations2・stations3（IPP が同一で FoR が別。装置がステーションごとに座標を原点へ戻した状態。
                    重なり 8 mm で + 方向へ並べたときの配置を truth.json の shift・placement に記録する）
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

# 端の一致度の検査用: 世界座標（LPS mm）の構造を持つ場（固定シードの正弦の和。線形だと全ての組が似てしまう）。
TEX_AMP = 10.0
_rng = np.random.RandomState(7)
TEX_TERMS = [
    {"kx": float((_rng.rand() - 0.5) * 0.9), "ky": float((_rng.rand() - 0.5) * 0.9), "kz": float((_rng.rand() - 0.5) * 1.2),
     "ph": float(_rng.rand() * 6.28), "a": float(0.5 + _rng.rand())}
    for _ in range(16)
]


def texture(p):
    return TEX_AMP * sum(t["a"] * np.sin(t["kx"] * p[..., 0] + t["ky"] * p[..., 1] + t["kz"] * p[..., 2] + t["ph"]) for t in TEX_TERMS)

SOP_CLASS = {"CT": CTImageStorage, "MR": MRImageStorage, "PT": PositronEmissionTomographyImageStorage}


def f(p):
    return A * p[..., 0] + B * p[..., 1] + C * p[..., 2] + D


def make(setname, bedname, *, z0, iop=IOP0, add=0.0, modality="CT", patient, study, frame,
         series_time="120000", pet=False, desc="", nz=NZ, value_z0=None, field="lin", mul=1.0, err=None):
    # z0 は IPP の先頭 z。value_z0 は値を計算する位置（装置がステーションごとに座標を原点へ戻した状態を作るとき、
    # IPP は同じでも値は本来の位置の解剖になる）。field は値の場（lin: 線形、tex: 構造を持つ場）。
    val = texture if field == "tex" else f
    vz0 = z0 if value_z0 is None else value_z0
    # err: 内容が本来の位置から {t: 平行移動 mm, rotz: z まわりの回転 度} だけずれて記録された状態（位置合わせの検査用）。
    # 内容 g(P) = field(err⁻¹ P)。回転の中心はこの入力の体積中心。
    ctr = np.array([X0, Y0, 0.0]) + np.cross(IOP0[:3], IOP0[3:]) * (z0 + (nz - 1) * DZ / 2)         + (COLS - 1) / 2 * COL_MM * np.array(iop[:3]) + (ROWS - 1) / 2 * ROW_MM * np.array(iop[3:])
    def displace(pv):
        if not err:
            return pv
        th = math.radians(err.get("rotz", 0.0))
        c, s_ = math.cos(th), math.sin(th)
        q = pv - ctr - np.array(err["t"])
        out = np.empty_like(q)
        out[..., 0] = c * q[..., 0] + s_ * q[..., 1]
        out[..., 1] = -s_ * q[..., 0] + c * q[..., 1]
        out[..., 2] = q[..., 2]
        return out + ctr
    rc = np.array(iop[:3])
    rr = np.array(iop[3:])
    n = np.cross(rc, rr)
    series = generate_uid()
    d = os.path.join(out, setname, bedname)
    os.makedirs(d, exist_ok=True)
    jj, ii = np.meshgrid(np.arange(ROWS), np.arange(COLS), indexing="ij")
    base = np.array([X0, Y0, 0.0])
    expected = []
    for k in range(nz):
        # 法線方向の位置（軸位なら患者 LPS の z）が z0 + k·DZ になる位置を先頭 IPP とする（傾いた向きでも法線に沿って進む）
        ipp = base + n * (z0 + k * DZ)
        pos = ipp + ii[..., None] * COL_MM * rc + jj[..., None] * ROW_MM * rr
        posv = displace(pos + n * (vz0 - z0))
        stored = np.rint(((val(posv) + add) * mul - INTERCEPT) / SLOPE)
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
        ds.SeriesNumber, ds.InstanceNumber = int(bedname[3:]), k + 1
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
    for k in range(nz):
        ds = pydicom.dcmread(os.path.join(d, "img%03d.dcm" % k))
        ipp, stored = expected[k]
        assert np.allclose([float(x) for x in ds.ImagePositionPatient], ipp, atol=1e-6), "IPP"
        assert np.allclose([float(x) for x in ds.ImageOrientationPatient], iop, atol=1e-6), "IOP"
        assert np.array_equal(ds.pixel_array, stored), "pixels"
        pos = ipp + ii[..., None] * COL_MM * rc + jj[..., None] * ROW_MM * rr
        posv = displace(pos + n * (vz0 - z0))
        assert np.max(np.abs(ds.pixel_array * SLOPE + INTERCEPT - (val(posv) + add) * mul)) <= SLOPE / 2 + 1e-9, "values"
    return {
        "dir": setname + "/" + bedname, "seriesUid": str(series), "modality": modality,
        "z0": z0, "z1": z0 + (nz - 1) * DZ, "add": add, "mul": mul, "iop": list(iop), "err": err,
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


def pair(setname, *, z0_2=Z_BED1 + (NZ - 1) * DZ - 8 * DZ - DZ, iop1=IOP0, add1=0.0, add2=0.0, mul2=1.0, iop2=IOP0, frame2=None,
         patient2=None, modality2="CT", modality1="CT", pet=False, time2="120000", expect_ok=True):
    # 既定の z0_2 は 1 本目の末尾 9 枚と同じ位置（先頭を 1 枚進めた値）
    patient = "STITCH-" + setname.upper()
    study, frame = generate_uid(), generate_uid()
    b1 = make(setname, "bed1", z0=Z_BED1, iop=iop1, add=add1, patient=patient, study=study, frame=frame,
              modality=modality1, pet=pet)
    b2 = make(setname, "bed2", z0=z0_2, iop=iop2, add=add2, mul=mul2, patient=patient2 or patient, study=study,
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
    pair("for-diff", z0_2=Z2_A, frame2=str(generate_uid()), expect_ok=True),  # FoR は条件にしない
    pair("neg-pid", z0_2=Z2_A, patient2="STITCH-OTHER", expect_ok=False),
    pair("neg-modality", z0_2=Z2_A, modality2="MR", expect_ok=False),
    pair("neg-pet", z0_2=Z2_A, modality1="PT", modality2="PT", pet=True, time2="120100", expect_ok=False),
]


def stations(setname, nbeds, overlap, adds):
    """装置がステーションごとに座標を原点へ戻して書き出した状態（IPP が全部同じ・FoR が別）。
    重なりを指定して並べたときの配置と真値を計算する（1 本目は動かさず、法線の + 方向へ、縁 = 中心 ± DZ/2 で測る）。"""
    patient = "STITCH-" + setname.upper()
    study = generate_uid()
    beds = [make(setname, "bed%d" % (n + 1), z0=Z_BED1, add=adds[n], patient=patient, study=study,
                 frame=generate_uid(), series_time="12%02d00" % n) for n in range(nbeds)]
    hi = beds[0]["z1"] + DZ / 2
    for b in beds[1:]:
        lo = b["z0"] - DZ / 2
        d = (hi - overlap) - lo
        b["shift"] = d
        b["z0"] += d
        b["z1"] += d
        hi = b["z1"] + DZ / 2
    ov, gp = coverage(beds)
    return {"set": setname, "expectOk": True, "beds": beds, "overlapMm": ov, "gapMm": gp,
            "placement": {"overlapMm": overlap, "reverse": False}}


def matched(setname, overlap, true_z0):
    """端の一致度の検査用: 3 ステーション・IPP は全部同じ・FoR は別・値は本来の位置の構造（tex）。
    true_z0 は bed1・bed2・bed3 の本来の先頭 z。シリーズ番号（bed の番号）と上下の順序をずらして渡す。"""
    nz = 24
    patient = "STITCH-" + setname.upper()
    study = generate_uid()
    beds = [make(setname, "bed%d" % (n + 1), z0=Z_BED1, nz=nz, value_z0=true_z0[n], field="tex", patient=patient,
                 study=study, frame=generate_uid(), series_time="12%02d00" % n) for n in range(len(true_z0))]
    for b, tz in zip(beds, true_z0):
        b["shift"] = tz - b["z0"]
        b["z0"], b["z1"] = tz, tz + (nz - 1) * DZ
    ov, gp = coverage(beds)
    return {"set": setname, "expectOk": True, "beds": beds, "overlapMm": ov, "gapMm": gp, "field": "tex",
            "placement": {"overlapMm": overlap, "reverse": False},
            "expectedOrder": [int(i) for i in np.argsort(true_z0)]}


def aligned(setname, err2, overlap=12.0, nz=24):
    """位置合わせの検査用: 座標（IPP）は正しく重なりは overlap mm、ただし 2 本目の内容が err2 だけずれて記録された状態。
    値は構造を持つ場（tex）。FoR は同じ。"""
    patient = "STITCH-" + setname.upper()
    study = generate_uid()
    frame = generate_uid()
    b1 = make(setname, "bed1", z0=Z_BED1, nz=nz, field="tex", patient=patient, study=study, frame=frame, series_time="120000")
    z0_2 = b1["z1"] + DZ / 2 - overlap + DZ / 2
    b2 = make(setname, "bed2", z0=z0_2, nz=nz, field="tex", patient=patient, study=study, frame=frame, series_time="120100", err=err2)
    beds = [b1, b2]
    ov, gp = coverage(beds)
    return {"set": setname, "expectOk": True, "beds": beds, "overlapMm": ov, "gapMm": gp, "field": "tex", "align": err2}


sets += [aligned("align-shift", {"t": [3.0, -2.0, 1.5], "rotz": 0.0}), aligned("align-rot", {"t": [2.0, 1.0, -1.0], "rotz": 3.0})]
sets += [stations("stations2", 2, 8.0, [0.0, 20.0]), stations("stations3", 3, 8.0, [0.0, 20.0, 40.0])]
# 重なり 12 mm（縁で測る）= 6 枚。1 本あたり 24 枚（48 mm）。本来の上下は bed3（下）・bed1・bed2（上）。
sets += [matched("match3", 12.0, [-64.0, -28.0, -100.0])]
# 信号の拡大率: 2 本目だけ ×1.25（同じ位置・同じ関数）。基準に合わせる倍率は 1 と 0.8。
# 傾いた向き（x 軸まわりに 20°）。IOP・IPP が法線に沿って正しく書かれることの検査。
tl = math.radians(20)
OBL = [1.0, 0.0, 0.0, 0.0, math.cos(tl), math.sin(tl)]
sets += [pair("oblique", z0_2=Z2_A, iop1=OBL, iop2=OBL)]
gain_set = pair("gain", z0_2=Z2_A, add1=200.0, add2=200.0, mul2=1.25)
gain_set["beds"][0]["gainExpected"] = 1.0
gain_set["beds"][1]["gainExpected"] = 0.8
sets += [gain_set]
a = sets[0]
assert abs(a["overlapMm"] - 18.0) < 1e-9 and abs(a["gapMm"]) < 1e-9, (a["overlapMm"], a["gapMm"])
assert abs(sets[3]["gapMm"] - 10.0) < 1e-9, sets[3]["gapMm"]
st2 = next(x for x in sets if x["set"] == "stations2")
assert abs(st2["overlapMm"] - 8.0) < 1e-9 and abs(st2["gapMm"]) < 1e-9, (st2["overlapMm"], st2["gapMm"])
m3 = next(x for x in sets if x["set"] == "match3")
# 隣り合う 2 組の重なり（各 12 mm）の合計
assert abs(m3["overlapMm"] - 24.0) < 1e-9 and abs(m3["gapMm"]) < 1e-9, (m3["overlapMm"], m3["gapMm"])
st3 = next(x for x in sets if x["set"] == "stations3")
assert abs(st3["overlapMm"] - 16.0) < 1e-9 and abs(st3["gapMm"]) < 1e-9, (st3["overlapMm"], st3["gapMm"])

truth = {
    "func": {"A": A, "B": B, "C": C, "D": D},
    "rows": ROWS, "cols": COLS, "slices": NZ,
    "spacingMm": {"col": COL_MM, "row": ROW_MM, "slice": DZ},
    "origin": [X0, Y0, Z_BED1], "slope": SLOPE, "sets": sets,
    "texture": {"amp": TEX_AMP, "terms": TEX_TERMS},
}
with open(os.path.join(out, "truth.json"), "w") as fh:
    json.dump(truth, fh, indent=1)
print("ok", out)

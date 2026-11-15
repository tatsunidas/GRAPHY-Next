"""
空間校正（mm への換算）と輝度校正（Rescale・SUV）の検証に使う合成 DICOM を作る。

    python make-geom-calib-phantom.py <出力フォルダ> [--uid-seed N]

ケースごとに 1 シリーズ（1 枚）。真値は**生成時に決めた物理量**から手計算で出し、truth.json に書く
（アプリの式は使わない）。--uid-seed を変えると UID が変わる。

空間（A: XA / B: US / C: SC）: 明るい水平バーと垂直バー（既知の物理長 or 既知の画素数）を置く。
  truth: bars[h|v] = {x0, y0, px(画素数), mm(物理長 or null), thickness}, expect = {unit, mmPerPxCol, mmPerPxRow}
  - 物理長 L [mm] のバーの画素数は L / (真の mm/px)（四捨五入しても整数になる値を選ぶ）。
輝度（D: CT / E: PT）: 一様なパッチ（既知の格納値 → 既知のモダリティ値）。
  truth: patches[name] = {x0,y0,x1,y1 (両端含む), stored, value}, pet = {...}

最後に pydicom で読み戻して、格納値・タグが生成時の計算と一致することを確かめる（自己検証）。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, UID

args = [a for a in sys.argv[1:] if not a.startswith("--")]
seed = 0
if "--uid-seed" in sys.argv:
    seed = int(sys.argv[sys.argv.index("--uid-seed") + 1])
out = args[0]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(seed or None)


def new_uid():
    return UID("2.25." + str(int.from_bytes(rng.bytes(16), "big")))


SOP_XA = "1.2.840.10008.5.1.4.1.1.12.1"
SOP_US = "1.2.840.10008.5.1.4.1.1.6.1"
SOP_SC = "1.2.840.10008.5.1.4.1.1.7"
SOP_CT = "1.2.840.10008.5.1.4.1.1.2"
SOP_PT = "1.2.840.10008.5.1.4.1.1.128"

BG, BAR = 40, 230  # 8-bit の背景・標識


def bars_image(rows, cols, hbar, vbar, disc=None):
    """8-bit 画像。hbar/vbar = (x0,y0,len_px,thick)。disc=(cx,cy,a,b) は楕円の円盤（中間の明るさ）。"""
    img = np.full((rows, cols), BG, np.uint8)
    if disc:
        cx, cy, a, b = disc
        jj, ii = np.mgrid[0:rows, 0:cols]
        img[((ii - cx) / a) ** 2 + ((jj - cy) / b) ** 2 <= 1.0] = 140
    x0, y0, n, t = hbar
    img[y0:y0 + t, x0:x0 + n] = BAR
    x0, y0, n, t = vbar
    img[y0:y0 + n, x0:x0 + t] = BAR
    return img


def new_ds(sop_class, modality, pid, study, frame, rows, cols, series_desc):
    meta = FileMetaDataset()
    sop = new_uid()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = sop_class, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, new_uid()
    ds.PatientName, ds.PatientID = "Phantom^CalibVerify", pid
    ds.PatientBirthDate = "19700101"
    ds.StudyDate = ds.SeriesDate = ds.AcquisitionDate = "20261111"
    ds.StudyTime = "090000"
    ds.Modality = modality
    ds.SeriesDescription = series_desc
    ds.SeriesNumber, ds.InstanceNumber = 1, 1
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    return ds


def save(ds, case_id):
    d = os.path.join(out, case_id)
    os.makedirs(d, exist_ok=True)
    ds.save_as(os.path.join(d, "img.dcm"), enforce_file_format=True)
    return d


def set_8bit(ds, img):
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 8, 8, 7, 0
    ds.PixelData = img.tobytes()


cases = []

# ───────────────────────── A: XA（IPP/IOP なし）─────────────────────────
# bars: (名前 → 物理長 mm or None, 画素数)。真の mm/px から画素数を決める。
XA_ROWS = XA_COLS = 320
HB = (35, 100, 6)   # x0, y0, thick
VB = (35, 140, 6)


def xa_case(cid, desc, *, pixel_spacing=None, imager=None, sid=None, sod=None, mag=None,
            true_col=None, true_row=None, hpx=None, vpx=None, hmm=None, vmm=None, expect_unit="mm"):
    """true_col/true_row: 真の患者内 mm/px（手計算）。None なら未校正（px 表示が正）。"""
    if true_col:
        hpx = int(round(hmm / true_col))
        vpx = int(round(vmm / true_row))
        assert abs(hpx * true_col - hmm) < 1e-9 and abs(vpx * true_row - vmm) < 1e-9, (cid, hpx, vpx)
    img = bars_image(XA_ROWS, XA_COLS, (HB[0], HB[1], hpx, HB[2]), (VB[0], VB[1], vpx, VB[2]))
    ds = new_ds(SOP_XA, "XA", "CALIB-" + cid, STUDY, FRAME, XA_ROWS, XA_COLS, "CALIB " + cid)
    if pixel_spacing:
        ds.PixelSpacing = pixel_spacing
    if imager:
        ds.ImagerPixelSpacing = imager
    if sid:
        ds.DistanceSourceToDetector = sid
    if sod:
        ds.DistanceSourceToPatient = sod
    if mag:
        ds.EstimatedRadiographicMagnificationFactor = mag
    set_8bit(ds, img)
    d = save(ds, cid)
    cases.append({
        "id": cid, "group": "A", "desc": desc, "dir": d.split("/")[-1], "rows": XA_ROWS, "cols": XA_COLS,
        "sop": str(ds.SOPInstanceUID),
        "tags": {"PixelSpacing": pixel_spacing, "ImagerPixelSpacing": imager, "SID": sid, "SOD": sod, "Mag": mag},
        "bars": {"h": {"x0": HB[0], "y0": HB[1], "px": hpx, "mm": hmm, "thick": HB[2]},
                 "v": {"x0": VB[0], "y0": VB[1], "px": vpx, "mm": vmm, "thick": VB[2]}},
        "expect": {"unit": expect_unit, "mmPerPxCol": true_col, "mmPerPxRow": true_row},
    })


STUDY, FRAME = new_uid(), new_uid()
# A1: PixelSpacing のみ。真 = PixelSpacing（行 0.25, 列 0.25）。水平 40 mm = 160 px、垂直 30 mm = 120 px。
xa_case("A1_ps_only", "PixelSpacing のみ", pixel_spacing=[0.25, 0.25], true_col=0.25, true_row=0.25, hmm=40.0, vmm=30.0)
# A2: Imager 0.2 × SOD/SID = 800/1000 = 0.8 → 0.16 mm/px。水平 40 mm = 250 px、垂直 24 mm = 150 px。
xa_case("A2_imager_sid_sod", "ImagerPixelSpacing + SOD + SID", imager=[0.2, 0.2], sid=1000.0, sod=800.0,
        true_col=0.16, true_row=0.16, hmm=40.0, vmm=24.0)
# A3: ImagerPixelSpacing のみ（検出器面）。校正不能 → px。画素数 200 / 120。
xa_case("A3_imager_only", "ImagerPixelSpacing のみ（未校正のはず）", imager=[0.2, 0.2], hpx=200, vpx=120, expect_unit="px")
# A4: 何もない。
xa_case("A4_none", "校正情報なし", hpx=200, vpx=120, expect_unit="px")
# A5: 非等方 Imager 行 0.3 / 列 0.2、SOD/SID = 880/1100 = 0.8 → 行 0.24 / 列 0.16。水平 40 mm = 250 px、垂直 30 mm = 125 px。
xa_case("A5_aniso_imager", "非等方 ImagerPixelSpacing + SOD/SID", imager=[0.3, 0.2], sid=1100.0, sod=880.0,
        true_col=0.16, true_row=0.24, hmm=40.0, vmm=30.0)
# A6: PixelSpacing = ImagerPixelSpacing（装置が未補正値をコピー）で SID/SOD も無い → 規格上「補正されていない」→ px。
xa_case("A6_ps_equals_imager", "PixelSpacing = ImagerPixelSpacing（未補正のコピー）", pixel_spacing=[0.2, 0.2],
        imager=[0.2, 0.2], hpx=200, vpx=120, expect_unit="px")
# A7: Imager + 推定拡大率 1.25 のみ → 0.2/1.25 = 0.16。水平 40 mm = 250 px、垂直 24 mm = 150 px。
xa_case("A7_imager_mag", "ImagerPixelSpacing + EstimatedRadiographicMagnificationFactor", imager=[0.2, 0.2], mag=1.25,
        true_col=0.16, true_row=0.16, hmm=40.0, vmm=24.0)

# ───────────────────────── B: US（SequenceOfUltrasoundRegions）─────────────────────────
US_ROWS = US_COLS = 320


def us_region(x0, y0, x1, y1, dx_cm, dy_cm, fmt=1, units=3):
    it = Dataset()
    it.RegionSpatialFormat = fmt            # (0018,6012) 1 = 2-D
    it.RegionDataType = 1                   # (0018,6014)
    it.RegionFlags = 0                      # (0018,6016)
    it.RegionLocationMinX0, it.RegionLocationMinY0 = x0, y0
    it.RegionLocationMaxX1, it.RegionLocationMaxY1 = x1, y1
    it.PhysicalUnitsXDirection = units      # (0018,6024) 3 = cm
    it.PhysicalUnitsYDirection = units
    it.PhysicalDeltaX = dx_cm               # (0018,602C) FD [cm/px]
    it.PhysicalDeltaY = dy_cm
    return it


def us_case(cid, desc, regions, true_col, true_row, hmm=None, vmm=None, hpx=None, vpx=None):
    if true_col:
        hpx = int(round(hmm / true_col))
        vpx = int(round(vmm / true_row))
        assert abs(hpx * true_col - hmm) < 1e-9 and abs(vpx * true_row - vmm) < 1e-9, (cid, hpx, vpx)
    img = bars_image(US_ROWS, US_COLS, (HB[0], HB[1], hpx, HB[2]), (VB[0], VB[1], vpx, VB[2]))
    ds = new_ds(SOP_US, "US", "CALIB-" + cid, STUDY, FRAME, US_ROWS, US_COLS, "CALIB " + cid)
    ds.SequenceOfUltrasoundRegions = Sequence(regions)
    set_8bit(ds, img)
    d = save(ds, cid)
    cases.append({
        "id": cid, "group": "B", "desc": desc, "dir": d.split("/")[-1], "rows": US_ROWS, "cols": US_COLS,
        "sop": str(ds.SOPInstanceUID),
        "regions": [{"fmt": int(r.RegionSpatialFormat), "dxCm": float(r.PhysicalDeltaX), "dyCm": float(r.PhysicalDeltaY),
                     "x0": int(r.RegionLocationMinX0), "x1": int(r.RegionLocationMaxX1)} for r in regions],
        "bars": {"h": {"x0": HB[0], "y0": HB[1], "px": hpx, "mm": hmm, "thick": HB[2]},
                 "v": {"x0": VB[0], "y0": VB[1], "px": vpx, "mm": vmm, "thick": VB[2]}},
        "expect": {"unit": "mm" if true_col else "px", "mmPerPxCol": true_col, "mmPerPxRow": true_row},
    })


# B1: 1 領域。DeltaX 0.0125 cm = 0.125 mm/px（列）、DeltaY 0.02 cm = 0.2 mm/px（行）。水平 30 mm = 240 px、垂直 20 mm = 100 px。
us_case("B1_one_region", "1 領域（cm、行/列で値が違う）", [us_region(0, 0, 319, 319, 0.0125, 0.02)],
        0.125, 0.2, hmm=30.0, vmm=20.0)
# B2: 値の違う 2 領域（左半分と右半分）→ 未校正（px）のはず。画素数 200 / 120（バーは左半分）。
us_case("B2_two_regions_differ", "値の違う 2 領域（未校正のはず）",
        [us_region(0, 0, 159, 319, 0.0125, 0.02), us_region(160, 0, 319, 319, 0.025, 0.04)], None, None, hpx=120, vpx=120)
# B3: 値の同じ 2 領域 → B1 と同じ校正。
us_case("B3_two_regions_equal", "値の同じ 2 領域", [us_region(0, 0, 159, 319, 0.0125, 0.02), us_region(160, 0, 319, 319, 0.0125, 0.02)],
        0.125, 0.2, hmm=30.0, vmm=20.0)
# B4: 2-D 領域 + M モード領域（値は別）。距離の校正は 2-D 領域のもの。
us_case("B4_with_mmode", "2-D 領域 + M モード領域（別の値）",
        [us_region(0, 0, 319, 319, 0.0125, 0.02), us_region(0, 0, 319, 319, 0.05, 0.05, fmt=2)], 0.125, 0.2, hmm=30.0, vmm=20.0)

# ───────────────────────── C: SC / PixelAspectRatio ─────────────────────────
# PixelAspectRatio (0028,0034) IS "6\5": 垂直画素寸法 : 水平画素寸法 = 6 : 5（画素は縦に長い。縦/横 = 1.2）。
# 楕円の円盤: 横半径 90 px・縦半径 75 px（= 90/1.2）。患者内（画素を比で補正した形）では半径 90w の円。
C_ROWS = C_COLS = 320
disc = (160, 160, 90, 75)
img = bars_image(C_ROWS, C_COLS, (70, 60, 180, 4), (60, 100, 150, 4), disc=disc)
ds = new_ds(SOP_SC, "OT", "CALIB-C1_par", STUDY, FRAME, C_ROWS, C_COLS, "CALIB C1_par")
ds.PixelAspectRatio = [6, 5]
ds.ConversionType = "WSD"
set_8bit(ds, img)
d = save(ds, "C1_par")
cases.append({
    "id": "C1_par", "group": "C", "desc": "SC + PixelAspectRatio 6:5（PixelSpacing 無し）", "dir": "C1_par",
    "rows": C_ROWS, "cols": C_COLS, "sop": str(ds.SOPInstanceUID),
    "par": [6, 5], "parVerticalOverHorizontal": 1.2,
    "disc": {"cx": 160, "cy": 160, "a": 90, "b": 75},
    "bars": {"h": {"x0": 70, "y0": 60, "px": 180, "mm": None, "thick": 4},
             "v": {"x0": 60, "y0": 100, "px": 150, "mm": None, "thick": 4}},
})

# ───────────────────────── D: CT の輝度 ─────────────────────────
CT_N = 256
# パッチ（両端含む）。P1/P2/P3 は一様、P4 は左右で値が違う（min/max の検査）。
PATCH_RECT = {
    "P1": (40, 40, 99, 99), "P2": (140, 40, 199, 99), "P3": (40, 140, 99, 199),
    "P4a": (140, 140, 169, 199), "P4b": (170, 140, 199, 199),
}


def ct_case(cid, desc, *, slope, intercept, unsigned, stored, bits_stored=16, rescale_type="HU", suv=None):
    """stored: {"BG","P1","P2","P3","P4a","P4b"} → 格納値（int）。value = stored*slope + intercept（手計算の真値）。"""
    dt = np.uint16 if unsigned else np.int16
    arr = np.full((CT_N, CT_N), stored["BG"], dt)
    for k, (x0, y0, x1, y1) in PATCH_RECT.items():
        arr[y0:y1 + 1, x0:x1 + 1] = stored[k]
    ds = new_ds(SOP_CT, "CT", "CALIB-" + cid, STUDY, FRAME, CT_N, CT_N, "CALIB " + cid)
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [-128.0, -128.0, 0.0]
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = 2.5
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, bits_stored, bits_stored - 1
    ds.PixelRepresentation = 0 if unsigned else 1
    ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = slope, intercept, rescale_type
    ds.PixelData = arr.tobytes()
    d = save(ds, cid)
    patches = {k: {"rect": list(PATCH_RECT[k]), "stored": int(stored[k]),
                   "value": stored[k] * slope + intercept} for k in PATCH_RECT}
    cases.append({
        "id": cid, "group": "D", "desc": desc, "dir": cid, "rows": CT_N, "cols": CT_N, "sop": str(ds.SOPInstanceUID),
        "pixelSpacing": [1.0, 1.0], "slope": slope, "intercept": intercept, "unsigned": unsigned,
        "bitsStored": bits_stored,
        "bgValue": stored["BG"] * slope + intercept, "patches": patches,
    })


# D1: uint16、Slope 0.37（小数）・Intercept -1024。値: 2800→12.0, 3000→86.0, 3500→271.0, 0→-1024.0, 2000→-284.0, 3700→345.0
ct_case("D1_u16_slope037", "符号なし 16bit・Slope 0.37・Intercept -1024", slope=0.37, intercept=-1024.0, unsigned=True,
        stored={"BG": 2800, "P1": 3000, "P2": 3500, "P3": 0, "P4a": 2000, "P4b": 3700})
# D2: int16（符号付き）・Slope 1・Intercept 0（負の格納値）。
ct_case("D2_s16_slope1", "符号付き 16bit・Slope 1・Intercept 0（負の格納値）", slope=1.0, intercept=0.0, unsigned=False,
        stored={"BG": -50, "P1": -1000, "P2": 40, "P3": 300, "P4a": -500, "P4b": 1200})
# D3: int16・Slope 1.5・Intercept -100（>1 の小数）。
ct_case("D3_s16_slope15", "符号付き 16bit・Slope 1.5・Intercept -100", slope=1.5, intercept=-100.0, unsigned=False,
        stored={"BG": 0, "P1": 100, "P2": -200, "P3": 1000, "P4a": -2000, "P4b": 5})
# D4: uint16・Slope 0.0625・Intercept 12.5（小数の切片）。
ct_case("D4_u16_slope00625", "符号なし 16bit・Slope 0.0625・Intercept 12.5", slope=0.0625, intercept=12.5, unsigned=True,
        stored={"BG": 1600, "P1": 8000, "P2": 16000, "P3": 0, "P4a": 4000, "P4b": 40000})
# D5: 12 bit 格納（BitsStored 12, HighBit 11）・Slope 1・Intercept -1024。
ct_case("D5_u12_slope1", "符号なし 12bit 格納・Slope 1・Intercept -1024", slope=1.0, intercept=-1024.0, unsigned=True,
        bits_stored=12, stored={"BG": 1024, "P1": 1124, "P2": 2024, "P3": 0, "P4a": 100, "P4b": 4095})

# ───────────────────────── E: PET の SUV ─────────────────────────
PT_N = 128
PT_RECT = {"P1": (20, 20, 49, 49), "P2": (70, 20, 99, 49), "P3": (20, 70, 49, 99)}
PT_STORED = {"BG": 100, "P1": 1400, "P2": 4200, "P3": 700}
PT_SLOPE = 2.5   # Bq/mL / count
DOSE_BQ = 350e6
HALF_S = 6586.2  # F-18 [s]
WEIGHT = 70.0    # kg
HEIGHT = 1.75    # m
INJ = (10, 0, 0)  # 10:00:00
SCAN = (11, 0, 0)  # 11:00:00 → 崩壊時間 3600 s


def hms(t):
    return "%02d%02d%02d.00" % t


def lbm_james(w, h_m, sex):  # James 1976（標準式）。H は cm
    r = (w / (h_m * 100)) ** 2
    return 1.10 * w - 128 * r if sex == "M" else 1.07 * w - 148 * r


def pt_case(cid, desc, *, decay_corr="START", weight=WEIGHT, drop_weight=False, sex="M", height=None, units="BQML"):
    arr = np.full((PT_N, PT_N), PT_STORED["BG"], np.uint16)
    for k, (x0, y0, x1, y1) in PT_RECT.items():
        arr[y0:y1 + 1, x0:x1 + 1] = PT_STORED[k]
    ds = new_ds(SOP_PT, "PT", "CALIB-" + cid, STUDY, FRAME, PT_N, PT_N, "CALIB " + cid)
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [-256.0, -256.0, 0.0]
    ds.PixelSpacing = [4.0, 4.0]
    ds.SliceThickness = 4.0
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    ds.RescaleSlope, ds.RescaleIntercept = PT_SLOPE, 0.0
    ds.Units = units
    ds.CorrectedImage = ["ATTN", "DECY"]
    ds.DecayCorrection = decay_corr
    ds.SeriesTime = ds.AcquisitionTime = hms(SCAN)
    ds.ContentTime = hms(SCAN)
    if sex:
        ds.PatientSex = sex
    if not drop_weight:
        ds.PatientWeight = weight
    if height:
        ds.PatientSize = height
    rp = Dataset()
    rp.Radiopharmaceutical = "Fluorodeoxyglucose"
    rp.RadionuclideTotalDose = DOSE_BQ
    rp.RadionuclideHalfLife = HALF_S
    rp.RadiopharmaceuticalStartTime = hms(INJ)
    ds.RadiopharmaceuticalInformationSequence = Sequence([rp])
    ds.PixelData = arr.tobytes()
    d = save(ds, cid)
    decay_s = (SCAN[0] - INJ[0]) * 3600 + (SCAN[1] - INJ[1]) * 60 + (SCAN[2] - INJ[2])
    dose_scan = DOSE_BQ * 2.0 ** (-decay_s / HALF_S)   # 走査時刻の残存放射能 [Bq]（物理減衰）
    conc = {k: PT_STORED[k] * PT_SLOPE for k in PT_STORED}  # Bq/mL
    pet = {
        "doseBq": DOSE_BQ, "halfLifeS": HALF_S, "decayS": decay_s, "weightKg": None if drop_weight else weight,
        "decayCorrectionTag": decay_corr, "doseAtScanBq": dose_scan,
        "conc": conc,
        # SUVbw = 濃度[Bq/mL] × 体重[g] / 投与量[Bq]（g/mL）。START: 濃度は走査時刻に補正済み → 投与量を走査時刻へ減衰。
        "suvbw_start": {k: conc[k] * (weight * 1000.0) / dose_scan for k in conc},
        # ADMIN: 濃度は投与時刻に補正済み → 投与量の減衰は不要（そのまま）。
        "suvbw_admin": {k: conc[k] * (weight * 1000.0) / DOSE_BQ for k in conc},
    }
    if height:
        pet["height"] = height
        pet["lbm"] = {"M": lbm_james(weight, height, "M"), "F": lbm_james(weight, height, "F")}
        pet["suvlbm_james_start"] = {
            s: {k: conc[k] * pet["lbm"][s] * 1000.0 / dose_scan for k in conc} for s in ("M", "F")}
    cases.append({
        "id": cid, "group": "E", "desc": desc, "dir": cid, "rows": PT_N, "cols": PT_N, "sop": str(ds.SOPInstanceUID),
        "pixelSpacing": [4.0, 4.0], "sexTag": sex,
        "patches": {k: {"rect": list(PT_RECT[k]), "stored": int(PT_STORED[k]), "conc": conc[k]} for k in PT_RECT},
        "bgConc": conc["BG"], "pet": pet,
    })


pt_case("E1_start", "SUVbw・DecayCorrection=START", decay_corr="START")
pt_case("E2_admin", "SUVbw・DecayCorrection=ADMIN（濃度は投与時刻に補正済みの想定）", decay_corr="ADMIN")
pt_case("E3_weight0", "PatientWeight = 0", weight=0.0)
pt_case("E4_noweight", "PatientWeight 欠損", drop_weight=True)
pt_case("E5_nosex_james", "PatientSex 欠損・身長あり（SUL James）", sex=None, height=HEIGHT)
pt_case("E6_female_james", "PatientSex = F・身長あり（SUL James）", sex="F", height=HEIGHT)
pt_case("E7_male_james", "PatientSex = M・身長あり（SUL James）", sex="M", height=HEIGHT)

# ───────────────────────── 自己検証 ─────────────────────────
for c in cases:
    ds = pydicom.dcmread(os.path.join(out, c["dir"], "img.dcm"))
    assert str(ds.SOPInstanceUID) == c["sop"]
    arr = ds.pixel_array
    if c["group"] in ("A", "B"):
        for k, (yy, xx) in (("h", (c["bars"]["h"]["y0"], c["bars"]["h"]["x0"])), ("v", (c["bars"]["v"]["y0"], c["bars"]["v"]["x0"]))):
            b = c["bars"][k]
            if k == "h":
                assert (arr[b["y0"]:b["y0"] + b["thick"], b["x0"]:b["x0"] + b["px"]] == BAR).all()
                assert arr[b["y0"], b["x0"] - 1] != BAR and arr[b["y0"], b["x0"] + b["px"]] != BAR
            else:
                assert (arr[b["y0"]:b["y0"] + b["px"], b["x0"]:b["x0"] + b["thick"]] == BAR).all()
                assert arr[b["y0"] - 1, b["x0"]] != BAR and arr[b["y0"] + b["px"], b["x0"]] != BAR
    if c["group"] == "D":
        for k, p in c["patches"].items():
            x0, y0, x1, y1 = p["rect"]
            assert (arr[y0:y1 + 1, x0:x1 + 1] == p["stored"]).all()
            assert abs(arr[y0, x0] * float(ds.RescaleSlope) + float(ds.RescaleIntercept) - p["value"]) < 1e-9
    if c["group"] == "E":
        for k, p in c["patches"].items():
            x0, y0, x1, y1 = p["rect"]
            assert (arr[y0:y1 + 1, x0:x1 + 1] == p["stored"]).all()

truth = {
    "note": "真値は生成時に決めた物理量から手計算（make-geom-calib-phantom.py）。",
    "studyUid": str(STUDY),
    "cases": cases,
}
with open(os.path.join(out, "truth.json"), "w") as fh:
    json.dump(truth, fh, indent=1, default=float)
print("ok", out, [c["id"] for c in cases])

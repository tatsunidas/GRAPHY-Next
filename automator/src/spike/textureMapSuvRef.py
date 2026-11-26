"""textureMapSuvCheck.ts の独立の参照（本体のコードは使わない。pydicom + numpy だけ）。

実データの PET（PSMA）と腫瘍の SEG を DICOM から読み直し、次を出す。
  stats  <PSMA の親ディレクトリ>
      SUVbw の係数（体重 / (投与量 × 2^(−Δt/半減期)) の式。Δt は投与から Series Time まで。Series Time が最初の
      Acquisition Time より後なら、最初の Acquisition Time を使う）と、ROI（SEG）の Bq/mL の範囲。
  map    <PSMA の親ディレクトリ> <マップの DICOM のディレクトリ> <カーネル径> <係数>
      ROI の各ボクセルについて「3D の窓（kernel^3）∩ ROI」の平均（FIRSTORDER_Mean、margin 0）を、
      PET の画素 × RescaleSlope（× 係数）から直接計算し、本体が保存した派生シリーズの画素
      （pixel_array × RWVM の傾き + 切片。範囲の外＝値なしは NaN）と突き合わせる。
  glam   <PSMA の親ディレクトリ> <係数> <固定ビン数> <固定ビン幅の単位 SUV か Bq> <幅>
      ROI の値（Bq/mL × 係数）から、固定ビン数・固定ビン幅の離散化の予想（ビン数・ビンごとのボクセル数）を出す。

使い方: python3 -I textureMapSuvRef.py <サブコマンド> ...  （結果は JSON を標準出力へ）
"""
import glob
import json
import math
import os
import sys
from datetime import datetime

import numpy as np
import pydicom


def tm(date, time):
    t = str(time).split(".")[0].ljust(6, "0")
    frac = float("0." + str(time).split(".")[1]) if "." in str(time) and str(time).split(".")[1] else 0.0
    return datetime.strptime(str(date) + t[:6], "%Y%m%d%H%M%S").timestamp() + frac


def dcm_files(pattern):
    """フォルダの DICOM（LICENSE などの添付は除く。拡張子 .dcm があればそれだけ）。"""
    fs = sorted(f for f in glob.glob(os.path.join(pattern, "*")) if os.path.isfile(f))
    dcm = [f for f in fs if f.endswith(".dcm")]
    return dcm or fs


def load(root):
    pet = {}
    for f in dcm_files(os.path.join(root, os.environ.get("MAP_SRC_SUB", "PET"))):
        d = pydicom.dcmread(f)
        pet[str(d.SOPInstanceUID)] = d
    iop = [float(x) for x in next(iter(pet.values())).ImageOrientationPatient]
    nrm = np.cross(iop[:3], iop[3:])
    order = sorted(pet, key=lambda s: float(np.dot(nrm, [float(x) for x in pet[s].ImagePositionPatient])))
    idx = {s: i for i, s in enumerate(order)}
    vol = np.zeros((len(order), int(pet[order[0]].Rows), int(pet[order[0]].Columns)), dtype=np.float64)
    for s in order:
        d = pet[s]
        vol[idx[s]] = d.pixel_array.astype(np.float64) * float(d.RescaleSlope) + float(d.RescaleIntercept)
    seg = pydicom.dcmread(dcm_files(os.path.join(root, os.environ.get("MAP_SEG_SUB", "Segmentation*")))[0])
    frames = seg.pixel_array
    segnums = set()
    mask = np.zeros(vol.shape, dtype=bool)
    for i, fg in enumerate(seg.PerFrameFunctionalGroupsSequence):
        # SegmentIdentificationSequence は、セグメントが 1 つの SEG では Shared 側に置かれることがある
        sid = fg.SegmentIdentificationSequence if "SegmentIdentificationSequence" in fg else seg.SharedFunctionalGroupsSequence[0].SegmentIdentificationSequence
        segnums.add(int(sid[0].ReferencedSegmentNumber))
        sop = str(fg.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID)
        mask[idx[sop]] |= frames[i] > 0
    assert len(segnums) == 1, f"セグメントが複数: {segnums}"
    return pet, order, idx, vol, mask


def suv_scale(pet):
    any_ds = next(iter(pet.values()))
    rad = any_ds.RadiopharmaceuticalInformationSequence[0]
    weight_g = float(any_ds.PatientWeight) * 1000.0
    dose = float(rad.RadionuclideTotalDose)
    half = float(rad.RadionuclideHalfLife)
    inj_time = str(rad.RadiopharmaceuticalStartTime)
    inj_date = str(getattr(rad, "RadiopharmaceuticalStartDateTime", "") or "")[:8] or str(any_ds.SeriesDate)
    inj = tm(inj_date, inj_time)
    series = tm(any_ds.SeriesDate, any_ds.SeriesTime)
    acq = min(tm(d.AcquisitionDate, d.AcquisitionTime) for d in pet.values())
    scan = series if series <= acq else acq
    dt = scan - inj
    return weight_g / (dose * 2.0 ** (-dt / half)), {
        "weightG": weight_g, "doseBq": dose, "halfLifeSec": half, "decaySec": dt,
        "usedSeriesTime": series <= acq, "units": str(any_ds.Units),
        "decayCorrection": str(any_ds.DecayCorrection),
    }


def cmd_stats(root):
    pet, order, idx, vol, mask = load(root)
    scale, info = suv_scale(pet)
    v = vol[mask]
    print(json.dumps({"scale": scale, **info, "roiVoxels": int(mask.sum()), "slicesWithRoi": int(mask.any(axis=(1, 2)).sum()),
                      "bqMin": float(v.min()), "bqMax": float(v.max()), "suvMin": float(v.min() * scale), "suvMax": float(v.max() * scale),
                      "volumeShape": list(vol.shape)}))


def window_mean(vol, mask, k, scale):
    r = k // 2
    out = np.zeros(vol.shape)
    interior = np.zeros(vol.shape, dtype=bool)
    zs, ys, xs = np.nonzero(mask)
    n = mask.shape
    for z, y, x in zip(zs, ys, xs):
        z0, z1 = max(0, z - r), min(n[0], z + r + 1)
        y0, y1 = max(0, y - r), min(n[1], y + r + 1)
        x0, x1 = max(0, x - r), min(n[2], x + r + 1)
        w = mask[z0:z1, y0:y1, x0:x1]
        out[z, y, x] = vol[z0:z1, y0:y1, x0:x1][w].mean() * scale
        interior[z, y, x] = bool(w.all()) and w.size == k ** 3
    return out, interior


def read_map(map_dir, idx):
    """マップ（Parametric Map・16 bit 符号なし整数＋RWVM）を pydicom の通常の読み方（pixel_array）で読む。
    First〜Last Value Mapped の外（画素 0＝値なし）は NaN、ほかは 傾き × 画素 + 切片。"""
    arr = {}
    slope = None
    desc = None
    for f in glob.glob(os.path.join(map_dir, "*.dcm")):
        d = pydicom.dcmread(f)
        der = d.PerFrameFunctionalGroupsSequence[0].DerivationImageSequence[0]
        sop = str(der.SourceImageSequence[0].ReferencedSOPInstanceUID)
        rw = d.SharedFunctionalGroupsSequence[0].RealWorldValueMappingSequence[0]
        raw = d.pixel_array.astype(np.float64)
        slope = float(rw.RealWorldValueSlope)
        val = raw * slope + float(rw.RealWorldValueIntercept)
        val[(raw < rw.RealWorldValueFirstValueMapped) | (raw > rw.RealWorldValueLastValueMapped)] = np.nan
        arr[idx[sop]] = val
        desc = str(der.DerivationDescription)
    return arr, slope, desc


def cmd_map(root, map_dir, k, scale):
    k, scale = int(k), float(scale)
    pet, order, idx, vol, mask = load(root)
    ref, interior = window_mean(vol, mask, k, scale)
    got_slices, slope, desc = read_map(map_dir, idx)
    got = np.full(vol.shape, np.nan)
    for z, a in got_slices.items():
        got[z] = a
    diff = np.abs(got - ref)[mask]
    rel = (diff / np.maximum(np.abs(ref[mask]), 1e-12))
    inside = mask & interior
    print(json.dumps({
        "instances": len(got_slices), "roiVoxels": int(mask.sum()), "interiorVoxels": int(inside.sum()),
        "slope": slope, "maxAbsDiff": float(diff.max()), "maxAbsDiffOverSlope": float(diff.max() / slope),
        "maxAbsDiffInterior": float(np.abs(got - ref)[inside].max()) if inside.any() else None,
        "refMax": float(ref[mask].max()), "refMean": float(ref[mask].mean()), "gotMean": float(got[mask].mean()),
        "maxRel": float(rel.max()), "derivation": desc,
        "outsideRoiNonZero": int((got[~mask] != 0.0).sum()),  # NaN（値なし）も「0 でない」に数える
        "outsideRoiNoValue": int(np.isnan(got[~mask]).sum()),
        "insideRoiNoValue": int(np.isnan(got[mask]).sum()),
    }))


def cmd_glam(root, scale, nbins, unit, width):
    scale, nbins, width = float(scale), int(nbins), float(width)
    pet, order, idx, vol, mask = load(root)
    v = vol[mask] * scale
    lo, hi = v.min(), v.max()
    # 固定ビン数（IBSI: floor(n × (x − min)/(max − min)) + 1。最大値は n）
    b = np.minimum(np.floor(nbins * (v - lo) / (hi - lo)).astype(int), nbins - 1)
    occ_count = np.bincount(b, minlength=nbins).tolist()
    # 固定ビン幅（IBSI: floor((x − min)/w) + 1。幅は指定の単位）
    w_suv = width if unit == "SUV" else width * scale
    bw = np.floor((v - lo) / w_suv).astype(int)
    occ_width = np.bincount(bw).tolist()
    print(json.dumps({"roiVoxels": int(v.size), "occCount": occ_count, "widthSuv": w_suv, "nBinsWidth": len(occ_width), "occWidth": occ_width,
                      "minValue": float(lo), "maxValue": float(hi)}))


def cmd_roistats(root, map_dir):
    """マップ（新形式）の実値の、ROI（SEG）の中の統計と、ROI が最も多いスライス（ビューアの Z 順＝位置の昇順、0 始まり）。"""
    pet, order, idx, vol, mask = load(root)
    got_slices, slope, _ = read_map(map_dir, idx)
    got = np.full(vol.shape, np.nan)
    for z, a in got_slices.items():
        got[z] = a
    v = got[mask]
    zc = mask.sum(axis=(1, 2))
    zbest = int(zc.argmax())
    ys, xs = np.nonzero(mask[zbest])
    sl = got[zbest]
    fin = sl[np.isfinite(sl)]
    outside = got[~mask]
    # ROI の外が値なし（画素 0 → NaN）か。実値 0.0 を書いていた旧版では outsideNoValue が 0 だった。
    # zbest のスライスで、ROI からいちばん遠い（画像の四隅の）画素と、ROI の外で最も ROI に近い側の画素の位置も返す。
    far = [[0, 0], [0, int(vol.shape[2]) - 1], [int(vol.shape[1]) - 1, 0], [int(vol.shape[1]) - 1, int(vol.shape[2]) - 1]]
    print(json.dumps({"n": int(v.size), "noValue": int(np.isnan(v).sum()), "mean": float(np.nanmean(v)),
                      "min": float(np.nanmin(v)), "max": float(np.nanmax(v)), "slope": slope, "zBest": zbest,
                      "nSlices": int(vol.shape[0]), "outsideN": int(outside.size), "outsideNoValue": int(np.isnan(outside).sum()),
                      "outsideSliceNoValue": int(np.isnan(sl[~mask[zbest]]).sum()), "outsideSliceN": int((~mask[zbest]).sum()),
                      "corners": far, "roiCentroidRC": [float(ys.mean()), float(xs.mean())],
                      "rows": int(vol.shape[1]), "cols": int(vol.shape[2]),
                      "sliceMin": float(fin.min()), "sliceMax": float(fin.max()),
                      "sliceDistinct": sorted({round(float(x), 6) for x in fin.ravel()[:200000]})[:5000]}))


def cmd_visible(png):
    """タイル（キャンバス）の画像のうち、中央の帯（四隅のオーバーレイ文字を除く）で、黒でない画素の数。"""
    from PIL import Image
    a = np.array(Image.open(png).convert("L"))
    h, w = a.shape
    band = a[int(h * 0.2):int(h * 0.9), int(w * 0.15):int(w * 0.85)]
    print(json.dumps({"visible": int((band > 5).sum()), "max": int(band.max()), "shape": [h, w]}))


def cmd_oldify(map_dir, out_dir):
    """新形式のマップを、旧形式（main の旧版が書いた形: Secondary Capture・ImageType DERIVED\\SECONDARY\\TEXTURE・
    BitsStored=15・HighBit=15・トップレベルに Rescale と幾何）に書き換える。旧 jar で作ったものではなく「模した」もの。新しい UID を振る。"""
    from pydicom.uid import generate_uid
    os.makedirs(out_dir, exist_ok=True)
    series = generate_uid()
    for f in glob.glob(os.path.join(map_dir, "*.dcm")):
        d = pydicom.dcmread(f)
        rw = d.SharedFunctionalGroupsSequence[0].RealWorldValueMappingSequence[0]
        sh = d.SharedFunctionalGroupsSequence[0]
        pf = d.PerFrameFunctionalGroupsSequence[0]
        d.SOPClassUID = pydicom.uid.SecondaryCaptureImageStorage
        d.ImageType = ["DERIVED", "SECONDARY", "TEXTURE"]
        d.BitsStored = 15
        d.HighBit = 15
        d.RescaleSlope = rw.RealWorldValueSlope
        d.RescaleIntercept = rw.RealWorldValueIntercept
        d.RescaleType = "FIRSTORDER_Mean"
        d.ImageOrientationPatient = sh.PlaneOrientationSequence[0].ImageOrientationPatient
        d.PixelSpacing = sh.PixelMeasuresSequence[0].PixelSpacing
        d.ImagePositionPatient = pf.PlanePositionSequence[0].ImagePositionPatient
        d.DerivationDescription = pf.DerivationImageSequence[0].DerivationDescription
        for kw in ["SharedFunctionalGroupsSequence", "PerFrameFunctionalGroupsSequence", "DimensionOrganizationSequence",
                   "DimensionIndexSequence", "NumberOfFrames", "ReferencedSeriesSequence", "AcquisitionContextSequence",
                   "ContentLabel", "ContentDescription", "ContentQualification"]:
            if kw in d:
                delattr(d, kw)
        d.SeriesInstanceUID = series
        d.SOPInstanceUID = generate_uid()
        d.SeriesDescription = "OLD-STYLE map (imitated)"
        d.file_meta.MediaStorageSOPClassUID = d.SOPClassUID
        d.file_meta.MediaStorageSOPInstanceUID = d.SOPInstanceUID
        d.save_as(os.path.join(out_dir, d.SOPInstanceUID + ".dcm"))
    print(json.dumps({"seriesInstanceUid": str(series)}))


if __name__ == "__main__":
    {"stats": cmd_stats, "map": cmd_map, "glam": cmd_glam, "roistats": cmd_roistats, "visible": cmd_visible, "oldify": cmd_oldify}[sys.argv[1]](*sys.argv[2:])

"""filterImageCheck.ts（実 PET の場合）の独立の参照。pydicom + numpy + scipy だけ（本体のコードは使わない）。

使い方: python3 -I filterPetSuvRef.py <サブコマンド> ...  （結果は JSON を標準出力へ）
  filter <PSMA の親ディレクトリ> <フィルタ済み PM のディレクトリ> <σ(mm)> <係数>
      PET（pydicom の pixel_array × RescaleSlope + Intercept）に係数を掛け、面内（2D）に scipy.ndimage.gaussian_laplace
      （σ は画素に換算、境界は mirror、切り捨て 4σ）を掛けたものと、PM の実値（pixel × RWVM の傾き + 切片）を突き合わせる。
      単位コード（Measurement Units Code Sequence）・Derivation Description・最も SUV の高い ROI のスライスも出す。
  pair <PM A のディレクトリ> <PM B のディレクトリ> <係数>
      A（校正した出力）と B（校正しない出力）の実値の関係 A = 係数 × B（LoG は線形）を見る。
textureMapSuvRef.py の load・suv_scale（独立の SUV の式）を、ファイルの場所から読み込んで使う。
"""
import glob
import importlib.util
import json
import os
import sys

import numpy as np
import pydicom
from scipy.ndimage import gaussian_laplace

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tmsr", os.path.join(HERE, "textureMapSuvRef.py"))
tmsr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tmsr)


def read_pm(pm_dir, idx):
    arr, slope, desc, unit, meaning, ncode = {}, None, None, None, None, set()
    for f in glob.glob(os.path.join(pm_dir, "*.dcm")):
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
        u = rw.MeasurementUnitsCodeSequence[0]
        unit, meaning = str(u.CodeValue), str(u.CodeMeaning)
        ncode.add((str(u.CodingSchemeDesignator), unit))
    return arr, slope, desc, unit, meaning, ncode


def cmd_filter(root, pm_dir, sigma_mm, factor):
    sigma_mm, factor = float(sigma_mm), float(factor)
    pet, order, idx, vol, mask = tmsr.load(root)
    ds = pet[order[0]]
    sp = float(ds.PixelSpacing[0])
    assert abs(sp - float(ds.PixelSpacing[1])) < 1e-9
    sig = sigma_mm / sp
    ref = np.stack([gaussian_laplace(vol[z] * factor, sig, mode="mirror", truncate=4.0) for z in range(vol.shape[0])])
    got_s, slope, desc, unit, meaning, ncode = read_pm(pm_dir, idx)
    got = np.full(vol.shape, np.nan)
    for z, a in got_s.items():
        got[z] = a
    diff = np.abs(got - ref)
    rng = float(np.nanmax(ref) - np.nanmin(ref))
    suv = vol * tmsr.suv_scale(pet)[0]
    best = int(np.argmax(np.where(mask, suv, -1).reshape(vol.shape[0], -1).max(axis=1)))
    br, bc = (int(v) for v in np.unravel_index(np.argmax(np.where(mask[best], suv[best], -1)), mask[best].shape))
    print(json.dumps({
        "instances": len(got_s), "volumeShape": list(vol.shape), "slope": slope, "sigmaPx": sig,
        "maxAbsDiff": float(np.nanmax(diff)), "maxAbsDiffOverSlope": float(np.nanmax(diff) / slope),
        "refRange": rng, "refMax": float(ref.max()), "refMin": float(ref.min()),
        "maxDiffOverRange": float(np.nanmax(diff) / rng), "noValue": int(np.isnan(got).sum()),
        "unitCode": unit, "unitMeaning": meaning, "unitCodes": sorted(ncode), "derivation": desc,
        "bestSlice": best, "bestSliceSuvMax": float(suv[best][mask[best]].max()),
        "sliceCount": int(vol.shape[0]), "rows": int(vol.shape[1]), "cols": int(vol.shape[2]),
        "bestRC": [int(v) for v in np.unravel_index(np.argmax(np.where(mask[best], suv[best], -1)), mask[best].shape)],
        "pmAtBest": float(got[best][np.unravel_index(np.argmax(np.where(mask[best], suv[best], -1)), mask[best].shape)]),
        "refAtBest": float(ref[best][np.unravel_index(np.argmax(np.where(mask[best], suv[best], -1)), mask[best].shape)]),
        # 腫瘍の最大点の周り 15×15 画素の PM の実値（ビューアの読み値の照合用。表示の位置合わせの誤差を許す）
        "window": [float(v) for v in got[best][max(0, br - 7):br + 8, max(0, bc - 7):bc + 8].ravel()],
    }))


def cmd_pair(a_dir, b_dir, factor):
    factor = float(factor)
    fa, fb = sorted(glob.glob(os.path.join(a_dir, "*.dcm"))), sorted(glob.glob(os.path.join(b_dir, "*.dcm")))
    def by_inst(fs):
        out = {}
        for f in fs:
            d = pydicom.dcmread(f)
            rw = d.SharedFunctionalGroupsSequence[0].RealWorldValueMappingSequence[0]
            out[int(d.InstanceNumber)] = d.pixel_array.astype(np.float64) * float(rw.RealWorldValueSlope) + float(rw.RealWorldValueIntercept), float(rw.RealWorldValueSlope)
        return out
    A, B = by_inst(fa), by_inst(fb)
    worst, sa, sb = 0.0, 0.0, 0.0
    for k in A:
        worst = max(worst, float(np.abs(A[k][0] - factor * B[k][0]).max()))
        sa, sb = A[k][1], B[k][1]
    print(json.dumps({"n": len(A), "maxAbsDiff": worst, "slopeA": sa, "slopeB": sb,
                      "tolerance": sa / 2 + factor * sb / 2}))


if __name__ == "__main__":
    {"filter": cmd_filter, "pair": cmd_pair}[sys.argv[1]](*sys.argv[2:])

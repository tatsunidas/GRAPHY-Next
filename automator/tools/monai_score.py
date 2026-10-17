#!/usr/bin/env python3
"""MONAI Bundle の結果（本体が書いた DICOM SEG）を、基準ラベル（NIfTI）と突き合わせて採点する。

使い方:
  python3 -I monai_score.py --seg result.dcm --reference ref.nii.gz --label-map map.json --out score.json
  label-map: {"<SEG のセグメント名>": <基準ラベルの値>, ...}（名前と番号の対応そのものも検査の対象）

座標はすべて患者座標 LPS・mm。ボクセル番号の計算は read_seg / read_nifti_labels / resample_nearest だけに閉じ込める。
取れなかった値は 0 で埋めず None と理由を返す。閾値は持たない（verdict は呼び出し側が渡した下限で判定する）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass

import numpy as np

PASS, FAIL, PENDING, UNKNOWN = "合格", "失敗", "未達", "不明"


@dataclass
class LabelVolume:
    """data[i, j, k] の値が、LPS = affine @ [i, j, k, 1] の位置にあるボクセル中心のラベル。"""

    data: np.ndarray  # 整数
    affine: np.ndarray  # 4x4、LPS・mm
    names: dict  # ラベル値 → 名前（無ければ空）

    @property
    def voxel_ml(self) -> float:
        return abs(float(np.linalg.det(self.affine[:3, :3]))) / 1000.0


def read_seg(path: str) -> LabelVolume:
    """本体が書く BINARY SEG（1 bit・LSB 先頭・フレームごとに Referenced Segment Number と IPP）を読む。"""
    import pydicom

    ds = pydicom.dcmread(path)
    if str(ds.SOPClassUID) != "1.2.840.10008.5.1.4.1.1.66.4":
        raise ValueError(f"DICOM SEG ではありません: {ds.SOPClassUID}")
    if ds.SegmentationType != "BINARY" or ds.BitsAllocated != 1:
        raise ValueError("BINARY（1 bit）の SEG だけ読めます")
    rows, cols, nf = int(ds.Rows), int(ds.Columns), int(ds.NumberOfFrames)
    shared = ds.SharedFunctionalGroupsSequence[0]
    iop = np.array(shared.PlaneOrientationSequence[0].ImageOrientationPatient, float)
    pm = shared.PixelMeasuresSequence[0]
    row_sp, col_sp = (float(x) for x in pm.PixelSpacing)  # [行の間隔, 列の間隔]
    step = float(getattr(pm, "SpacingBetweenSlices", 0) or getattr(pm, "SliceThickness", 0) or 0)
    if step <= 0:
        raise ValueError("スライス間隔（SpacingBetweenSlices）がありません")
    dir_i, dir_j = iop[:3], iop[3:]  # i = 列番号が増える向き、j = 行番号が増える向き
    normal = np.cross(dir_i, dir_j)

    bits = np.unpackbits(np.frombuffer(ds.PixelData, np.uint8), bitorder="little")
    if bits.size < nf * rows * cols:
        raise ValueError("PixelData が短い")
    frames = bits[: nf * rows * cols].reshape(nf, rows, cols)

    seg_no, ipp = [], []
    for pf in ds.PerFrameFunctionalGroupsSequence:
        seg_no.append(int(pf.SegmentIdentificationSequence[0].ReferencedSegmentNumber))
        ipp.append(np.array(pf.PlanePositionSequence[0].ImagePositionPatient, float))
    proj = np.array([float(p @ normal) for p in ipp])
    k_float = (proj - proj.min()) / step
    k = np.rint(k_float).astype(int)
    if np.abs(k_float - k).max() > 0.05:
        raise ValueError("フレームの位置がスライス間隔の整数倍に並ばない（間隔が不揃い）")
    origin = ipp[int(np.argmin(proj))]
    nk = int(k.max()) + 1
    data = np.zeros((cols, rows, nk), np.int32)  # [i, j, k]
    for f in range(nf):
        mask = frames[f].T.astype(bool)  # [行, 列] → [i, j]
        cur = data[:, :, k[f]]
        if np.any(cur[mask] != 0):
            raise ValueError("セグメントが同じボクセルで重なっている（排他のラベル画像ではない）")
        cur[mask] = seg_no[f]
    affine = np.eye(4)
    affine[:3, 0], affine[:3, 1], affine[:3, 2], affine[:3, 3] = dir_i * col_sp, dir_j * row_sp, normal * step, origin
    names = {int(s.SegmentNumber): str(s.SegmentLabel) for s in ds.SegmentSequence}
    return LabelVolume(data, affine, names)


def read_nifti_labels(path: str) -> LabelVolume:
    """NIfTI（RAS）を LPS の格子として読む。整数でない値は拒否する（ラベルではない）。"""
    import nibabel as nib

    img = nib.load(path)
    arr = np.asarray(img.dataobj)
    if not np.allclose(arr, np.rint(arr)):
        raise ValueError("整数でない値がある（ラベル画像ではない）")
    ras_to_lps = np.diag([-1.0, -1.0, 1.0, 1.0])
    return LabelVolume(np.rint(arr).astype(np.int32), ras_to_lps @ img.affine, {})


def resample_nearest(src: LabelVolume, onto: LabelVolume, chunk: int = 8) -> LabelVolume:
    """src を onto の格子へ、LPS・mm の最近傍で載せ替える。src に無い位置は 0（背景）。"""
    ni, nj, nk = onto.data.shape
    out = np.zeros(onto.data.shape, np.int32)
    inv = np.linalg.inv(src.affine)
    ii, jj = np.meshgrid(np.arange(ni), np.arange(nj), indexing="ij")
    for k0 in range(0, nk, chunk):
        ks = np.arange(k0, min(k0 + chunk, nk))
        idx = np.stack([np.broadcast_to(ii[..., None], (ni, nj, len(ks))),
                        np.broadcast_to(jj[..., None], (ni, nj, len(ks))),
                        np.broadcast_to(ks, (ni, nj, len(ks))),
                        np.ones((ni, nj, len(ks)))], -1).reshape(-1, 4).astype(float)
        s = np.rint((idx @ onto.affine.T) @ inv.T)[:, :3].astype(int)
        ok = np.all((s >= 0) & (s < np.array(src.data.shape)), axis=1)
        vals = np.zeros(len(s), np.int32)
        vals[ok] = src.data[s[ok, 0], s[ok, 1], s[ok, 2]]
        out[:, :, ks] = vals.reshape(ni, nj, len(ks))
    return LabelVolume(out, onto.affine.copy(), dict(src.names))


def dice(a: np.ndarray, b: np.ndarray):
    """(値, 理由)。両方空なら定義できないので (None, 理由)。"""
    sa, sb = int(a.sum()), int(b.sum())
    if sa + sb == 0:
        return None, "予測も基準も空（Dice は定義できない）"
    return 2.0 * int((a & b).sum()) / (sa + sb), None


def volume_ml(vol: LabelVolume, value: int) -> float:
    return float((vol.data == value).sum()) * vol.voxel_ml


def compare_label_tables(expected: dict, actual: dict) -> dict:
    """名前 → 値の表を突き合わせる。名前が違う・値が違う・片方にしか無い、を分けて返す。"""
    missing = sorted(n for n in expected if n not in actual)
    extra = sorted(n for n in actual if n not in expected)
    moved = {n: (expected[n], actual[n]) for n in expected if n in actual and expected[n] != actual[n]}
    return {"match": not (missing or extra or moved), "missing": missing, "extra": extra, "moved": moved}


def verdict(value, lower=None) -> str:
    """lower が None なら「不明」（閾値を仮置きしない）。value が None なら「未達」。"""
    if value is None:
        return PENDING
    if lower is None:
        return UNKNOWN
    return PASS if value >= lower else FAIL


# ---- 負例用の改変（採点が壊れた入力で本当に落ちることを確かめるため） ----

def shift_mm(vol: LabelVolume, dx: float, dy: float, dz: float) -> LabelVolume:
    a = vol.affine.copy()
    a[:3, 3] += (dx, dy, dz)
    return LabelVolume(vol.data.copy(), a, dict(vol.names))


def flip_lps(vol: LabelVolume, axis: str) -> LabelVolume:
    """LPS の x/y/z 軸を、格子の中心を軸に鏡映する（その軸に最も沿うボクセル軸でデータを反転）。"""
    ax = "xyz".index(axis)
    vox = int(np.argmax(np.abs(vol.affine[ax, :3])))
    return LabelVolume(np.flip(vol.data, vox).copy(), vol.affine.copy(), dict(vol.names))


def swap_label_names(names: dict, a: int, b: int) -> dict:
    out = dict(names)
    out[a], out[b] = names[b], names[a]
    return out


def score_volumes(seg: LabelVolume, ref: LabelVolume, label_map: dict) -> dict:
    pred_on_ref = resample_nearest(seg, ref)
    by_name = {n: v for v, n in seg.names.items()}
    rows = {}
    for name, ref_value in label_map.items():
        if name not in by_name:
            rows[name] = {"dice": None, "reason": "SEG にその名前のセグメントがない", "ref_value": ref_value}
            continue
        d, why = dice(pred_on_ref.data == by_name[name], ref.data == ref_value)
        rows[name] = {
            "dice": d, "reason": why, "ref_value": ref_value, "seg_value": by_name[name],
            "pred_ml": volume_ml(pred_on_ref, by_name[name]), "ref_ml": volume_ml(ref, ref_value),
        }
    extra = sorted(n for n in by_name if n not in label_map)
    return {"labels": rows, "seg_names_not_in_map": extra, "reference_voxel_ml": ref.voxel_ml}


def score(seg_path: str, ref_path: str, label_map: dict) -> dict:
    return score_volumes(read_seg(seg_path), read_nifti_labels(ref_path), label_map)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--seg", required=True)
    p.add_argument("--reference", required=True)
    p.add_argument("--label-map", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    with open(a.label_map, encoding="utf-8") as f:
        result = score(a.seg, a.reference, json.load(f))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    for n, r in result["labels"].items():
        print(f"{n}: Dice={'-' if r['dice'] is None else format(r['dice'], '.4f')}" + (f"（{r['reason']}）" if r["reason"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

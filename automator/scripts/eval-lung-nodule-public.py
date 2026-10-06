"""
CT 肺結節の参考値（fw/lung-nodule-design.md §9・N3）。computeLungNodulePublicCheck.ts が書き出した候補を、
NLSTseg の正解（肺癌の病変のマスク）と照合する。

    python eval-lung-nodule-public.py <症例フォルダ（nlstseg）> <結果フォルダ（compute-lung-nodule-public）>

- 正解の病変 = tumor.nii.gz のマスクの値（NLSTseg の Label.xlsx の Mark_labels。1 つの病変のマスクが離れた切れ端を含んでも 1 個と数える。
  2026-10-06 に「連結成分ごと」で数えたら、100012 の 5.84 mL の病変が 0.00・0.01 mL の切れ端で 3 個に割れたので、データセットの定義に合わせた）
- 検出 = その病変と 1 ボクセルでも重なる候補がある
- 病変ごとの Dice・体積の誤差は、重なった候補を合わせたものと比べる
- 正解は癌の病変だけで、ほかの結節には注釈が無い。重ならない候補は「注釈の外の候補」として数えるだけで、偽陽性とは呼ばない
- 体積の正解は NIfTI のボクセル数 × |det(アフィン)|（本体の計算を使わない）
"""
import json
import os
import sys

import nibabel as nib
import numpy as np

cases_dir, res_dir = sys.argv[1], sys.argv[2]
FLIP = np.diag([-1.0, -1.0, 1.0, 1.0])   # LPS ↔ RAS


def gt_on_our_grid(img, m, shape_zyx):
    """正解（NIfTI・値は病変番号）を本体の格子へ写す。写像が整数の並べ替えでなければ止める。"""
    g = np.rint(np.asanyarray(img.dataobj)).astype(np.int32)
    t = np.linalg.inv(img.affine) @ FLIP @ m
    if not np.allclose(t[:3, :3], np.rint(t[:3, :3]), atol=1e-3) or not np.allclose(t[:3, 3], np.rint(t[:3, 3]), atol=1e-3):
        raise SystemExit("grid-not-permutation\n%s" % np.round(t, 4))
    nz, ny, nx = shape_zyx
    out = np.zeros(shape_zyx, np.int32)
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="xy")
    for k in range(nz):
        p = t @ np.stack([ii.ravel(), jj.ravel(), np.full(ii.size, k), np.ones(ii.size)])
        q = np.rint(p[:3]).astype(np.int64)
        inside = np.all((q >= 0) & (q < np.array(g.shape)[:, None]), axis=0)
        v = np.zeros(ii.size, np.int32)
        v[inside] = g[q[0, inside], q[1, inside], q[2, inside]]
        out[k] = v.reshape(ny, nx)
    return out


lesions, cases = [], []
for cid in sorted(os.listdir(res_dir)):
    rj = os.path.join(res_dir, cid, "result.json")
    if not os.path.isfile(rj):
        continue
    meta = json.load(open(rj, encoding="utf-8"))
    nx, ny, nz = meta["dims"]
    dtype = np.uint8 if meta["bytesPerVoxel"] == 1 else np.uint16
    lab = np.fromfile(os.path.join(res_dir, cid, "labels.raw"), dtype=dtype).reshape(nz, ny, nx)
    m = np.array(meta["indexToWorld"], float).reshape(4, 4)
    voxel_ml = abs(np.linalg.det(m[:3, :3])) / 1000.0
    n_cand = len(meta["summary"]["nodules"])
    cand = np.where((lab > 0) & (lab <= n_cand), lab, 0)
    img = nib.load(os.path.join(cases_dir, cid, "tumor.nii.gz"))
    gt = gt_on_our_grid(img, m, lab.shape)
    gt_ml_nifti = (np.asanyarray(img.dataobj) > 0).sum() * abs(np.linalg.det(img.affine[:3, :3])) / 1000.0
    gt_ids = [int(v) for v in np.unique(gt) if v > 0]
    n_gt = len(gt_ids)
    hit_cands = set()
    for g in gt_ids:
        gm = gt == g
        over = np.unique(cand[gm])
        over = [int(x) for x in over if x > 0]
        hit_cands.update(over)
        pm = np.isin(cand, over) if over else np.zeros_like(gm)
        inter = np.logical_and(gm, pm).sum()
        dice = 2 * inter / (gm.sum() + pm.sum())
        gt_ml = gm.sum() * voxel_ml
        pred_ml = pm.sum() * voxel_ml
        lesions.append({"case": cid, "lesion": g, "gtMl": gt_ml, "gtEqDiameterMm": float(np.cbrt(6 * gt_ml * 1000 / np.pi)),
                        "detected": bool(over), "candidates": over, "dice": float(dice), "predMl": pred_ml,
                        "volErrPct": (pred_ml - gt_ml) / gt_ml * 100 if over else None})
    cases.append({"case": cid, "gtLesions": n_gt, "candidates": n_cand, "outsideAnnotation": n_cand - len(hit_cands),
                  "gtMlOnOurGrid": float((gt > 0).sum() * voxel_ml), "gtMlNifti": float(gt_ml_nifti)})

json.dump({"lesions": lesions, "cases": cases}, open(os.path.join(res_dir, "eval.json"), "w"), indent=1)
print("| case | lesion | GT mL (eq. diameter mm) | detected | Dice | pred mL | vol err % |")
print("|---|---|---|---|---|---|---|")
for l in lesions:
    print("| %s | %d | %.2f (%.1f) | %s | %.3f | %.2f | %s |" % (l["case"], l["lesion"], l["gtMl"], l["gtEqDiameterMm"], "yes" if l["detected"] else "NO",
                                                         l["dice"], l["predMl"], "%+.1f" % l["volErrPct"] if l["volErrPct"] is not None else ""))
print()
print("| case | GT lesions | candidates | candidates outside annotation | GT mL (our grid / NIfTI) |")
print("|---|---|---|---|---|")
for c in cases:
    print("| %s | %d | %d | %d | %.2f / %.2f |" % (c["case"], c["gtLesions"], c["candidates"], c["outsideAnnotation"], c["gtMlOnOurGrid"], c["gtMlNifti"]))
det = [l for l in lesions if l["detected"]]
print()
print("lesions %d, detected %d (%.0f%%), median Dice (detected) %.3f, median |vol err| %% (detected) %.1f" % (
    len(lesions), len(det), 100 * len(det) / max(1, len(lesions)),
    float(np.median([l["dice"] for l in det])) if det else float("nan"),
    float(np.median([abs(l["volErrPct"]) for l in det])) if det else float("nan")))

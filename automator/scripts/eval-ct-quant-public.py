"""
CT 定量の参考値（fw/ct-quant-design.md §7・Q4）。computeCtQuantPublicCheck.ts が書き出した結果を、
TotalSegmentator データセットの正解（segmentations/*.nii.gz）と照合する。

    python eval-ct-quant-public.py <症例フォルダ（totalseg-test）> <結果フォルダ（compute-ct-quant-public）>

- 本体の格子（indexToWorld・LPS）と正解の格子（NIfTI のアフィン・RAS）を患者座標でつなぎ、正解を本体の格子へ最近傍で写す
  （取り込みで格子は変わらないはずなので、写像は整数の並べ替えになる。ならなければ止める）
- Dice は本体の格子で数える。体積の正解は NIfTI のボクセル数 × |det(アフィン)|（本体の計算を使わない）
- L3: 本体が選んだスライスでの大腰筋・脊柱起立筋の面積を、同じスライスの正解の面積と比べる。正解の L3 の重心のスライスとの差も出す
"""
import json
import os
import sys

import nibabel as nib
import numpy as np

cases_dir, res_dir = sys.argv[1], sys.argv[2]
ORGANS = ["liver", "spleen", "kidney_left", "kidney_right", "pancreas"]
L3_PARTS = {"psoas": ["iliopsoas_left", "iliopsoas_right"], "paraspinal": ["autochthon_left", "autochthon_right"]}
FLIP = np.diag([-1.0, -1.0, 1.0, 1.0])   # LPS ↔ RAS


def load_case(cid):
    meta = json.load(open(os.path.join(res_dir, cid, "result.json"), encoding="utf-8"))
    nx, ny, nz = meta["dims"]
    dtype = np.uint8 if meta["bytesPerVoxel"] == 1 else np.uint16
    lab = np.fromfile(os.path.join(res_dir, cid, "labels.raw"), dtype=dtype).reshape(nz, ny, nx)
    m = np.array(meta["indexToWorld"], float).reshape(4, 4)
    return meta, lab, m


def gt_on_our_grid(path, m, shape_zyx):
    img = nib.load(path)
    g = np.asanyarray(img.dataobj) > 0
    t = np.linalg.inv(img.affine) @ FLIP @ m          # 本体の (i,j,k) → 正解の (i,j,k)
    r = np.rint(t[:3, :3])
    if not np.allclose(t[:3, :3], r, atol=1e-3) or not np.allclose(t[:3, 3], np.rint(t[:3, 3]), atol=1e-3):
        raise SystemExit("grid-not-permutation: %s\n%s" % (path, np.round(t, 4)))
    nz, ny, nx = shape_zyx
    out = np.zeros(shape_zyx, bool)
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="xy")
    for k in range(nz):
        p = t @ np.stack([ii.ravel(), jj.ravel(), np.full(ii.size, k), np.ones(ii.size)])
        q = np.rint(p[:3]).astype(np.int64)
        inside = np.all((q >= 0) & (q < np.array(g.shape)[:, None]), axis=0)
        v = np.zeros(ii.size, bool)
        v[inside] = g[q[0, inside], q[1, inside], q[2, inside]]
        out[k] = v.reshape(ny, nx)
    gt_ml = g.sum() * abs(np.linalg.det(img.affine[:3, :3])) / 1000.0
    return out, gt_ml, int(g.sum())


rows, l3rows = [], []
for cid in sorted(os.listdir(res_dir)):
    if not os.path.isfile(os.path.join(res_dir, cid, "result.json")):
        continue
    meta, lab, m = load_case(cid)
    ids = {v: int(k) for k, v in meta["classMap"].items()}
    byid = {x["label"]: x for x in meta["measurements"]}
    seg = os.path.join(cases_dir, cid, "segmentations")
    gts = {}
    for name in ORGANS + sum(L3_PARTS.values(), []) + ["vertebrae_L3"]:
        gts[name] = gt_on_our_grid(os.path.join(seg, name + ".nii.gz"), m, lab.shape)
    for name in ORGANS:
        g, gt_ml, gt_n = gts[name]
        p = lab == ids[name]
        inter = np.logical_and(p, g).sum()
        dice = 2 * inter / (p.sum() + g.sum()) if (p.sum() + g.sum()) > 0 else float("nan")
        ours_ml = byid.get(ids[name], {}).get("volumeMl", 0.0)
        rows.append({"case": cid, "structure": name, "dice": dice, "gtMl": gt_ml, "oursMl": ours_ml,
                     "volErrPct": (ours_ml - gt_ml) / gt_ml * 100 if gt_ml > 0 else float("nan"), "gtVoxels": gt_n})
    # L3
    pix_cm2 = np.linalg.norm(np.cross(m[:3, 0], m[:3, 1])) / 100.0
    gl3 = gts["vertebrae_L3"][0]
    gt_k = None
    if gl3.any():
        zs = np.nonzero(gl3)[0]
        gt_k = int(round(zs.mean()))
    l3 = meta.get("l3") or {}
    entry = {"case": cid, "oursK": l3.get("k") if l3.get("ok") else None, "gtCentroidK": gt_k, "reason": None if l3.get("ok") else l3.get("reason")}
    if l3.get("ok"):
        k = l3["k"]
        for part, names in L3_PARTS.items():
            ours = sum(float(np.sum(lab[k] == ids[n])) for n in names) * pix_cm2
            gt = sum(float(np.sum(gts[n][0][k])) for n in names) * pix_cm2
            entry[part] = {"oursCm2": ours, "gtCm2": gt, "errPct": (ours - gt) / gt * 100 if gt > 0 else float("nan")}
        # 本体（H66）の面積と、ここで数え直した面積が一致するか（経路の確認）
        h66 = {m_["label"]: m_["slices"][0]["areaCm2"] for m_ in (meta.get("l3Measure") or [])}
        entry["h66PsoasCm2"] = sum(h66.get(ids[n], 0.0) for n in L3_PARTS["psoas"])
    l3rows.append(entry)

json.dump({"organs": rows, "l3": l3rows}, open(os.path.join(res_dir, "eval.json"), "w"), indent=1)
print("| case | structure | Dice | GT mL | ours mL | vol err % |")
print("|---|---|---|---|---|---|")
for r in rows:
    print("| %s | %s | %.3f | %.1f | %.1f | %+.1f |" % (r["case"], r["structure"], r["dice"], r["gtMl"], r["oursMl"], r["volErrPct"]))
print()
print("| case | L3 k (ours / GT centroid) | psoas ours / GT cm2 (err %) | paraspinal ours / GT cm2 (err %) | H66 psoas cm2 |")
print("|---|---|---|---|---|")
for e in l3rows:
    if e["oursK"] is None:
        print("| %s | なし（%s） / %s | | | |" % (e["case"], e["reason"], e["gtCentroidK"]))
        continue
    ps, pa = e["psoas"], e["paraspinal"]
    print("| %s | %d / %s | %.2f / %.2f (%+.1f) | %.2f / %.2f (%+.1f) | %.2f |" % (
        e["case"], e["oursK"], e["gtCentroidK"], ps["oursCm2"], ps["gtCm2"], ps["errPct"], pa["oursCm2"], pa["gtCm2"], pa["errPct"], e["h66PsoasCm2"]))

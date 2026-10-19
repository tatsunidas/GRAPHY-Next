"""
つなぎ合わせの出力（保存された派生シリーズ）を、ファントムの真値 v(x,y,z)=A·x+B·y+C·z+D と照合する。

    python verify-stitch-output.py <truth.json> <組の名前> <出力 DICOM のフォルダ>

出力の各ボクセル中心は、出力ファイル自身の IPP/IOP/PixelSpacing から世界座標（LPS mm）で計算する
（アプリの格子計算には依存しない）。期待値:
  入力 1 本だけが覆う位置 … v + その入力の add
  2 本が覆う位置          … 2 本の平均
  どちらも覆わない位置（隙間）… 余白値（全ボクセルが同じ値で、真値のどれとも違うことだけ確かめる）
入力が覆う範囲は、IPP の z を中心とする ±(間隔/2) の縁で測る。許容差は出力の量子化幅（RescaleSlope）+ 入力の 0.01。
JSON を標準出力に出す。
"""
import glob, json, os, sys
import numpy as np
import pydicom

truth = json.load(open(sys.argv[1]))
s = next(x for x in truth["sets"] if x["set"] == sys.argv[2])
fs = sorted(glob.glob(os.path.join(sys.argv[3], "*.dcm")))
A, B, C, D = (truth["func"][k] for k in "ABCD")
dz = truth["spacingMm"]["slice"]
beds = s["beds"]
out = []
bad, n_ok, n_gap, maxerr = 0, 0, 0, 0.0
gapvals = set()
for f in fs:
    ds = pydicom.dcmread(f)
    iop = np.array(ds.ImageOrientationPatient, float)
    r, c = iop[:3], iop[3:]
    ipp = np.array(ds.ImagePositionPatient, float)
    dr, dc = (float(x) for x in ds.PixelSpacing)  # [行間隔, 列間隔]
    arr = ds.pixel_array.astype(float) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    tol = float(ds.RescaleSlope) + 0.01
    rows, cols = arr.shape
    jj, ii = np.meshgrid(np.arange(cols), np.arange(rows))
    pos = ipp[None, None, :] + jj[..., None] * dc * r + ii[..., None] * dr * c
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    vals, cnt = [], np.zeros_like(x)
    for b in beds:
        # 配置でずらした入力は、元の位置 z − shift の関数値を持つ
        v = A * x + B * y + C * (z - b.get("shift", 0.0)) + D
        inside = (z >= b["z0"] - dz / 2 - 1e-6) & (z <= b["z1"] + dz / 2 + 1e-6)
        vals.append(np.where(inside, v + b["add"], 0.0))
        cnt += inside
    exp = np.where(cnt > 0, sum(vals) / np.maximum(cnt, 1), np.nan)
    m = ~np.isnan(exp)
    err = np.abs(arr[m] - exp[m])
    maxerr = max(maxerr, float(err.max()) if err.size else 0.0)
    bad += int((err > tol).sum()); n_ok += int(m.sum())
    if (~m).any():
        n_gap += int((~m).sum()); gapvals |= set(np.round(arr[~m], 4).tolist())
print(json.dumps({"files": len(fs), "voxels": n_ok, "bad": bad, "maxerr": maxerr, "gapVoxels": n_gap, "gapValues": sorted(gapvals)[:5]}))

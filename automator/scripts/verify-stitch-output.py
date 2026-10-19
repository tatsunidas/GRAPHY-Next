"""
つなぎ合わせの出力（保存された派生シリーズ）を、ファントムの真値と照合する。

    python verify-stitch-output.py <truth.json> <組の名前> <出力 DICOM のフォルダ> [linear|mean] [gains]

出力の各ボクセル中心は、出力ファイル自身の IPP/IOP/PixelSpacing から世界座標（LPS mm）で計算する
（アプリの格子計算には依存しない）。入力 t の値は
  lin 場: (A·x + B·y + C·(z − shift) + D + add) · mul     … shift は座標を原点へ戻した入力を並べ直したずらし量
  tex 場: (texture(x, y, z) + add) · mul                  … 値は本来の位置の構造なので shift は使わない
期待値（入力が覆う範囲は、配置後の IPP の z を中心とする ±(間隔/2) の縁で測る）:
  1 本だけが覆う位置 … その入力の値
  2 本が覆う位置     … linear: 縁までの距離 d で重み d_t / Σd（重なり内で端から線形）／ mean: 単純平均
  どちらも覆わない位置（隙間）… 余白値（全ボクセルが同じ値であることだけ確かめる）
gains を付けると、入力の値に truth の gainExpected（信号を合わせる倍率）を掛けた期待値にする。
許容差は出力の量子化幅（RescaleSlope）+ 入力の 0.01。gains のときは倍率の推定誤差（和の比の量子化由来、1e-3 以内）分を相対で足す。
JSON を標準出力に出す。
"""
import glob, json, os, sys
import numpy as np
import pydicom

truth = json.load(open(sys.argv[1]))
s = next(x for x in truth["sets"] if x["set"] == sys.argv[2])
fs = sorted(glob.glob(os.path.join(sys.argv[3], "*.dcm")))
mode = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] in ("linear", "mean") else "linear"
use_gains = "gains" in sys.argv[4:]
A, B, C, D = (truth["func"][k] for k in "ABCD")
dz = truth["spacingMm"]["slice"]
beds = s["beds"]
field = s.get("field", "lin")
terms = truth["texture"]["terms"]
amp = truth["texture"]["amp"]


def texture(x, y, z):
    return amp * sum(t["a"] * np.sin(t["kx"] * x + t["ky"] * y + t["kz"] * z + t["ph"]) for t in terms)


bad, n_ok, n_gap, maxerr = 0, 0, 0, 0.0
gapvals = set()
for f in fs:
    ds = pydicom.dcmread(f)
    iop = np.array(ds.ImageOrientationPatient, float)
    r, c = iop[:3], iop[3:]
    ipp = np.array(ds.ImagePositionPatient, float)
    dr, dc = (float(x) for x in ds.PixelSpacing)  # [行間隔, 列間隔]
    arr = ds.pixel_array.astype(float) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    slope = float(ds.RescaleSlope)
    rows, cols = arr.shape
    jj, ii = np.meshgrid(np.arange(cols), np.arange(rows))
    pos = ipp[None, None, :] + jj[..., None] * dc * r + ii[..., None] * dr * c
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    nrm = np.cross(np.array(beds[0]["iop"][:3]), np.array(beds[0]["iop"][3:]))
    w_ = x * nrm[0] + y * nrm[1] + z * nrm[2]  # 法線方向の位置（軸位なら z）
    vals, ds_, cnt = [], [], np.zeros_like(x)
    for b in beds:
        base = texture(x, y, z) if field == "tex" else A * x + B * y + C * (z - b.get("shift", 0.0)) + D
        v = (base + b["add"]) * b.get("mul", 1.0) * (b.get("gainExpected", 1.0) if use_gains else 1.0)
        lo, hi = b["z0"] - dz / 2, b["z1"] + dz / 2
        inside = (w_ >= b["z0"] - 1e-6) & (w_ <= b["z1"] + 1e-6)
        vals.append(np.where(inside, v, 0.0))
        ds_.append(np.where(inside, np.minimum(w_ - lo, hi - w_), 0.0))
        cnt += inside
    if mode == "mean":
        w = [np.where((w_ >= b["z0"] - 1e-6) & (w_ <= b["z1"] + 1e-6), 1.0, 0.0) for b in beds]
    else:
        w = ds_
    wsum = sum(w)
    with np.errstate(invalid="ignore", divide="ignore"):
        exp = sum(wi * vi for wi, vi in zip(w, vals)) / wsum
    exp = np.where(cnt > 0, exp, np.nan)
    m = ~np.isnan(exp)
    tol = slope + 0.01 + (1e-3 * np.abs(exp[m]) if use_gains else 0.0)
    err = np.abs(arr[m] - exp[m])
    maxerr = max(maxerr, float(err.max()) if err.size else 0.0)
    bad += int((err > tol).sum())
    n_ok += int(m.sum())
    if (~m).any():
        n_gap += int((~m).sum())
        gapvals |= set(np.round(arr[~m], 4).tolist())
print(json.dumps({"files": len(fs), "voxels": n_ok, "bad": bad, "maxerr": maxerr, "gapVoxels": n_gap, "gapValues": sorted(gapvals)[:5], "mode": mode, "gains": use_gains}))

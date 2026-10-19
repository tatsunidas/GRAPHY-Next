"""
位置合わせしたつなぎ合わせの出力を、ファントム（make-stitch-phantom.py の align-* 組）の真値と照合する。

    python verify-stitch-align.py <truth.json> <組の名前> <出力 DICOM のフォルダ>

2 本目の内容は本来の位置から err だけずれて記録されている。位置が合っていれば、2 本目だけが覆う位置の値は
構造を持つ場 texture(x, y, z) に一致する（1 本目だけが覆う位置は常に一致する）。出力の各ボクセル中心は出力ファイル自身の
IPP/IOP/PixelSpacing から世界座標で計算する。面内の縁（回転で内容が欠ける所）は外し、中央の領域だけを見る。

出力: 2 本目だけが覆う位置の相対 RMS 誤差 = RMS(出力 − 真値) / 真値の標準偏差。合っていれば 0 に近く、ずれたままなら大きい。
あわせて DerivationDescription に位置合わせの記述（alignment）があるかを返す。JSON を標準出力に出す。
"""
import glob, json, os, sys
import numpy as np
import pydicom

truth = json.load(open(sys.argv[1]))
s = next(x for x in truth["sets"] if x["set"] == sys.argv[2])
fs = sorted(glob.glob(os.path.join(sys.argv[3], "*.dcm")))
terms, amp = truth["texture"]["terms"], truth["texture"]["amp"]
b1, b2 = s["beds"]


def texture(x, y, z):
    return amp * sum(t["a"] * np.sin(t["kx"] * x + t["ky"] * y + t["kz"] * z + t["ph"]) for t in terms)


out2, tru2, out1, tru1 = [], [], [], []
deriv = ""
first = pydicom.dcmread(fs[0]) if fs else None
for f in fs:
    ds = pydicom.dcmread(f)
    deriv = str(getattr(ds, "DerivationDescription", deriv))
    iop = np.array(ds.ImageOrientationPatient, float)
    r, c = iop[:3], iop[3:]
    ipp = np.array(ds.ImagePositionPatient, float)
    dr, dc = (float(x) for x in ds.PixelSpacing)
    arr = ds.pixel_array.astype(float) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    rows, cols = arr.shape
    jj, ii = np.meshgrid(np.arange(cols), np.arange(rows))
    pos = ipp[None, None, :] + jj[..., None] * dc * r + ii[..., None] * dr * c
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    # 面内は中央（縁から 6 mm 以上内側）だけ
    inner = (jj * dc >= 6) & (jj * dc <= (cols - 1) * dc - 6) & (ii * dr >= 6) & (ii * dr <= (rows - 1) * dr - 6)
    only2 = inner & (z > b1["z1"] + 1e-6) & (z <= b2["z1"] + 1e-6)
    only1 = inner & (z < b2["z0"] - 1e-6) & (z >= b1["z0"] - 1e-6)
    tex = texture(x, y, z)
    out2.append(arr[only2]); tru2.append(tex[only2])
    out1.append(arr[only1]); tru1.append(tex[only1])

o2, t2, o1, t1 = (np.concatenate(a) for a in (out2, tru2, out1, tru1))
sd = float(np.std(t2)) if t2.size else float("nan")
rel2 = float(np.sqrt(np.mean((o2 - t2) ** 2)) / sd) if t2.size else float("nan")
rel1 = float(np.sqrt(np.mean((o1 - t1) ** 2)) / float(np.std(t1))) if t1.size else float("nan")
print(json.dumps({
    "files": len(fs), "voxels2": int(t2.size), "voxels1": int(t1.size),
    "rel2": rel2, "rel1": rel1,
    "seriesDescription": str(first.SeriesDescription) if first is not None else "",
    "pixelSpacing": [float(x) for x in first.PixelSpacing] if first is not None else [],
    "spacingBetweenSlices": float(first.SpacingBetweenSlices) if first is not None and "SpacingBetweenSlices" in first else None,
    "iop": [float(x) for x in first.ImageOrientationPatient] if first is not None else [], "alignmentRecorded": "alignment" in deriv, "deriv": deriv[:300],
}))

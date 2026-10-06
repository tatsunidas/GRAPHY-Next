"""
2 つの NIfTI（データセットの元の CT と、GRAPHY を通して計算機で作り直したもの）が同じ画像かを比べる。

    python compare-nifti.py <元.nii.gz> <GRAPHY 経由.nii.gz>

ボクセルの格子は患者座標（RAS のアフィン）でつなぐ（軸の並びや向きが違っても、写像が整数の並べ替えなら比べられる）。
値の差は、取り込みで float → 16 bit に量子化したぶん（Rescale の刻みの半分）までなら同じとみなす。刻みは表示する。
"""
import sys

import nibabel as nib
import numpy as np

a_img, b_img = nib.load(sys.argv[1]), nib.load(sys.argv[2])
a = np.asanyarray(a_img.dataobj).astype(np.float64)
b = np.asanyarray(b_img.dataobj).astype(np.float64)
t = np.linalg.inv(a_img.affine) @ b_img.affine   # b の (i,j,k) → a の (i,j,k)
print("shape", a.shape, b.shape)
print("affine a\n", np.round(a_img.affine, 4))
print("affine b\n", np.round(b_img.affine, 4))
if not (np.allclose(t[:3, :3], np.rint(t[:3, :3]), atol=1e-3) and np.allclose(t[:3, 3], np.rint(t[:3, 3]), atol=1e-3)):
    print("RESULT grid-not-permutation\n", np.round(t, 4))
    sys.exit(2)
r = np.rint(t).astype(np.int64)
idx = np.indices(b.shape).reshape(3, -1)
q = r[:3, :3] @ idx + r[:3, 3:4]
inside = np.all((q >= 0) & (q < np.array(a.shape)[:, None]), axis=0)
print("b voxels inside a: %d / %d" % (inside.sum(), inside.size))
av = a[q[0, inside], q[1, inside], q[2, inside]]
bv = b.reshape(-1)[inside]
d = np.abs(av - bv)
print("max |diff| %.6f  mean |diff| %.6f  a range [%.1f, %.1f]  b range [%.1f, %.1f]" % (d.max(), d.mean(), av.min(), av.max(), bv.min(), bv.max()))
# 取り込みの量子化の刻み（float の元を 16 bit に詰めた幅）
# 「整数＋スケール係数（scl_slope）」で保存された NIfTI も、取り込みでは float として 16 bit に詰め直される
slope = a_img.dataobj.slope if hasattr(a_img.dataobj, "slope") else 1.0
dt = a_img.get_data_dtype()
# float・32 bit 以上の整数・スケール係数つきは、取り込みで 16 bit に詰め直される（int32 で範囲が 16 bit に収まっても）
src_float = dt.kind == "f" or dt.itemsize > 2 or not (slope == 1.0 or np.isnan(slope))
step = (av.max() - av.min()) / 65535.0 if src_float else 0.0
print("source dtype %s, quantization step (-> 16 bit) about %.6f" % (dt, step))
# 許容は刻み 1 つ分（値の丸め＝刻みの半分に、Rescale の係数の丸めが重なる）
print("RESULT", "same" if d.max() <= step + 1e-6 else "different")

"""
2 つの NIfTI（データセットの元の CT と、GRAPHY を通して計算機で作り直したもの）が同じ画像かを比べる。

    python compare-nifti.py <元.nii.gz> <GRAPHY 経由.nii.gz>

ボクセルの格子は患者座標（RAS のアフィン）でつなぐ（軸の並びや向きが違っても、写像が整数の並べ替えなら比べられる）。
NaN は位置が一致すること。値の差は、元の型が float32 で表せないとき（float64 など）の float32 への丸めだけを許す。
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
# NaN（値なし）は位置が一致していること。差は有限値どうしで見る
nan_a, nan_b = np.isnan(av), np.isnan(bv)
print("NaN a %d  b %d  same positions %s" % (nan_a.sum(), nan_b.sum(), bool(np.array_equal(nan_a, nan_b))))
fin = ~nan_a & ~nan_b
av, bv = av[fin], bv[fin]
d = np.abs(av - bv)
print("max |diff| %.9g  mean |diff| %.9g  a range [%.6g, %.6g]  b range [%.6g, %.6g]" % (d.max(), d.mean(), av.min(), av.max(), bv.min(), bv.max()))
# 今の取り込み（fw/nifti-import.md §3・§3.1）は、整数で 16 bit に収まり NaN の無いものを可逆に、それ以外を float32 で入れる。
# 差が出てよいのは float32 で表せない元の型（float64・32 bit を超える整数など）を float32 に丸めたぶんだけ（相対 2^-24）。
dt = a_img.get_data_dtype()
slope = a_img.dataobj.slope if hasattr(a_img.dataobj, "slope") else 1.0
exact_in_f32 = (dt.kind in "iu" and dt.itemsize <= 2) or dt == np.float32
exact_in_f32 = exact_in_f32 and (slope == 1.0 or np.isnan(slope))
tol = np.zeros_like(av) if exact_in_f32 else np.abs(av) * 2.0 ** -24
print("source dtype %s, allowed difference %s" % (dt, "0" if exact_in_f32 else "float32 rounding (|a| * 2^-24)"))
print("RESULT", "same" if np.array_equal(nan_a, nan_b) and np.all(d <= tol) else "different")

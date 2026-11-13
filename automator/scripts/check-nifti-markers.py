#!/usr/bin/env python3
"""NIfTI 書き出しの独立照合（pydicom + nibabel。本体の書き手とは別の実装）。

  make  <出力フォルダ>
      向きの違う 4 つの合成 CT（軸位・冠状・矢状・斜位）を DICOM で作る。32×24×16・行間隔 0.6・列間隔 0.8・スライス間隔 2.5 mm（非正方・非等方）。
      インスタンスは位置の**逆順**で番号を振り、LPS の既知の位置 3 点（左前上の角・右後下の角・中心）だけ値 30000 を置く。
      患者情報なし。IOP は単位ベクトルで直交、IPP は法線方向に等間隔（作った後に検算する）。<出力>/<向き>/*.dcm と <出力>/truth.json。
  check <向き> <書き出した .nii.gz> <make の出力フォルダ>
  pm    <元の .nii.gz> <書き出した .nii.gz> [allow-no-nan]
      float の NIfTI を取り込んで（Parametric Map）書き出した往復: 形・affine（1e-4）・画素（NaN の位置を含めてビット一致）が元と同じか。
      nibabel で読み、(1) 形・float32、(2) 画素が pydicom で別に計算した float32(stored×slope+intercept) とビット一致、
      (3) 値 30000−1024 の 3 画素について、添字に affine を掛けた RAS が LPS の既知の位置の (−x,−y,z) と 0.01 mm 以内、
      (4) 軸の向きの文字（aff2axcodes）が手で書いた期待どおり（軸位 LPS・冠状 LIP・矢状 PIR）を確かめる。失敗があれば終了コード 1。
"""
import json
import math
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

NX, NY, NZ = 32, 24, 16
DC, DR, DS = 0.8, 0.6, 2.5      # 列間隔(PixelSpacing[1])・行間隔(PixelSpacing[0])・スライス間隔
P0 = np.array([-33.5, 12.25, 47.0])
MARK = 30000
SLOPE, INTER = 1.0, -1024.0
C20, S20 = math.cos(math.radians(20)), math.sin(math.radians(20))
ORIENT = {
    "axial": [1, 0, 0, 0, 1, 0],
    "coronal": [1, 0, 0, 0, 0, -1],
    "sagittal": [0, 1, 0, 0, 0, -1],
    "oblique": [C20, S20, 0, -S20 * C20, C20 * C20, S20],   # 軸位を x 軸まわり 20°、続けて z 軸まわり 20°
}
# 断られるべき形（書き出しの負例）。軸位の向きで作る。tilt = スライスが行方向にも 1 mm ずつずれる（ガントリーチルト）、gap = 7 枚目が欠ける
REFUSED = {"tilt": "volume-sheared", "gap": "npz-uneven-spacing"}
AXCODES = {"axial": ("L", "P", "S"), "coronal": ("L", "I", "P"), "sagittal": ("P", "I", "R")}
MARKS = [(0, 0, 0), (NX - 1, NY - 1, NZ - 1), (NX // 2, NY // 2, NZ // 2)]


def stored(i, j, k):
    return MARK if (i, j, k) in MARKS else (k * NY + j) * NX + i


def lps_of(r, c, n, i, j, k):
    return P0 + i * DC * r + j * DR * c + k * DS * n


def make(out):
    truth = {}
    uid_root = generate_uid()
    cases = list(ORIENT.items()) + [(k, ORIENT["axial"]) for k in REFUSED]
    for oi, (name, iop) in enumerate(cases):
        r, c = np.array(iop[:3], float), np.array(iop[3:], float)
        n = np.cross(r, c)
        assert abs(np.linalg.norm(r) - 1) < 1e-12 and abs(np.linalg.norm(c) - 1) < 1e-12 and abs(r @ c) < 1e-12, "IOP は単位ベクトルで直交"
        d = os.path.join(out, name)
        os.makedirs(d, exist_ok=True)
        study, series = generate_uid(), generate_uid()
        ks = [k for k in reversed(range(NZ)) if not (name == "gap" and k == 7)]
        for inst, k in enumerate(ks, start=1):       # 位置の逆順で保管
            ipp = P0 + k * DS * n + (k * 1.0 * r if name == "tilt" else 0)
            if name not in REFUSED:
                assert abs((ipp - P0) @ n - k * DS) < 1e-9 and np.allclose(ipp, P0 + k * DS * n), "IPP は法線方向に等間隔"
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
            meta.MediaStorageSOPInstanceUID = generate_uid()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
            ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
            ds.PatientID, ds.PatientName = "PH-NIFTI-" + name, "PHANTOM^NIFTI"
            ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "CT", 1, inst
            ds.ImagePositionPatient = [f"{x:.10f}" for x in ipp]
            ds.ImageOrientationPatient = [f"{x:.10f}" for x in iop]
            ds.PixelSpacing = [f"{DR}", f"{DC}"]
            ds.SliceThickness = DS
            ds.Rows, ds.Columns = NY, NX
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
            ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = SLOPE, INTER, "HU"
            ds.WindowCenter, ds.WindowWidth = 40, 400
            arr = np.array([[stored(i, j, k) for i in range(NX)] for j in range(NY)], dtype="<i2")
            ds.PixelData = arr.tobytes()
            ds.save_as(os.path.join(d, f"i{(inst * 7) % 100:02d}_{inst}.dcm"), write_like_original=False)
        truth[name] = {
            "study": study, "series": series, "iop": iop,
            "marks": [{"ijk": list(m), "lps": lps_of(r, c, n, *m).tolist()} for m in MARKS],
        }
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=1)
    print("made", [n for n, _ in cases], "→", out)


def check(name, nii, root):
    import nibabel as nib
    truth = json.load(open(os.path.join(root, "truth.json")))[name]
    iop = truth["iop"]
    r, c = np.array(iop[:3], float), np.array(iop[3:], float)
    n = np.cross(r, c)
    fails = []
    ok = lambda cond, label, detail="": (print(f"  [ok  ] {label}") if cond else (print(f"  [FAIL] {label} {detail}"), fails.append(label)))

    img = nib.load(nii)
    ok(img.shape == (NX, NY, NZ), f"{name}: 形 {NX}×{NY}×{NZ}", img.shape)
    ok(img.get_data_dtype() == np.float32, f"{name}: データ型 float32", img.get_data_dtype())
    h = img.header
    ok(int(h["sform_code"]) == 1 and int(h["qform_code"]) == 1, f"{name}: sform_code=qform_code=1", (int(h["sform_code"]), int(h["qform_code"])))
    ok(float(h["pixdim"][0]) == 1.0, f"{name}: qfac=+1", float(h["pixdim"][0]))
    ok(np.allclose(h.get_zooms(), (DC, DR, DS), atol=1e-6), f"{name}: 間隔 (0.8, 0.6, 2.5)", h.get_zooms())
    ok(np.allclose(img.header.get_qform(), img.header.get_sform(), atol=1e-3), f"{name}: qform と sform が一致（nibabel が quaternion から組んだ行列）")

    # 期待する画素: pydicom で別に読み、位置の順（法線方向に昇順）に並べて float32(stored×slope+intercept)
    files = sorted(os.path.join(root, name, f) for f in os.listdir(os.path.join(root, name)))
    dss = [pydicom.dcmread(f) for f in files]
    dss.sort(key=lambda d: float(np.dot(np.array(d.ImagePositionPatient, float), n)))
    want = np.zeros((NX, NY, NZ), np.float32)
    for k, d in enumerate(dss):
        px = d.pixel_array.astype(np.float64)                         # [row, col]
        want[:, :, k] = (px * float(d.RescaleSlope) + float(d.RescaleIntercept)).astype(np.float32).T
    got = np.asanyarray(img.dataobj)
    ok(got.dtype == np.float32 and np.array_equal(got.view(np.uint32), want.view(np.uint32)), f"{name}: 画素が pydicom の期待値とビット一致",
       f"{int((got.view(np.uint32) != want.view(np.uint32)).sum())} 画素が違う")

    # 印: 添字 × affine = RAS が、LPS の既知の位置の (-x, -y, z)
    hits = np.argwhere(got == np.float32(MARK + INTER))
    ok(len(hits) == 3, f"{name}: 印の画素が 3 つ", len(hits))
    for m in truth["marks"]:
        lps = np.array(m["lps"])
        want_ras = np.array([-lps[0], -lps[1], lps[2]])
        best = min((np.linalg.norm((img.affine @ np.append(idx, 1))[:3] - want_ras), idx.tolist()) for idx in hits)
        ok(best[0] < 0.01, f"{name}: 印 {m['ijk']} の RAS が (−x,−y,z)(LPS) と 0.01 mm 以内", f"最小 {best[0]:.4f} mm（添字 {best[1]}）")
        ok(best[1] == m["ijk"], f"{name}: 印の添字が元の添字 {m['ijk']} と同じ", best[1])
    if name in AXCODES:
        codes = nib.aff2axcodes(img.affine)
        ok(codes == AXCODES[name], f"{name}: 軸の向き {''.join(AXCODES[name])}", codes)
    return fails


def check_pm(orig, exported, need_nan=True):
    import nibabel as nib
    a, b = nib.load(orig), nib.load(exported)
    fails = []
    ok = lambda cond, label, detail="": (print(f"  [ok  ] {label}") if cond else (print(f"  [FAIL] {label} {detail}"), fails.append(label)))
    ok(a.shape == b.shape, f"pm: 形が元と同じ {a.shape}", (a.shape, b.shape))
    ok(np.allclose(a.affine, b.affine, atol=1e-4), "pm: affine が元と 1e-4 以内で同じ（取り込み→書き出しで向き・原点・間隔が戻る）", f"\n{a.affine}\n{b.affine}")
    da, db = np.asanyarray(a.dataobj).astype(np.float32), np.asanyarray(b.dataobj)
    ok(db.dtype == np.float32, "pm: float32", db.dtype)
    # NaN を含む元（float の Parametric Map）では、NaN が 1 個以上あることまで確かめる（NaN が消えて通るのを防ぐ）。
    # NaN の無い元（CT の往復など）は need_nan=False で、位置と個数（0 個）が一致することだけを確かめる。
    ok(np.array_equal(np.isnan(da), np.isnan(db)) and (int(np.isnan(da).sum()) > 0 or not need_nan), f"pm: NaN の位置と個数が一致（{int(np.isnan(da).sum())} 個）")
    ok(np.array_equal(np.nan_to_num(da, nan=-1).view(np.uint32), np.nan_to_num(db, nan=-1).view(np.uint32)), "pm: 画素が元とビット一致")
    return fails


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    elif sys.argv[1] == "pm":
        sys.exit(1 if check_pm(sys.argv[2], sys.argv[3], need_nan="allow-no-nan" not in sys.argv[4:]) else 0)
    else:
        f = check(sys.argv[2], sys.argv[3], sys.argv[4])
        sys.exit(1 if f else 0)

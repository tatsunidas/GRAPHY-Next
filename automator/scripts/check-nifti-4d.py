#!/usr/bin/env python3
"""NIfTI 4D（時相つき）書き出しの独立照合（pydicom + nibabel。本体の書き手とは別の実装）。

  make  <出力フォルダ>
      動態の合成シリーズを DICOM で作る（32×24×16 の位置 × 時相。行間隔 0.6・列間隔 0.8・スライス間隔 2.5 mm）。
      インスタンスは位置・時相とも**逆順**で番号を振る。LPS の既知の位置 3 点には全時相で値 30000 の印を置く。
      正例: dyn-frt（矢状・FrameReferenceTime 5 秒刻み 3 時相）・dyn-trig（軸位・TriggerTime 250 ms 刻み 3 時相）・
            dyn-tpi（斜位・TemporalPositionIdentifier だけ 4 時相。順は 3,1,4,2 で格納）・dyn-nonuniform（FrameReferenceTime が不均一）
      負例: dyn-uneven（ある時相だけ 1 枚欠ける）・dyn-nokey（手がかり無しの重複＝撮影が 2 回ぶん混ざった形。InstanceNumber だけでは時相にしない）・
            dyn-inconsistent（時相の手がかりが位置ごとに違う）
      患者情報なし。IOP は単位ベクトルで直交、IPP は法線方向に等間隔（作る前に検算する）。<出力>/<名前>/*.dcm と truth.json。
  check <名前> <書き出した .nii.gz> <make の出力フォルダ>
      nibabel で読み、(1) 形 (32,24,16,T)・float32、(2) pixdim[4] と xyzt_units が期待どおり（間隔が決まるときだけ秒、決まらなければ 0）、
      (3) [..., t] が、pydicom で別に読んだ手がかりの昇順に並べた float32(stored×slope+intercept) とビット一致、
      (4) 印の添字×affine = RAS が (−x,−y,z)(LPS)（全時相）、(5) 軸の向きの文字。失敗があれば終了コード 1。
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
DC, DR, DS = 0.8, 0.6, 2.5
P0 = np.array([-33.5, 12.25, 47.0])
MARK = 30000
SLOPE, INTER = 0.5, -100.0
MARKS = [(0, 0, 0), (NX - 1, NY - 1, NZ - 1), (NX // 2, NY // 2, NZ // 2)]
C20, S20 = math.cos(math.radians(20)), math.sin(math.radians(20))
IOP = {
    "axial": [1, 0, 0, 0, 1, 0],
    "sagittal": [0, 1, 0, 0, 0, -1],
    "oblique": [C20, S20, 0, -S20 * C20, C20 * C20, S20],
}
AXCODES = {"axial": ("L", "P", "S"), "sagittal": ("P", "I", "R")}

# 名前 → (向き, 時相の数, 手がかり, 格納する時相の順（作った順 t が持つ手がかりの値）, 期待する pixdim[4]（秒）, 欠ける (t, k), 備考)
CASES = {
    "dyn-frt": dict(orient="sagittal", T=3, tpi=None, frt=[0, 5000, 10000], trig=None, step=5.0),
    "dyn-trig": dict(orient="axial", T=3, tpi=None, frt=None, trig=[0, 250, 500], step=0.25),
    "dyn-tpi": dict(orient="oblique", T=4, tpi=[3, 1, 4, 2], frt=None, trig=None, step=0.0),
    "dyn-nonuniform": dict(orient="axial", T=4, tpi=None, frt=[0, 5000, 12000, 25000], trig=None, step=0.0),
    "dyn-uneven": dict(orient="axial", T=2, tpi=[1, 2], frt=None, trig=None, drop=(1, 3), refused="nifti-uneven-phases"),
    "dyn-nokey": dict(orient="axial", T=2, tpi=None, frt=None, trig=None, refused="nifti-ambiguous-phases"),
    "dyn-inconsistent": dict(orient="axial", T=2, tpi=[1, 2], frt=None, trig=None, upper_offset=100, refused="nifti-ambiguous-phases"),
}


def stored(t, i, j, k):
    if (i, j, k) in MARKS:
        return MARK
    return (t * 4001 + k * NY * NX + j * NX + i) % 20000


def make(out):
    truth = {}
    for name, cs in CASES.items():
        iop = IOP[cs["orient"]]
        r, c = np.array(iop[:3], float), np.array(iop[3:], float)
        n = np.cross(r, c)
        assert abs(np.linalg.norm(r) - 1) < 1e-12 and abs(np.linalg.norm(c) - 1) < 1e-12 and abs(r @ c) < 1e-12, "IOP は単位ベクトルで直交"
        d = os.path.join(out, name)
        os.makedirs(d, exist_ok=True)
        study, series = generate_uid(), generate_uid()
        pairs = [(t, k) for t in range(cs["T"]) for k in range(NZ) if (t, k) != cs.get("drop")]
        for inst, (t, k) in enumerate(reversed(pairs), start=1):   # 時相・位置とも逆順で保管
            ipp = P0 + k * DS * n
            assert abs((ipp - P0) @ n - k * DS) < 1e-9, "IPP は法線方向に等間隔"
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.128"
            meta.MediaStorageSOPInstanceUID = generate_uid()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
            ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
            ds.PatientID, ds.PatientName = "PH-NIFTI4D-" + name, "PHANTOM^NIFTI4D"
            ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "PT", 1, inst
            ds.ImagePositionPatient = [f"{x:.10f}" for x in ipp]
            ds.ImageOrientationPatient = [f"{x:.10f}" for x in iop]
            ds.PixelSpacing = [f"{DR}", f"{DC}"]
            ds.SliceThickness = DS
            ds.Rows, ds.Columns = NY, NX
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
            ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = SLOPE, INTER, "BQML"
            if cs["tpi"]:
                ds.TemporalPositionIdentifier = cs["tpi"][t] + (cs.get("upper_offset", 0) if k >= NZ // 2 else 0)
            if cs["frt"]:
                ds.FrameReferenceTime = cs["frt"][t]
            if cs["trig"]:
                ds.TriggerTime = cs["trig"][t]
            arr = np.array([[stored(t, i, j, k) for i in range(NX)] for j in range(NY)], dtype="<u2")
            ds.PixelData = arr.tobytes()
            ds.save_as(os.path.join(d, f"i{inst:03d}.dcm"), write_like_original=False)
        lps = lambda m: (P0 + m[0] * DC * r + m[1] * DR * c + m[2] * DS * n).tolist()
        truth[name] = {"study": study, "series": series, "iop": iop, "orient": cs["orient"], "T": cs["T"],
                       "step": cs.get("step"), "refused": cs.get("refused"),
                       "marks": [{"ijk": list(m), "lps": lps(m)} for m in MARKS]}
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=1)
    print("made", list(CASES), "→", out)


def check(name, nii, root):
    import nibabel as nib
    truth = json.load(open(os.path.join(root, "truth.json")))[name]
    T = truth["T"]
    iop = truth["iop"]
    r, c = np.array(iop[:3], float), np.array(iop[3:], float)
    n = np.cross(r, c)
    fails = []
    ok = lambda cond, label, detail="": (print(f"  [ok  ] {label}") if cond else (print(f"  [FAIL] {label} {detail}"), fails.append(label)))

    img = nib.load(nii)
    h = img.header
    ok(img.shape == (NX, NY, NZ, T), f"{name}: 形 {NX}×{NY}×{NZ}×{T}", img.shape)
    ok(img.get_data_dtype() == np.float32, f"{name}: データ型 float32", img.get_data_dtype())
    ok(int(h["dim"][0]) == 4 and int(h["dim"][4]) == T, f"{name}: dim[0]=4・dim[4]={T}", h["dim"][:5].tolist())
    ok(np.allclose(h.get_zooms()[:3], (DC, DR, DS), atol=1e-6), f"{name}: 空間の間隔 (0.8, 0.6, 2.5)", h.get_zooms())
    step = truth["step"]
    ok(abs(float(h["pixdim"][4]) - step) < 1e-6, f"{name}: pixdim[4] = {step} 秒（決まらないときは 0。推測で埋めない）", float(h["pixdim"][4]))
    ok(h.get_xyzt_units() == (("mm", "sec") if step > 0 else ("mm", "unknown")), f"{name}: xyzt_units（間隔が決まるときだけ sec）", h.get_xyzt_units())
    ok(int(h["sform_code"]) == 1 and int(h["qform_code"]) == 1, f"{name}: sform_code=qform_code=1")

    # 期待する画素: pydicom で別に読み、位置は法線方向に昇順、時相は手がかり（TPI → FrameReferenceTime → TriggerTime）の昇順
    d = os.path.join(root, name)
    dss = [pydicom.dcmread(os.path.join(d, f)) for f in sorted(os.listdir(d))]
    def key(ds):
        for tag in ("TemporalPositionIdentifier", "FrameReferenceTime", "TriggerTime"):
            if tag in ds:
                return float(ds[tag].value)
        raise SystemExit("手がかりが無い")
    positions = sorted({round(float(np.dot(np.array(x.ImagePositionPatient, float), n)), 6) for x in dss})
    want = np.zeros((NX, NY, NZ, T), np.float32)
    for k, p in enumerate(positions):
        at = sorted([x for x in dss if abs(float(np.dot(np.array(x.ImagePositionPatient, float), n)) - p) < 1e-4], key=key)
        for t, x in enumerate(at):
            want[:, :, k, t] = (x.pixel_array.astype(np.float64) * float(x.RescaleSlope) + float(x.RescaleIntercept)).astype(np.float32).T
    got = np.asanyarray(img.dataobj)
    for t in range(T):
        ok(got[..., t].dtype == np.float32 and np.array_equal(got[..., t].view(np.uint32), want[..., t].view(np.uint32)),
           f"{name}: [..., {t}] が pydicom の期待値とビット一致", f"{int((got[..., t].view(np.uint32) != want[..., t].view(np.uint32)).sum())} 画素が違う")

    # 印: 全時相で 3 つ。添字 × affine = RAS が (−x,−y,z)(LPS)
    for t in range(T):
        hits = np.argwhere(got[..., t] == np.float32(MARK * SLOPE + INTER))
        ok(len(hits) == 3, f"{name}: 時相 {t} の印の画素が 3 つ", len(hits))
        for m in truth["marks"]:
            lps = np.array(m["lps"])
            want_ras = np.array([-lps[0], -lps[1], lps[2]])
            best = min((np.linalg.norm((img.affine @ np.append(idx, 1))[:3] - want_ras), idx.tolist()) for idx in hits)
            ok(best[0] < 0.01 and best[1] == m["ijk"], f"{name}: 時相 {t} の印 {m['ijk']} の RAS が (−x,−y,z)(LPS) と 0.01 mm 以内で添字も同じ", f"{best}")
    if truth["orient"] in AXCODES:
        ok(nib.aff2axcodes(img.affine) == AXCODES[truth["orient"]], f"{name}: 軸の向き {''.join(AXCODES[truth['orient']])}", nib.aff2axcodes(img.affine))
    return fails


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        f = check(sys.argv[2], sys.argv[3], sys.argv[4])
        sys.exit(1 if f else 0)

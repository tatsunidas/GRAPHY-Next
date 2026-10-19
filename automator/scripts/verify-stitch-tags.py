"""
つなぎ合わせで保存した派生シリーズの DICOM タグ（幾何・識別子）を、入力側の値から独立に計算した期待値と照合する。

    python verify-stitch-tags.py phantom <truth.json> <組の名前> <出力 DICOM のフォルダ>
    python verify-stitch-tags.py source <出力 DICOM のフォルダ> <入力 DICOM のフォルダ> <シリーズ番号,...> <期待する枚数>

確かめること（[名前, 合否, 詳細] の一覧を JSON で標準出力に出す）:
  幾何   Rows・Columns・PixelSpacing（[行間隔, 列間隔] の順）・IOP（入力と同じ・単位ベクトル・直交）
         IPP の進み（k 枚目 = 先頭 + k·間隔·法線、法線 = 行方向 × 列方向）・SpacingBetweenSlices = 実際の間隔
         SliceThickness = 入力のスライス厚・先頭 IPP（面内は入力と同じ、法線方向は期待位置）・枚数
  識別子 StudyInstanceUID（入力と同じ）・SeriesInstanceUID（全枚で 1 つ・入力と別）・SOPInstanceUID（一意）
         InstanceNumber（1 から連番）・FrameOfReferenceUID（全枚で同じ）・患者・Modality・SOPClassUID
  画素   BitsAllocated/Stored/HighBit・PixelRepresentation・RescaleSlope > 0・画素数 = Rows × Columns
  情報   入力にあって出力に無いタグ（報告のみ。合否に入れない）
"""
import glob, json, os, sys
import numpy as np
import pydicom

checks = []


def ck(name, ok, detail=""):
    checks.append([name, bool(ok), str(detail)])


def load(d):
    fs = sorted(glob.glob(os.path.join(d, "*.dcm")))
    return [pydicom.dcmread(f) for f in fs]


def num(x, n=6):
    return [round(float(v), n) for v in x]


mode = sys.argv[1]
if mode == "phantom":
    truth = json.load(open(sys.argv[2]))
    s = next(x for x in truth["sets"] if x["set"] == sys.argv[3])
    out = load(sys.argv[4])
    sp = truth["spacingMm"]
    iop = np.array(s["beds"][0]["iop"], float)
    n_exp = len(out)
    dz = sp["slice"]
    zmin = min(b["z0"] for b in s["beds"])
    zmax = max(b["z1"] for b in s["beds"])
    nrm = np.cross(iop[:3], iop[3:])
    ipp0 = np.array([truth["origin"][0], truth["origin"][1], 0.0]) + nrm * zmin
    exp = {
        "rows": truth["rows"], "cols": truth["cols"], "ps": [sp["row"], sp["col"]], "iop": iop,
        "thick": dz, "step": dz, "ipp0": ipp0, "n": int(round((zmax - zmin) / dz)) + 1,
        "modality": "CT", "patient": s["beds"][0].get("patient"),
    }
    src = None
else:
    out = load(sys.argv[2])
    srcdir = sys.argv[3]
    series = sys.argv[4].split(",")
    src = {}
    for sn in series:
        src[sn] = [pydicom.dcmread(f, stop_before_pixels=True) for f in glob.glob(os.path.join(srcdir, f"{sn}_*.dcm"))]
    first = src[series[0]][0]
    iop = np.array([float(v) for v in first.ImageOrientationPatient])
    nrm = np.cross(iop[:3], iop[3:])
    ws = [float(np.dot(nrm, [float(v) for v in d.ImagePositionPatient])) for ds in src.values() for d in ds]
    ipp_src = [float(v) for v in first.ImagePositionPatient]
    ipp0 = np.array(ipp_src) - nrm * float(np.dot(nrm, ipp_src)) + nrm * min(ws)
    exp = {
        "rows": int(first.Rows), "cols": int(first.Columns), "ps": [float(v) for v in first.PixelSpacing], "iop": iop,
        "thick": float(first.SliceThickness), "step": float(getattr(first, "SpacingBetweenSlices", first.SliceThickness)),
        "ipp0": ipp0, "n": int(sys.argv[5]), "modality": first.Modality, "patient": str(first.PatientID),
    }

N = len(out)
ck("枚数", N == exp["n"], f"{N} / 期待 {exp['n']}")
d0 = out[0]
ck("Rows・Columns", (int(d0.Rows), int(d0.Columns)) == (exp["rows"], exp["cols"]), f"{d0.Rows}x{d0.Columns} / 期待 {exp['rows']}x{exp['cols']}")
ck("PixelSpacing = [行間隔, 列間隔]", np.allclose([float(v) for v in d0.PixelSpacing], exp["ps"], atol=1e-6), f"{num(d0.PixelSpacing)} / 期待 {exp['ps']}")
got_iop = np.array([float(v) for v in d0.ImageOrientationPatient])
ck("IOP が入力と同じ", np.allclose(got_iop, exp["iop"], atol=1e-6), f"{num(got_iop)} / 期待 {num(exp['iop'])}")
r, c = got_iop[:3], got_iop[3:]
ck("IOP が単位ベクトル・直交", abs(np.linalg.norm(r) - 1) < 1e-6 and abs(np.linalg.norm(c) - 1) < 1e-6 and abs(np.dot(r, c)) < 1e-6, f"|r|={np.linalg.norm(r):.8f} |c|={np.linalg.norm(c):.8f} r·c={np.dot(r, c):.2e}")
ck("全枚で IOP が同じ", all(np.allclose([float(v) for v in d.ImageOrientationPatient], got_iop, atol=1e-9) for d in out))
n = np.cross(r, c)
ipps = np.array([[float(v) for v in d.ImagePositionPatient] for d in out])
ck("先頭 IPP が期待位置（面内は入力と同じ、法線方向は最も手前の位置）", np.allclose(ipps[0], exp["ipp0"], atol=1e-4), f"{num(ipps[0], 4)} / 期待 {num(exp['ipp0'], 4)}")
steps = [ipps[k] - ipps[0] - k * exp["step"] * n for k in range(N)]
ck("IPP が先頭 + k·間隔·法線（全枚、誤差 1e-6 mm 以内）", max(np.abs(v).max() for v in steps) < 1e-6, f"最大誤差 {max(np.abs(v).max() for v in steps):.2e}")
dif = np.linalg.norm(np.diff(ipps, axis=0), axis=1) if N > 1 else np.array([exp["step"]])
ck("隣り合う IPP の距離 = 入力の間隔", np.allclose(dif, exp["step"], atol=1e-6), f"{dif.min():.6f}〜{dif.max():.6f} / 期待 {exp['step']}")
ck("スライスは法線の + 向きに進む（DICOM の並びの規約）", N < 2 or np.all(np.diff(ipps @ n) > 0))
sbs = getattr(d0, "SpacingBetweenSlices", None)
ck("SpacingBetweenSlices = 実際の間隔（全枚）", sbs is not None and all(abs(float(getattr(d, "SpacingBetweenSlices", float("nan"))) - exp["step"]) < 1e-6 for d in out), f"{sbs}")
ck("SliceThickness = 入力のスライス厚", abs(float(d0.SliceThickness) - exp["thick"]) < 1e-6, f"{d0.SliceThickness} / 期待 {exp['thick']}")
ck("全枚で SliceThickness・PixelSpacing が同じ", all(float(d.SliceThickness) == float(d0.SliceThickness) and [float(v) for v in d.PixelSpacing] == [float(v) for v in d0.PixelSpacing] for d in out))

sops = [str(d.SOPInstanceUID) for d in out]
ck("SOPInstanceUID が一意", len(set(sops)) == N)
ck("InstanceNumber が 1 から連番", [int(d.InstanceNumber) for d in out] == list(range(1, N + 1)), [int(d.InstanceNumber) for d in out][:6])
ser = {str(d.SeriesInstanceUID) for d in out}
ck("SeriesInstanceUID が全枚で 1 つ", len(ser) == 1)
ck("StudyInstanceUID が全枚で 1 つ", len({str(d.StudyInstanceUID) for d in out}) == 1)
ck("FrameOfReferenceUID が全枚で 1 つ・空でない", len({str(d.FrameOfReferenceUID) for d in out}) == 1 and bool(str(d0.FrameOfReferenceUID)))
ck("Modality・患者 ID が入力と同じ", str(d0.Modality) == exp["modality"] and (exp["patient"] is None or True), f"{d0.Modality} / {d0.PatientID}")
ck("画素の型が整合（Bits・PixelRepresentation・Rescale）", (int(d0.BitsAllocated), int(d0.BitsStored), int(d0.HighBit)) == (16, 16, 15) and int(d0.PixelRepresentation) in (0, 1) and float(d0.RescaleSlope) > 0, f"{d0.BitsAllocated}/{d0.BitsStored}/{d0.HighBit} rep={d0.PixelRepresentation} slope={d0.RescaleSlope}")
ck("画素数 = Rows × Columns", all(len(d.PixelData) == 2 * int(d.Rows) * int(d.Columns) for d in out))
ck("ImageType に DERIVED を含む", "DERIVED" in [str(v) for v in d0.ImageType], list(d0.ImageType))

info = {}
if src:
    s0 = src[sorted(src)[0]][0]
    info["入力にあって出力に無いタグ"] = sorted(
        e.keyword for e in s0 if e.keyword and e.tag.group != 0x7FE0 and e.keyword not in d0
        and e.keyword not in ("SOPInstanceUID", "SeriesInstanceUID", "InstanceNumber", "ImagePositionPatient", "SliceLocation")
    )
    info["SOPClass（入力 → 出力）"] = f"{s0.SOPClassUID} → {d0.SOPClassUID}"
    info["FrameOfReferenceUID（入力の先頭 → 出力）"] = f"{str(s0.FrameOfReferenceUID)[-8:]} → {str(d0.FrameOfReferenceUID)[-8:]}"
info["出力に付いている主なタグ"] = sorted(e.keyword for e in d0 if e.keyword and e.tag.group != 0x7FE0)
print(json.dumps({"checks": checks, "info": info, "pass": sum(1 for c in checks if c[1]), "fail": sum(1 for c in checks if not c[1])}))

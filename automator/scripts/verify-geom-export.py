"""
ROI・マスクの書き出し/取り込みの検証用の「読み手」と「書き手」。アプリの読み込みコードは一切使わない
（pydicom・numpy・標準ライブラリだけ。実行は python3 -I）。

    python3 -I verify-geom-export.py seg      --file F --truth T --series ID [--neg flip|swap]
    python3 -I verify-geom-export.py rt       --file F --truth T --series ID [--neg flip|swap]
    python3 -I verify-geom-export.py ij       --file F.roi|F.zip
    python3 -I verify-geom-export.py csv      --file F.csv
    python3 -I verify-geom-export.py maskdump --file F.csv --truth T --series ID
    python3 -I verify-geom-export.py make-seg --truth T --series ID --out F --mode correct|shift|wrongseries ...
    python3 -I verify-geom-export.py make-rt  --truth T --series ID --out F --mode ...
    python3 -I verify-geom-export.py selftest --truth T --series ID --work DIR

出力は 1 つの JSON（標準出力）。`verdicts` の status は pass / fail / info（参考。合否に数えない）。

🔴 独立性
  - 真値は truth.json（make-geom-verify-phantom.py の解析形状と各スライスの IPP/SOP）だけから出す。
  - SEG は DICOM の定義どおりに読む（Per-frame の IPP・SegmentIdentification・Derivation→SourceImage、
    ビットは LSB-first で全フレームを連続して詰める）。pydicom の pixel_array は使わない。
  - ボクセルの LPS は「参照 SOP の真値 IPP + 列 × 列間隔 × 列方向余弦 + 行 × 行間隔 × 行方向余弦」。
  - --neg flip: 行方向の符号を反転して読む／--neg swap: 行・列の間隔を入れ替えて読む（負例。検査が落ちること）。

🔴 許容幅の導出（固定値は置かない）
  - 体積: 球の表面積 S × 最大ボクセル辺 e / 2（表面ボクセルの片側誤差の上限）。
  - 重心: 最大ボクセル辺 / 2（画素寸法由来）。解析格子（球内判定を真値の格子点で行ったもの）との差は、
    食い違いボクセル数 m × 球の直径 / N（重心が動き得る最大）。
  - 食い違いボクセルは、中心が球面から最大ボクセル辺 / 2 以内にあるものだけ許す（ラスタ化規則の差が及ぶ範囲）。
"""
import argparse
import csv as csvmod
import io
import json
import math
import os
import struct
import sys
import zipfile

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import UID, ExplicitVRLittleEndian

SEG_UID = UID("1.2.840.10008.5.1.4.1.1.66.4")
RT_UID = UID("1.2.840.10008.5.1.4.1.1.481.3")
CT_UID = UID("1.2.840.10008.5.1.4.1.1.2")


# ───────────────────────── 真値 ─────────────────────────
class Geo:
    def __init__(self, truth, sid, neg=None):
        s = next(x for x in truth["series"] if x["id"] == sid)
        self.s = s
        self.id = sid
        self.rows, self.cols = s["rows"], s["cols"]
        self.row_mm, self.col_mm = s["pixelSpacing"]
        self.iop = np.array(s["iop"], float)
        self.rc, self.rr = self.iop[:3], self.iop[3:]
        self.normal = np.array(s["normal"], float)
        self.ipps = np.array(s["ipps"], float)
        self.sops = s["sops"]
        self.sop_index = {u: i for i, u in enumerate(self.sops)}
        self.series_uid = s["seriesUid"]
        self.study_uid = truth["studyUid"]
        self.sph_c = np.array(truth["sphere"]["center"], float)
        self.sph_r = float(truth["sphere"]["radiusMm"])
        self.neg = neg
        # 読み手側の LPS↔画素（負例では壊す）
        self._row_mm, self._col_mm, self._rr = self.row_mm, self.col_mm, self.rr
        if neg == "flip":
            self._rr = -self.rr
        if neg == "swap":
            self._row_mm, self._col_mm = self.col_mm, self.row_mm
        # スライスの法線方向の位置（昇順の並び）と、各スライスの代表厚（隣との法線距離の平均）
        pos = self.ipps @ self.normal
        order = np.argsort(pos)
        self.order = order
        gaps = np.abs(np.diff(pos[order]))
        self.normal_gaps = gaps
        t = np.zeros(len(pos))
        for a, k in enumerate(order):
            g = []
            if a > 0:
                g.append(gaps[a - 1])
            if a < len(order) - 1:
                g.append(gaps[a])
            t[k] = float(np.mean(g)) if g else 1.0
        self.thick = t
        step = np.linalg.norm(np.diff(self.ipps, axis=0), axis=1)
        self.max_edge = float(max(self.row_mm, self.col_mm, step.max() if len(step) else 1.0))

    def grid_lps(self, k):
        """スライス k の全画素中心の LPS (rows, cols, 3)。読み手の変換（負例では壊れる）。"""
        j, i = np.meshgrid(np.arange(self.rows), np.arange(self.cols), indexing="ij")
        return (self.ipps[k] + i[..., None] * self._col_mm * self.rc + j[..., None] * self._row_mm * self._rr)

    def true_grid_lps(self, k):
        j, i = np.meshgrid(np.arange(self.rows), np.arange(self.cols), indexing="ij")
        return self.ipps[k] + i[..., None] * self.col_mm * self.rc + j[..., None] * self.row_mm * self.rr

    def lps_of(self, k, col, row):
        return self.ipps[k] + col * self._col_mm * self.rc + row * self._row_mm * self._rr

    def analytic_mask(self, k, center=None, radius=None):
        c = self.sph_c if center is None else center
        r = self.sph_r if radius is None else radius
        p = self.true_grid_lps(k) - c
        return np.sum(p * p, -1) <= r * r

    def dist_to_surface(self, k):
        p = self.true_grid_lps(k) - self.sph_c
        return np.abs(np.sqrt(np.sum(p * p, -1)) - self.sph_r)

    def sphere_volume(self):
        return 4.0 / 3.0 * math.pi * self.sph_r ** 3

    def sphere_surface(self):
        return 4.0 * math.pi * self.sph_r ** 2


def load_geo(args, neg=None):
    truth = json.load(open(args.truth))
    return Geo(truth, args.series, neg), truth


def verdict(vs, name, ok, detail=None, info=False):
    vs.append({"name": name, "status": "info" if info else ("pass" if ok else "fail"), "detail": detail})


def f3(v):
    return [round(float(x), 5) for x in v]


# ───────────────────────── SEG 読み手 ─────────────────────────
def _first(seq):
    return seq[0] if seq is not None and len(seq) else None


def read_seg_raw(path):
    ds = pydicom.dcmread(path)
    nf = int(ds.get("NumberOfFrames", 1))
    rows, cols = int(ds.Rows), int(ds.Columns)
    bits = int(ds.BitsAllocated)
    raw = ds.PixelData
    n = nf * rows * cols
    if bits == 1:
        arr = np.unpackbits(np.frombuffer(raw, np.uint8), bitorder="little")[:n]
    elif bits == 8:
        arr = (np.frombuffer(raw, np.uint8)[:n] != 0).astype(np.uint8)
    else:
        arr = (np.frombuffer(raw, np.uint16)[:n] != 0).astype(np.uint8)
    arr = arr.reshape(nf, rows, cols).astype(bool)
    shared = _first(ds.get("SharedFunctionalGroupsSequence"))
    iop = ps = st = sbs = None
    if shared is not None:
        po = _first(shared.get("PlaneOrientationSequence"))
        pm = _first(shared.get("PixelMeasuresSequence"))
        if po is not None:
            iop = [float(x) for x in po.ImageOrientationPatient]
        if pm is not None:
            ps = [float(x) for x in pm.PixelSpacing]
            st = float(pm.SliceThickness) if "SliceThickness" in pm else None
            sbs = float(pm.SpacingBetweenSlices) if "SpacingBetweenSlices" in pm else None
    frames = []
    for f in ds.PerFrameFunctionalGroupsSequence:
        pp = _first(f.get("PlanePositionSequence"))
        sid = _first(f.get("SegmentIdentificationSequence"))
        der = _first(f.get("DerivationImageSequence"))
        src = _first(der.get("SourceImageSequence")) if der is not None else None
        frames.append({
            "ipp": [float(x) for x in pp.ImagePositionPatient] if pp is not None else None,
            "seg": int(sid.ReferencedSegmentNumber) if sid is not None else None,
            "sop": str(src.ReferencedSOPInstanceUID) if src is not None else None,
        })
    ref_series = None
    rs = _first(ds.get("ReferencedSeriesSequence"))
    if rs is not None:
        ref_series = str(rs.SeriesInstanceUID)
    return {"ds": ds, "arr": arr, "frames": frames, "iop": iop, "ps": ps, "st": st, "sbs": sbs,
            "rows": rows, "cols": cols, "ref_series": ref_series, "type": str(ds.get("SegmentationType", "")),
            "segments": [int(s.SegmentNumber) for s in ds.get("SegmentSequence", [])]}


def cmd_seg(args):
    g, _ = load_geo(args, args.neg)
    r = read_seg_raw(args.file)
    vs = []
    out = {"file": args.file, "frames": len(r["frames"]), "segments": r["segments"], "type": r["type"]}
    verdict(vs, "SEG: Modality=SEG かつフレームが 1 以上", str(r["ds"].Modality) == "SEG" and len(r["frames"]) > 0,
            {"modality": str(r["ds"].Modality), "frames": len(r["frames"])})
    verdict(vs, "SEG: Rows/Columns が元スライスと一致", (r["rows"], r["cols"]) == (g.rows, g.cols),
            {"seg": [r["rows"], r["cols"]], "truth": [g.rows, g.cols]})
    verdict(vs, "SEG: IOP が元の IOP と一致", r["iop"] is not None and np.allclose(r["iop"], g.iop, atol=1e-5),
            {"seg": r["iop"], "truth": f3(g.iop)})
    verdict(vs, "SEG: PixelSpacing [行, 列] が元と一致",
            r["ps"] is not None and np.allclose(r["ps"], [g.row_mm, g.col_mm], atol=1e-6),
            {"seg": r["ps"], "truth": [g.row_mm, g.col_mm]})
    verdict(vs, "SEG: 参照シリーズ UID が元シリーズ", r["ref_series"] == g.series_uid,
            {"seg": r["ref_series"], "truth": g.series_uid})
    # フレームごとの IPP と参照 SOP
    n_ipp_ok = n_sop_ok = 0
    ipp_err = 0.0
    bad = []
    frame_k = []
    for n, f in enumerate(r["frames"]):
        k = g.sop_index.get(f["sop"])
        frame_k.append(k)
        if k is None:
            bad.append({"frame": n, "why": "参照 SOP が元シリーズに無い", "sop": f["sop"]})
            continue
        n_sop_ok += 1
        if f["ipp"] is not None:
            e = float(np.linalg.norm(np.array(f["ipp"]) - g.ipps[k]))
            ipp_err = max(ipp_err, e)
            if e <= 1e-3:
                n_ipp_ok += 1
            else:
                bad.append({"frame": n, "why": "IPP が参照スライスの IPP と違う", "err_mm": e})
    nf = len(r["frames"])
    verdict(vs, "SEG: 全フレームの参照 SOP が元スライスを指す", n_sop_ok == nf, {"ok": n_sop_ok, "frames": nf, "bad": bad[:5]})
    verdict(vs, "SEG: 全フレームの IPP が参照スライスの IPP と一致（≤ 1e-3 mm）", n_ipp_ok == nf,
            {"ok": n_ipp_ok, "frames": nf, "max_err_mm": ipp_err, "bad": bad[:5]})
    # 前景の LPS
    seg_no = r["segments"][0] if r["segments"] else 1
    got = np.zeros((len(g.sops), g.rows, g.cols), bool)
    for n, f in enumerate(r["frames"]):
        k = frame_k[n]
        if k is None or f["seg"] != seg_no:
            continue
        got[k] |= r["arr"][n]
    N = int(got.sum())
    verdict(vs, "SEG: 前景ボクセルがある", N > 0, {"N": N})
    if N == 0:
        return finish(out, vs)
    cen = np.zeros(3)
    vol = 0.0
    exp_set = np.zeros_like(got)
    for k in range(len(g.sops)):
        if got[k].any():
            pts = g.grid_lps(k)[got[k]]
            cen += pts.sum(0)
        vol += float(got[k].sum()) * g.row_mm * g.col_mm * g.thick[k]
        exp_set[k] = g.analytic_mask(k)
    cen /= N
    err = float(np.linalg.norm(cen - g.sph_c))
    tol_c = g.max_edge / 2
    verdict(vs, "SEG: 前景の LPS 重心が球の中心に一致", err <= tol_c,
            {"centroid": f3(cen), "truth": f3(g.sph_c), "err_mm": round(err, 4), "tol_mm": round(tol_c, 4)})
    V = g.sphere_volume()
    bound = g.sphere_surface() * g.max_edge / 2
    verdict(vs, "SEG: 前景数×ボクセル体積が球の体積に一致（表面積×最大辺/2）", abs(vol - V) <= bound,
            {"volume_mm3": round(vol, 2), "truth_mm3": round(V, 2), "ratio": round(vol / V, 5), "bound_mm3": round(bound, 1)})
    # 解析格子との差
    diff = got ^ exp_set
    m = int(diff.sum())
    far = 0
    for k in range(len(g.sops)):
        if diff[k].any():
            d = g.dist_to_surface(k)[diff[k]]
            far += int((d > g.max_edge / 2).sum())
    verdict(vs, "SEG: 解析格子との食い違いボクセルが全て球面の近傍（≤ 最大辺/2）", far == 0,
            {"mismatch": m, "far_from_surface": far, "N": N, "analytic_N": int(exp_set.sum())})
    cen_exp = np.zeros(3)
    for k in range(len(g.sops)):
        if exp_set[k].any():
            cen_exp += g.true_grid_lps(k)[exp_set[k]].sum(0)
    cen_exp /= max(1, int(exp_set.sum()))
    tight = m * 2 * g.sph_r / N
    e2 = float(np.linalg.norm(cen - cen_exp))
    verdict(vs, "SEG: 重心が解析格子の重心に一致（食い違い数×直径/N）", e2 <= tight + 1e-6,
            {"err_mm": round(e2, 5), "bound_mm": round(tight, 5)})
    # 間隔
    ipps_f = [np.array(f["ipp"]) for f in r["frames"] if f["ipp"] is not None and f["seg"] == seg_no]
    pos = sorted(set(round(float(p @ g.normal), 6) for p in ipps_f))
    derived = np.diff(pos).tolist()
    first2 = float(np.linalg.norm(ipps_f[1] - ipps_f[0])) if len(ipps_f) > 1 else None
    out["spacing"] = {
        "written_SliceThickness": r["st"], "written_SpacingBetweenSlices": r["sbs"], "written_PixelSpacing": r["ps"],
        "derived_normal_gaps_from_frame_IPP": {"min": min(derived) if derived else None, "max": max(derived) if derived else None,
                                               "mean": float(np.mean(derived)) if derived else None, "n": len(derived)},
        "first_two_frame_IPP_distance": first2,
        "truth_normal_gaps": {"min": float(g.normal_gaps.min()), "max": float(g.normal_gaps.max()), "mean": float(g.normal_gaps.mean())},
        "frame_count_with_foreground": len(ipps_f),
    }
    # DICOM の定義: SpacingBetweenSlices は隣接スライスの**中心間の距離**（IPP 間のユークリッド距離。チルトでも法線方向ではない）。
    # 一様なら書かれ、一様でない（不等間隔・欠損）なら**書かない**のが正しい。SliceThickness は source の公称の厚み（truth の ds.SliceThickness）。
    pts = sorted([np.array(p) for p in g.ipps], key=lambda p: float(p @ g.normal))
    cc = np.array([float(np.linalg.norm(pts[i + 1] - pts[i])) for i in range(len(pts) - 1)])
    uniform = bool(cc.max() - cc.min() <= max(0.01, 0.01 * cc.mean()))
    center_gap = float(cc.mean())
    sbs = r["sbs"]
    d = {"written": sbs, "truth_center_to_center_mean": round(center_gap, 5), "uniform": uniform,
         "truth_center_gaps_min_max": [round(float(cc.min()), 4), round(float(cc.max()), 4)]}
    if uniform:
        ok_sbs = sbs is not None and abs(sbs - center_gap) <= 1e-3 * max(1.0, center_gap)
        verdict(vs, "SEG: SpacingBetweenSlices = 隣接スライスの中心間距離（一様）", ok_sbs, d)
    else:
        verdict(vs, "SEG: 不等間隔・欠損では SpacingBetweenSlices を書かない", sbs is None, d)
    stt = r["st"]
    nominal = float(getattr(g, "slice_thickness", float(cc.min())))
    ok_st = stt is not None and abs(stt - nominal) <= 1e-3 * max(1.0, nominal)
    verdict(vs, "SEG: SliceThickness = source の公称の厚み", ok_st, {"written": stt, "truth_nominal": round(nominal, 5)})
    return finish(out, vs)


def finish(out, vs):
    out["verdicts"] = vs
    print(json.dumps(out, ensure_ascii=False))


def cmd_segcount(args):
    """2D ROI を SEG にしたもの: 前景画素数・LPS 重心・どのスライスか（真値の格子で読む）。"""
    g, _ = load_geo(args, args.neg)
    r = read_seg_raw(args.file)
    per = {}
    pts = []
    for n, f in enumerate(r["frames"]):
        k = g.sop_index.get(f["sop"])
        c = int(r["arr"][n].sum())
        if k is None or not c:
            continue
        per[k] = per.get(k, 0) + c
        pts.append(g.grid_lps(k)[r["arr"][n]])
    P = np.concatenate(pts) if pts else np.zeros((0, 3))
    out = {"file": args.file, "count": int(P.shape[0]), "slices": sorted(per), "frames": len(r["frames"]),
           "area_mm2": float(P.shape[0] * g.row_mm * g.col_mm),
           "centroid_lps": f3(P.mean(0)) if len(P) else None,
           "ps": r["ps"], "iop": r["iop"]}
    print(json.dumps(out, ensure_ascii=False))


# ───────────────────────── RTSTRUCT 読み手 ─────────────────────────
def cmd_rt(args):
    g, _ = load_geo(args, args.neg)
    ds = pydicom.dcmread(args.file)
    names = {int(s.ROINumber): str(s.ROIName) for s in ds.StructureSetROISequence}
    rois = []
    for rc in ds.ROIContourSequence:
        num = int(rc.ReferencedROINumber)
        conts = []
        for c in rc.get("ContourSequence", []):
            pts = np.array([float(x) for x in c.ContourData], float).reshape(-1, 3)
            sop = None
            ci = _first(c.get("ContourImageSequence"))
            if ci is not None:
                sop = str(ci.ReferencedSOPInstanceUID)
            k = g.sop_index.get(sop)
            entry = {"type": str(c.ContourGeometricType), "n": int(c.NumberOfContourPoints), "n_actual": len(pts),
                     "sop": sop, "slice": k}
            ipp = g.ipps[k] if k is not None else pts[0]
            # 読み手の LPS→面内 mm（列方向・行方向の距離）。負例ではここを壊す。
            rel = pts - ipp
            u = rel @ g.rc
            v = rel @ g._rr
            w = rel @ g.normal
            entry["offplane_mm_max"] = float(np.abs(w).max())
            if len(pts) >= 3:
                # 3D のベクトル面積（平面なら面内射影と一致）と、面内射影のシューレース
                cr = np.zeros(3)
                for a in range(len(pts)):
                    cr += np.cross(pts[a], pts[(a + 1) % len(pts)])
                entry["area_vec_mm2"] = float(np.linalg.norm(cr) / 2)
                entry["area_inplane_mm2"] = float(abs(np.sum(u * np.roll(v, -1) - np.roll(u, -1) * v)) / 2)
                entry["perimeter_mm"] = float(np.sum(np.linalg.norm(pts - np.roll(pts, -1, axis=0), axis=1)))
            entry["centroid_lps"] = f3(pts.mean(0))
            entry["bbox_uv_mm"] = [float(u.min()), float(v.min()), float(u.max()), float(v.max())]
            # 外接の画素座標（ImageJ 規約: 画素 i は [i, i+1]、中心は i+0.5）
            entry["bbox_px"] = [float(u.min() / g._col_mm + 0.5), float(v.min() / g._row_mm + 0.5),
                                float(u.max() / g._col_mm + 0.5), float(v.max() / g._row_mm + 0.5)]
            entry["points_lps"] = [f3(p) for p in pts[:200]]
            conts.append(entry)
        rois.append({"number": num, "name": names.get(num), "contours": conts})
    for_uid = None
    rf = _first(ds.get("ReferencedFrameOfReferenceSequence"))
    if rf is not None:
        for_uid = str(rf.FrameOfReferenceUID)
    out = {"file": args.file, "for_uid": for_uid, "rois": rois}
    vs = []
    verdict(vs, "RTSTRUCT: Modality=RTSTRUCT", str(ds.Modality) == "RTSTRUCT", {"modality": str(ds.Modality)})
    allk = [c["slice"] for r in rois for c in r["contours"]]
    verdict(vs, "RTSTRUCT: 全輪郭の参照 SOP が元シリーズ内", all(k is not None for k in allk) and len(allk) > 0,
            {"contours": len(allk)})
    out["verdicts"] = vs
    print(json.dumps(out, ensure_ascii=False))


# ───────────────────────── ImageJ .roi 読み手（バイト列の仕様どおり）─────────────────────────
IJ_TYPES = {0: "polygon", 1: "rect", 2: "oval", 3: "line", 4: "freeline", 5: "polyline", 6: "noroi",
            7: "freehand", 8: "traced", 9: "angle", 10: "composite", 11: "point"}


def parse_ij_roi(b, name=""):
    if b[0:4] != b"Iout":
        raise ValueError("magic が Iout でない")
    ver = struct.unpack(">h", b[4:6])[0]
    t = b[6]
    top, left, bottom, right = struct.unpack(">hhhh", b[8:16])
    n = struct.unpack(">h", b[16:18])[0]
    x1, y1, x2, y2 = struct.unpack(">ffff", b[18:34])
    options = struct.unpack(">h", b[50:52])[0]
    position = struct.unpack(">i", b[56:60])[0]
    d = {"name": name, "version": ver, "type": IJ_TYPES.get(t, t), "typeCode": t,
         "bbox_int": {"left": left, "top": top, "right": right, "bottom": bottom,
                      "width": right - left, "height": bottom - top},
         "n": n, "options": options, "position": position}
    if options & 128 and t in (1, 2):  # SUB_PIXEL_RESOLUTION
        xd, yd, wd, hd = struct.unpack(">ffff", b[18:34])
        d["bbox_sub"] = {"x": xd, "y": yd, "w": wd, "h": hd}
    if t in (0, 7, 8, 4, 5, 9, 11) and n > 0:
        xs = struct.unpack(">" + "h" * n, b[64:64 + 2 * n])
        ys = struct.unpack(">" + "h" * n, b[64 + 2 * n:64 + 4 * n])
        d["xs_rel"], d["ys_rel"] = list(xs), list(ys)
        d["xs"] = [left + x for x in xs]
        d["ys"] = [top + y for y in ys]
        if options & 128 and len(b) >= 64 + 4 * n + 8 * n:
            fx = struct.unpack(">" + "f" * n, b[64 + 4 * n:64 + 8 * n])
            fy = struct.unpack(">" + "f" * n, b[64 + 8 * n:64 + 12 * n])
            d["xs_f"], d["ys_f"] = list(fx), list(fy)
    if t == 3:
        d["line"] = [x1, y1, x2, y2]
    return d


def cmd_ij(args):
    data = open(args.file, "rb").read()
    rois = []
    if data[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(data))
        for nme in z.namelist():
            rois.append(parse_ij_roi(z.read(nme), nme))
    else:
        rois.append(parse_ij_roi(data, os.path.basename(args.file)))
    print(json.dumps({"file": args.file, "rois": rois}, ensure_ascii=False))


# ───────────────────────── CSV ─────────────────────────
def cmd_csv(args):
    txt = open(args.file, encoding="utf-8-sig", newline="").read()
    rows = list(csvmod.DictReader(io.StringIO(txt)))
    print(json.dumps({"file": args.file, "header": list(rows[0].keys()) if rows else [], "rows": rows}, ensure_ascii=False))


# ───────────────────────── マスクのボクセル CSV（取り込みの結果の測定）─────────────────────────
def cmd_maskdump(args):
    g, _ = load_geo(args)
    txt = open(args.file, encoding="utf-8-sig", newline="").read()
    rows = list(csvmod.DictReader(io.StringIO(txt)))
    pts = []
    per_sop = {}
    unknown = 0
    for r in rows:
        sop = None
        iid = r["imageId"]
        if "/instances/" in iid:
            sop = iid.split("/instances/")[1].split("/")[0]
        k = g.sop_index.get(sop)
        if k is None:
            unknown += 1
            continue
        pts.append(g.true_grid_lps(k)[int(r["row"]), int(r["col"])])
        per_sop[k] = per_sop.get(k, 0) + 1
    out = {"file": args.file, "voxels": len(rows), "unknown_sop": unknown, "slices": sorted(per_sop)}
    if pts:
        P = np.array(pts)
        c = P.mean(0)
        out["centroid_lps"] = f3(c)
        out["offset_from_sphere_mm"] = f3(c - g.sph_c)
        out["dist_from_sphere_center_mm"] = float(np.linalg.norm(c - g.sph_c))
        out["volume_mm3"] = float(sum(n * g.row_mm * g.col_mm * g.thick[k] for k, n in per_sop.items()))
        # 解析格子との一致（食い違い数）
        exp_n = got_in = 0
        sets = {}
        for r in rows:
            iid = r["imageId"]
            sop = iid.split("/instances/")[1].split("/")[0] if "/instances/" in iid else None
            k = g.sop_index.get(sop)
            if k is not None:
                sets.setdefault(k, set()).add((int(r["row"]), int(r["col"])))
        for k in range(len(g.sops)):
            e = g.analytic_mask(k)
            exp_n += int(e.sum())
            for (rr_, cc) in sets.get(k, ()):
                if e[rr_, cc]:
                    got_in += 1
        out["analytic_N"] = exp_n
        out["in_analytic"] = got_in
    print(json.dumps(out, ensure_ascii=False))


# ───────────────────────── 書き手（取り込みの入力）─────────────────────────
class Uid:
    def __init__(self, seed):
        self.rng = np.random.default_rng(seed)

    def new(self):
        return UID("2.25." + str(int.from_bytes(self.rng.bytes(16), "big")))


def _code(value, scheme, meaning):
    d = Dataset()
    d.CodeValue, d.CodingSchemeDesignator, d.CodeMeaning = value, scheme, meaning
    return d


def write_seg(path, g, truth, frames, desc, uid, ref_series_uid, for_uid, ipp_of, ref_sop_of, iop, study_uid=None, bitorder="little"):
    """frames: [(source slice index k, bool mask(rows, cols))]。ipp_of(k) / ref_sop_of(k) で IPP と参照 SOP を決める。"""
    meta = FileMetaDataset()
    sop = uid.new()
    meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID, meta.TransferSyntaxUID = SEG_UID, sop, ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = SEG_UID, sop
    ds.StudyInstanceUID = study_uid or g.study_uid
    ds.SeriesInstanceUID = uid.new()
    ds.FrameOfReferenceUID = for_uid
    ds.PatientName, ds.PatientID = "Phantom^GeomVerify", "GEOMV-" + g.id.upper()
    ds.PatientBirthDate, ds.PatientSex = "19700101", "O"
    ds.StudyDate = ds.SeriesDate = ds.ContentDate = "20261111"
    ds.StudyTime = ds.SeriesTime = ds.ContentTime = "120000"
    ds.Modality = "SEG"
    ds.SeriesDescription = desc
    ds.SeriesNumber, ds.InstanceNumber = 900, 1
    ds.Manufacturer = "geom-verify"
    ds.ImageType = ["DERIVED", "PRIMARY"]
    ds.ContentLabel, ds.ContentDescription, ds.ContentCreatorName = "GEOMV", desc, "geomverify"
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.Rows, ds.Columns = g.rows, g.cols
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 1, 1, 0, 0
    ds.LossyImageCompression = "00"
    ds.SegmentationType = "BINARY"
    ds.NumberOfFrames = len(frames)
    ds.DimensionOrganizationType = "3D"
    seg = Dataset()
    seg.SegmentNumber = 1
    seg.SegmentLabel = "sphere"
    seg.SegmentAlgorithmType = "MANUAL"
    seg.SegmentedPropertyCategoryCodeSequence = Sequence([_code("T-D0050", "SRT", "Tissue")])
    seg.SegmentedPropertyTypeCodeSequence = Sequence([_code("T-D0050", "SRT", "Tissue")])
    ds.SegmentSequence = Sequence([seg])
    dimuid = uid.new()
    do = Dataset()
    do.DimensionOrganizationUID = dimuid
    ds.DimensionOrganizationSequence = Sequence([do])
    di1, di2 = Dataset(), Dataset()
    di1.DimensionOrganizationUID = dimuid
    di1.DimensionIndexPointer = 0x0062000B  # ReferencedSegmentNumber
    di1.FunctionalGroupPointer = 0x0062000A  # SegmentIdentificationSequence
    di2.DimensionOrganizationUID = dimuid
    di2.DimensionIndexPointer = 0x00200032  # ImagePositionPatient
    di2.FunctionalGroupPointer = 0x00209113  # PlanePositionSequence
    ds.DimensionIndexSequence = Sequence([di1, di2])
    sh = Dataset()
    po = Dataset()
    po.ImageOrientationPatient = [float(x) for x in iop]
    sh.PlaneOrientationSequence = Sequence([po])
    pm = Dataset()
    pm.PixelSpacing = [g.row_mm, g.col_mm]
    gaps = g.normal_gaps
    pm.SliceThickness = float(gaps.mean())
    pm.SpacingBetweenSlices = float(gaps.mean())
    sh.PixelMeasuresSequence = Sequence([pm])
    ds.SharedFunctionalGroupsSequence = Sequence([sh])
    per = []
    bits = np.zeros(len(frames) * g.rows * g.cols, np.uint8)
    for n, (k, m) in enumerate(frames):
        f = Dataset()
        fc = Dataset()
        fc.DimensionIndexValues = [1, n + 1]
        f.FrameContentSequence = Sequence([fc])
        pp = Dataset()
        pp.ImagePositionPatient = [float(x) for x in ipp_of(k)]
        f.PlanePositionSequence = Sequence([pp])
        si = Dataset()
        si.ReferencedSegmentNumber = 1
        f.SegmentIdentificationSequence = Sequence([si])
        der = Dataset()
        src = Dataset()
        src.ReferencedSOPClassUID, src.ReferencedSOPInstanceUID = CT_UID, ref_sop_of(k)
        pur = Dataset()
        pur.CodeValue, pur.CodingSchemeDesignator, pur.CodeMeaning = "121322", "DCM", "Source image for image processing operation"
        src.PurposeOfReferenceCodeSequence = Sequence([pur])
        der.SourceImageSequence = Sequence([src])
        dcode = Dataset()
        dcode.CodeValue, dcode.CodingSchemeDesignator, dcode.CodeMeaning = "113076", "DCM", "Segmentation"
        der.DerivationCodeSequence = Sequence([dcode])
        f.DerivationImageSequence = Sequence([der])
        per.append(f)
        bits[n * g.rows * g.cols:(n + 1) * g.rows * g.cols] = m.reshape(-1).astype(np.uint8)
    ds.PerFrameFunctionalGroupsSequence = Sequence(per)
    ds.PixelData = np.packbits(bits, bitorder=bitorder).tobytes()
    # 参照シリーズ
    rs = Dataset()
    rs.SeriesInstanceUID = ref_series_uid
    ri = []
    for k in sorted(set(k for k, _ in frames)):
        it = Dataset()
        it.ReferencedSOPClassUID, it.ReferencedSOPInstanceUID = CT_UID, ref_sop_of(k)
        ri.append(it)
    rs.ReferencedInstanceSequence = Sequence(ri)
    ds.ReferencedSeriesSequence = Sequence([rs])
    ds.save_as(path, enforce_file_format=True)
    return str(ds.SeriesInstanceUID)


def cmd_make_seg(args):
    g, truth = load_geo(args)
    uid = Uid(int(args.uid_seed))
    for_uid = truth.get("frameUid") or None
    # FrameOfReferenceUID は truth.json に無いので、元シリーズの DICOM から読む
    if args.source_dir:
        f0 = sorted(os.listdir(os.path.join(args.source_dir, g.id)))[0]
        for_uid = str(pydicom.dcmread(os.path.join(args.source_dir, g.id, f0), stop_before_pixels=True).FrameOfReferenceUID)
    mode = args.mode
    frames = []
    if mode == "correct":
        ipp_of = lambda k: g.ipps[k]
        for k in range(len(g.sops)):
            m = g.analytic_mask(k)
            if m.any():
                frames.append((k, m))
        sid = write_seg(args.out, g, truth, frames, args.desc, uid, g.series_uid, for_uid, ipp_of, lambda k: g.sops[k], g.iop,
                        bitorder="big" if args.bigendian_bits else "little")
    elif mode == "shift":
        # IPP を面内（列方向）へ shift 画素ずらした格子。内容は「球の本当の位置」を、そのずらした格子で標本化したもの
        # （= 宣言された幾何どおりに読めば球に重なる）。SOP 参照・次元は元のまま。
        sh = float(args.shift)
        off = sh * g.col_mm * g.rc
        ipp_of = lambda k: g.ipps[k] + off
        for k in range(len(g.sops)):
            j, i = np.meshgrid(np.arange(g.rows), np.arange(g.cols), indexing="ij")
            p = (g.ipps[k] + off) + i[..., None] * g.col_mm * g.rc + j[..., None] * g.row_mm * g.rr
            d = p - g.sph_c
            m = np.sum(d * d, -1) <= g.sph_r ** 2
            if m.any():
                frames.append((k, m))
        sid = write_seg(args.out, g, truth, frames, args.desc, uid, g.series_uid, for_uid, ipp_of, lambda k: g.sops[k], g.iop)
    elif mode == "wrongseries":
        # 別シリーズ（args.other）の幾何で球を標本化した SEG。参照はその別シリーズ（表示中のシリーズ ≠ 参照）。
        truth2 = truth
        o = Geo(truth2, args.other)
        if (o.rows, o.cols) != (g.rows, g.cols):
            raise SystemExit("同サイズの別シリーズでない")
        ofor = for_uid
        for k in range(len(o.sops)):
            m = o.analytic_mask(k)
            if m.any():
                frames.append((k, m))
        o_geo_for_write = o
        sid = write_seg(args.out, o, truth, frames, args.desc, uid, o.series_uid, ofor, lambda k: o.ipps[k], lambda k: o.sops[k], o.iop)
    else:
        raise SystemExit("mode?")
    print(json.dumps({"out": args.out, "seriesUid": sid, "frames": len(frames),
                      "voxels": int(sum(int(m.sum()) for _, m in frames))}))


def cmd_make_rt(args):
    g, truth = load_geo(args)
    uid = Uid(int(args.uid_seed))
    f0 = sorted(os.listdir(os.path.join(args.source_dir, g.id)))[0]
    for_uid = str(pydicom.dcmread(os.path.join(args.source_dir, g.id, f0), stop_before_pixels=True).FrameOfReferenceUID)
    # 球の中心に最も近いスライスの断面の円（72 点）。読み手の座標系ではなく真値の LPS で書く。
    pos = np.array([abs(float((g.sph_c - p) @ g.normal)) for p in g.ipps])
    kb = int(pos.argmin())
    dN = float((g.sph_c - g.ipps[kb]) @ g.normal)
    rp = math.sqrt(g.sph_r ** 2 - dN ** 2)
    pc = g.sph_c - dN * g.normal
    ring = []
    for a in range(72):
        t = 2 * math.pi * a / 72
        ring.append(pc + rp * (math.cos(t) * g.rc + math.sin(t) * g.rr))
    ring = np.array(ring)
    meta = FileMetaDataset()
    sop = uid.new()
    meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID, meta.TransferSyntaxUID = RT_UID, sop, ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = RT_UID, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID = g.study_uid, uid.new()
    ds.PatientName, ds.PatientID = "Phantom^GeomVerify", "GEOMV-" + g.id.upper()
    ds.PatientBirthDate, ds.PatientSex = "19700101", "O"
    ds.StudyDate = ds.SeriesDate = ds.StructureSetDate = "20261111"
    ds.StudyTime = ds.SeriesTime = ds.StructureSetTime = "120000"
    ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "RTSTRUCT", 901, 1
    ds.SeriesDescription = args.desc
    ds.Manufacturer = "geom-verify"
    ds.StructureSetLabel = "GEOMV"
    ds.FrameOfReferenceUID = for_uid
    ci = lambda s: _mkref(s)
    rfor = Dataset()
    rfor.FrameOfReferenceUID = for_uid
    rs = Dataset()
    rs.ReferencedSOPClassUID = UID("1.2.840.10008.3.1.2.3.2")
    rs.ReferencedSOPInstanceUID = g.study_uid
    rser = Dataset()
    rser.SeriesInstanceUID = g.series_uid
    rser.ContourImageSequence = Sequence([_mkref(g.sops[kb])])
    rs.RTReferencedSeriesSequence = Sequence([rser])
    rfor.RTReferencedStudySequence = Sequence([rs])
    ds.ReferencedFrameOfReferenceSequence = Sequence([rfor])
    specs = [("E_circle", ring, g.sops[kb]),
             ("E_badref", ring + 20 * g.rc, str(uid.new()))]  # 参照 SOP が元シリーズに無い輪郭（面内 +20 mm の位置）
    ssr, rcs, obs = [], [], []
    for n, (name, pts, refsop) in enumerate(specs, start=1):
        s = Dataset()
        s.ROINumber, s.ReferencedFrameOfReferenceUID, s.ROIName, s.ROIGenerationAlgorithm = n, for_uid, name, "MANUAL"
        ssr.append(s)
        r = Dataset()
        r.ReferencedROINumber = n
        r.ROIDisplayColor = [255, 0, 0]
        c = Dataset()
        c.ContourGeometricType = "CLOSED_PLANAR"
        c.NumberOfContourPoints = len(pts)
        c.ContourData = [float(x) for x in pts.reshape(-1)]
        c.ContourImageSequence = Sequence([_mkref(refsop)])
        r.ContourSequence = Sequence([c])
        rcs.append(r)
        o = Dataset()
        o.ObservationNumber, o.ReferencedROINumber, o.RTROIInterpretedType, o.ROIInterpreter = n, n, "ORGAN", ""
        obs.append(o)
    ds.StructureSetROISequence = Sequence(ssr)
    ds.ROIContourSequence = Sequence(rcs)
    ds.RTROIObservationsSequence = Sequence(obs)
    ds.save_as(args.out, enforce_file_format=True)
    print(json.dumps({"out": args.out, "slice": kb, "radius_mm": rp, "center_lps": f3(pc)}))


def _mkref(sop):
    d = Dataset()
    d.ReferencedSOPClassUID, d.ReferencedSOPInstanceUID = CT_UID, sop
    return d


# ───────────────────────── 検査器の自己検査（正例・負例）─────────────────────────
def cmd_selftest(args):
    import subprocess
    me = os.path.abspath(__file__)
    os.makedirs(args.work, exist_ok=True)
    seg = os.path.join(args.work, "selftest-seg.dcm")
    base = ["python3", "-I", me]
    common = ["--truth", args.truth, "--series", args.series]
    r = subprocess.run(base + ["make-seg", "--out", seg, "--mode", "correct", "--desc", "selftest", "--uid-seed", args.uid_seed,
                               "--source-dir", args.source_dir] + common, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr)
        raise SystemExit(2)

    def run(neg):
        c = base + ["seg", "--file", seg] + common + (["--neg", neg] if neg else [])
        o = subprocess.run(c, capture_output=True, text=True)
        return json.loads(o.stdout)

    res = {}
    for neg in (None, "flip", "swap"):
        o = run(neg)
        res[neg or "positive"] = {"fail": [v["name"] for v in o["verdicts"] if v["status"] == "fail"],
                                  "pass": sum(1 for v in o["verdicts"] if v["status"] == "pass")}
    # 書き手側を壊した入力（読み手が落とすこと）: ビット順 MSB-first / IPP を 1 列ぶんずらした SEG
    bad = os.path.join(args.work, "selftest-seg-bigendian.dcm")
    subprocess.run(base + ["make-seg", "--out", bad, "--mode", "correct", "--desc", "selftest", "--uid-seed", args.uid_seed,
                           "--source-dir", args.source_dir, "--bigendian-bits"] + common, capture_output=True, text=True)
    o = subprocess.run(base + ["seg", "--file", bad] + common, capture_output=True, text=True)
    j = json.loads(o.stdout)
    res["bigendian_bits"] = {"fail": [v["name"] for v in j["verdicts"] if v["status"] == "fail"]}
    shifted = os.path.join(args.work, "selftest-seg-shift.dcm")
    subprocess.run(base + ["make-seg", "--out", shifted, "--mode", "shift", "--shift", "4", "--desc", "selftest", "--uid-seed", args.uid_seed,
                           "--source-dir", args.source_dir] + common, capture_output=True, text=True)
    o = subprocess.run(base + ["seg", "--file", shifted] + common, capture_output=True, text=True)
    j = json.loads(o.stdout)
    res["ipp_shifted_4px"] = {"fail": [v["name"] for v in j["verdicts"] if v["status"] == "fail"]}
    print(json.dumps(res, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--file")
    ap.add_argument("--truth")
    ap.add_argument("--series")
    ap.add_argument("--neg", default=None)
    ap.add_argument("--out")
    ap.add_argument("--mode", default="correct")
    ap.add_argument("--desc", default="E")
    ap.add_argument("--uid-seed", default="1")
    ap.add_argument("--shift", default="4")
    ap.add_argument("--other", default="g2_oblique")
    ap.add_argument("--source-dir")
    ap.add_argument("--work")
    ap.add_argument("--bigendian-bits", action="store_true")
    args = ap.parse_args()
    {"seg": cmd_seg, "segcount": cmd_segcount, "rt": cmd_rt, "ij": cmd_ij, "csv": cmd_csv, "maskdump": cmd_maskdump,
     "make-seg": cmd_make_seg, "make-rt": cmd_make_rt, "selftest": cmd_selftest}[args.cmd](args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Parametric Map（整数画素＋Real World Value Mapping）の適合検査（pydicom のみ。本体のコードと無関係）。

根拠: DICOM PS3.3 2026e の A.75（Parametric Map IOD）・C.8.32（Series・Image・Frame Type）・
C.7.6.16（機能グループ）・C.7.6.17（Dimension）・C.7.5.2（Enhanced General Equipment）ほか。
dicom-validator は PM の機能グループ表を読めない（group_macros が空）ので、その分と Image Type の値 3・4、
RWVM の整合（First/Last と画素）をここで見る。

使い方: python3 -I pmConformanceCheck.py [--reference ref.npy] file.dcm [file.dcm ...]
  --reference: 1 ファイル目の実値（NaN＝値なし）。pydicom の pixel_array と RWVM から出した実値と、傾きの半分以内で突き合わせる
終了コード: 0=全ファイル合格、1=不適合あり、2=読めない
"""
import sys
import numpy as np
import pydicom

PM_SOP = "1.2.840.10008.5.1.4.1.1.30"
FAILS = []


def fail(msg):
    FAILS.append(msg)


def vals(x):
    """多値・単値のどちらでも list にする（pydicom は値が 1 つだと素の値を返す）。"""
    if x is None or x == "":
        return []
    return list(x) if isinstance(x, (list, tuple, pydicom.multival.MultiValue)) else [x]


def has(ds, kw):
    return kw in ds


def need(ds, kw, where, type2=False):
    """Type 1 は存在かつ非空、Type 2 は存在すれば空でもよい。"""
    if kw not in ds:
        fail(f"{where}: {kw} が無い")
        return None
    v = ds[kw].value
    if not type2 and (v is None or v == "" or (hasattr(v, "__len__") and len(v) == 0)):
        fail(f"{where}: {kw} が空（Type 1）")
        return None
    return v


def seq1(ds, kw, where):
    """項目が 1 つの Sequence を返す。"""
    if kw not in ds:
        fail(f"{where}: {kw} が無い")
        return None
    s = ds[kw].value
    if len(s) != 1:
        fail(f"{where}: {kw} の項目数が {len(s)}（1 のみ）")
        return None if len(s) == 0 else s[0]
    return s[0]


def check_code(item, where):
    for kw in ("CodeValue", "CodingSchemeDesignator", "CodeMeaning"):
        need(item, kw, where)


def check(path, reference=None):
    ds = pydicom.dcmread(path)
    w = path.split("/")[-1]
    n0 = len(FAILS)
    sop = need(ds, "SOPClassUID", w)
    if sop != PM_SOP:
        fail(f"{w}: SOP Class が Parametric Map でない（{sop}）")
    # --- Patient / Study / Series / FoR / Equipment ---
    for kw in ("PatientName", "PatientID", "PatientBirthDate", "PatientSex"):
        need(ds, kw, "Patient", type2=True)
    need(ds, "StudyInstanceUID", "Study")
    for kw in ("StudyDate", "StudyTime", "ReferringPhysicianName", "StudyID", "AccessionNumber"):
        need(ds, kw, "General Study", type2=True)
    need(ds, "Modality", "Series")
    need(ds, "SeriesInstanceUID", "Series")
    need(ds, "SeriesNumber", "Parametric Map Series")
    need(ds, "FrameOfReferenceUID", "Frame of Reference")
    need(ds, "PositionReferenceIndicator", "Frame of Reference", type2=True)
    for kw in ("Manufacturer", "ManufacturerModelName", "DeviceSerialNumber", "SoftwareVersions"):
        need(ds, kw, "Enhanced General Equipment")
    need(ds, "SOPInstanceUID", "SOP Common")
    # --- Parametric Map Image ---
    it = vals(ds.get("ImageType"))
    if len(it) != 4 or any(not x for x in it):
        fail(f"Image Type: 値 3・4 が零長不可（4 値が要る）: {it}")
    if len(it) >= 2 and (it[0] != "DERIVED" or it[1] != "PRIMARY"):
        fail(f"Image Type: 値 1・2 は DERIVED・PRIMARY（{it[:2]}）")
    need(ds, "InstanceNumber", "Image")
    lab = need(ds, "ContentLabel", "Content Identification")
    if lab is not None and (len(lab) > 16 or not all(c.isupper() or c.isdigit() or c in " _" for c in lab)):
        fail(f"Content Label が CS として不正: {lab!r}")
    need(ds, "ContentDescription", "Content Identification", type2=True)
    if need(ds, "ContentQualification", "Parametric Map Image") not in (None, "PRODUCT", "RESEARCH", "SERVICE"):
        fail("Content Qualification の列挙値でない")
    if need(ds, "SamplesPerPixel", "Parametric Map Image") != 1:
        fail("Samples per Pixel は 1")
    if need(ds, "PhotometricInterpretation", "Parametric Map Image") != "MONOCHROME2":
        fail("Photometric Interpretation は MONOCHROME2")
    if need(ds, "PresentationLUTShape", "Parametric Map Image") != "IDENTITY":
        fail("Presentation LUT Shape は IDENTITY")
    if need(ds, "BurnedInAnnotation", "Parametric Map Image") != "NO":
        fail("Burned In Annotation は NO")
    if need(ds, "RecognizableVisualFeatures", "Parametric Map Image") not in (None, "YES", "NO"):
        fail("Recognizable Visual Features は YES か NO")
    lossy = need(ds, "LossyImageCompression", "Parametric Map Image")
    if lossy not in (None, "00", "01"):
        fail("Lossy Image Compression は 00 か 01")
    if lossy == "01" and not (has(ds, "LossyImageCompressionRatio") or has(ds, "LossyImageCompressionMethod")):
        fail("Lossy=01 で、元に有れば Ratio・Method が 1C（元に無ければ不要なので注意として扱う）")
    # --- 画素 ---
    has_int = has(ds, "PixelData")
    has_flt = has(ds, "FloatPixelData") or has(ds, "DoubleFloatPixelData")
    if has_int == has_flt:
        fail("画素は Pixel Data か Float/Double Float Pixel Data のどちらか 1 つだけ")
    bs = ds.get("BitsStored")
    if has_int:
        if ds.get("BitsAllocated") != 16:
            fail(f"Bits Allocated は 16（{ds.get('BitsAllocated')}）")
        if bs != 16:
            fail(f"Bits Stored は 16（{bs}）")
        if ds.get("HighBit") != 15:
            fail(f"High Bit は 15（{ds.get('HighBit')}）")
        if ds.get("PixelRepresentation") not in (0, 1):
            fail("Pixel Representation は 0 か 1")
    # --- 禁止モジュール（A.75.4） ---
    for kw in ("WindowCenter", "WindowWidth", "VOILUTSequence", "RescaleSlope", "RescaleIntercept", "RescaleType",
               "ModalityLUTSequence", "RedPaletteColorLookupTableDescriptor"):
        if has(ds, kw):
            fail(f"トップレベルに {kw}（VOI LUT・Modality LUT・Supplemental Palette は PM で禁止）")
    if any(e.tag.group & 0xFF00 == 0x6000 for e in ds):
        fail("Overlay Plane は PM で禁止")
    # --- Multi-frame Functional Groups / Dimension ---
    need(ds, "ContentDate", "Multi-frame Functional Groups")
    need(ds, "ContentTime", "Multi-frame Functional Groups")
    nf = need(ds, "NumberOfFrames", "Multi-frame Functional Groups")
    if nf is not None and int(nf) < 1:
        fail("Number of Frames は 1 以上")
    shared = seq1(ds, "SharedFunctionalGroupsSequence", "Multi-frame Functional Groups")
    pf_seq = ds.get("PerFrameFunctionalGroupsSequence")
    if pf_seq is None or (nf is not None and len(pf_seq) != int(nf)):
        fail("Per-Frame Functional Groups Sequence の項目数が Number of Frames と違う")
    pf = pf_seq[0] if pf_seq else None
    dimorg = ds.get("DimensionOrganizationSequence")
    if not dimorg or len(dimorg) < 1:
        fail("Dimension Organization Sequence が無い")
    dimidx = ds.get("DimensionIndexSequence")
    if not dimidx or len(dimidx) < 1:
        fail("Dimension Index Sequence が無い（1C: TILED_FULL でないので必須）")
    else:
        uids = {d.DimensionOrganizationUID for d in (dimorg or [])}
        for d in dimidx:
            need(d, "DimensionIndexPointer", "Dimension Index")
            need(d, "DimensionOrganizationUID", "Dimension Index")
            if has(d, "DimensionOrganizationUID") and d.DimensionOrganizationUID not in uids:
                fail("Dimension Index の UID が Dimension Organization に無い")
    if not has(ds, "AcquisitionContextSequence"):
        fail("Acquisition Context Sequence が無い（IOD で M・Type 2）")
    # --- 機能グループ（共有） ---
    if shared is not None:
        if has(shared, "FrameContentSequence"):
            fail("Frame Content は共有に置けない")
        pm = seq1(shared, "PixelMeasuresSequence", "Pixel Measures")
        if pm is not None:
            need(pm, "PixelSpacing", "Pixel Measures")
            need(pm, "SliceThickness", "Pixel Measures")
        po = seq1(shared, "PlaneOrientationSequence", "Plane Orientation (Patient)")
        if po is not None and has(po, "ImageOrientationPatient"):
            iop = np.array(po.ImageOrientationPatient, float)
            if len(iop) != 6 or abs(np.linalg.norm(iop[:3]) - 1) > 1e-4 or abs(np.linalg.norm(iop[3:]) - 1) > 1e-4 \
                    or abs(iop[:3] @ iop[3:]) > 1e-4:
                fail(f"Image Orientation が単位ベクトルの直交でない: {iop}")
        elif po is not None:
            fail("Image Orientation (Patient) が無い")
        ft = seq1(shared, "ParametricMapFrameTypeSequence", "Parametric Map Frame Type")
        if ft is not None:
            f = vals(ft.get("FrameType"))
            if len(f) != 4 or "MIXED" in f or any(not x for x in f) or f[:2] != ["DERIVED", "PRIMARY"]:
                fail(f"Frame Type が不正（4 値・MIXED 不可・DERIVED\\PRIMARY）: {f}")
        pvt = seq1(shared, "PixelValueTransformationSequence", "Identity Pixel Value Transformation")
        if pvt is not None:
            if float(pvt.get("RescaleIntercept", 1)) != 0 or float(pvt.get("RescaleSlope", 0)) != 1 \
                    or pvt.get("RescaleType") != "US":
                fail("Identity Pixel Value Transformation は 切片 0・傾き 1・US")
        voi = seq1(shared, "FrameVOILUTSequence", "Frame VOI LUT With LUT")
        if voi is not None:
            if not has(voi, "WindowCenter") and not has(voi, "VOILUTSequence"):
                fail("Frame VOI LUT: Window Center も VOI LUT Sequence も無い")
            elif has(voi, "WindowCenter") and not has(voi, "WindowWidth"):
                fail("Frame VOI LUT: Window Width が無い")
        rw = ds_rwvm(shared)
        if rw is not None:
            check_rwvm(rw, ds, has_int)
            if voi is not None and has(voi, "WindowCenter") and has_int and has(rw, "RealWorldValueFirstValueMapped"):
                wc, ww = float(voi.WindowCenter), float(voi.WindowWidth)
                lo, hi = float(rw.RealWorldValueFirstValueMapped), float(rw.RealWorldValueLastValueMapped)
                if not (lo - 1 <= wc <= hi + 1) or ww <= 0 or ww > (hi - lo + 1) * 1.001:
                    fail(f"窓が保存値の領域（{lo:g}〜{hi:g}）に収まらない（実値の窓を書いた疑い）: center={wc:g} width={ww:g}")
    # --- 機能グループ（フレームごと） ---
    if pf is not None:
        pp = seq1(pf, "PlanePositionSequence", "Plane Position (Patient)")
        if pp is not None and (not has(pp, "ImagePositionPatient") or len(pp.ImagePositionPatient) != 3):
            fail("Image Position (Patient) が無い／3 値でない")
        fc = seq1(pf, "FrameContentSequence", "Frame Content")
        if fc is not None and dimidx:
            dv = vals(fc.get("DimensionIndexValues"))
            if len(dv) != len(dimidx):
                fail(f"Dimension Index Values の数 {len(dv)} が Dimension Index Sequence の項目数 {len(dimidx)} と違う")
        di = pf.get("DerivationImageSequence")
        if di is None:
            fail("Derivation Image 機能グループが無い（導出した PM では必須）")
        else:
            for d in di:
                dc = d.get("DerivationCodeSequence")
                if not dc or len(dc) < 1:
                    fail("Derivation Code Sequence が無い（1C: 必須）")
                else:
                    for c in dc:
                        check_code(c, "Derivation Code")
                if "SourceImageSequence" not in d:
                    fail("Source Image Sequence が無い（Type 2）")
                else:
                    for s in d.SourceImageSequence:
                        need(s, "ReferencedSOPClassUID", "Source Image")
                        need(s, "ReferencedSOPInstanceUID", "Source Image")
                        p = s.get("PurposeOfReferenceCodeSequence")
                        if not p or len(p) != 1:
                            fail("Source Image の Purpose of Reference Code Sequence が 1 項目でない（1C: 必須）")
                        else:
                            check_code(p[0], "Purpose of Reference")
            if "ReferencedSeriesSequence" not in ds:
                fail("Common Instance Reference（Referenced Series Sequence）が無い（導出元が同じ Study なら必須）")
            else:
                for r in ds.ReferencedSeriesSequence:
                    need(r, "SeriesInstanceUID", "Referenced Series")
                    if "ReferencedInstanceSequence" not in r or len(r.ReferencedInstanceSequence) < 1:
                        fail("Referenced Instance Sequence が無い")
    # --- 実値（通常の読み方: pixel_array＋RWVM） ---
    if has_int and not FAILS[n0:]:
        real = real_values(ds)
        print(f"  {w}: 実値 n={real.size} 値なし={int(np.isnan(real).sum())} "
              f"min={np.nanmin(real):.6g} max={np.nanmax(real):.6g}")
        if reference is not None:
            slope = float(ds_rwvm(ds.SharedFunctionalGroupsSequence[0]).RealWorldValueSlope)
            ref = reference.reshape(real.shape)
            fin = np.isfinite(ref)
            if np.isnan(real[~fin]).sum() != (~fin).sum():
                fail("参照で非有限の画素が、値なし（NaN）になっていない")
            err = np.abs(real[fin] - ref[fin]).max() if fin.any() else 0.0
            if err > slope / 2 + 1e-6 * max(1.0, abs(slope)):
                fail(f"実値が参照と合わない: 最大誤差 {err:.6g} > 傾きの半分 {slope / 2:.6g}")
            else:
                print(f"  {w}: 参照との最大誤差 {err:.6g}（傾きの半分 {slope / 2:.6g}）")
    return len(FAILS) == n0


def ds_rwvm(grp):
    s = grp.get("RealWorldValueMappingSequence")
    if not s or len(s) < 1:
        fail("Real World Value Mapping 機能グループが無い／空")
        return None
    return s[0]


def check_rwvm(rw, ds, has_int):
    if has_int:
        for kw in ("RealWorldValueFirstValueMapped", "RealWorldValueLastValueMapped"):
            need(rw, kw, "RWVM")
        if has(rw, "DoubleFloatRealWorldValueFirstValueMapped"):
            fail("RWVM: 整数画素では Double Float First/Last を使わない（First/Last Value Mapped を使う）")
        f, l = rw.get("RealWorldValueFirstValueMapped"), rw.get("RealWorldValueLastValueMapped")
        if f is not None and l is not None:
            hi = 2 ** int(ds.get("BitsStored", 16)) - 1
            if not (0 <= f <= l <= hi) and ds.get("PixelRepresentation") == 0:
                fail(f"RWVM の範囲 {f}〜{l} が保存値の範囲 0〜{hi} に収まらない")
            if rw["RealWorldValueFirstValueMapped"].VR not in ("US", "SS"):
                fail(f"First Value Mapped の VR が US/SS でない（{rw['RealWorldValueFirstValueMapped'].VR}）")
            elif (rw["RealWorldValueFirstValueMapped"].VR == "US") != (ds.get("PixelRepresentation") == 0):
                fail("First/Last Value Mapped の VR が Pixel Representation と合わない")
    if not has(rw, "RealWorldValueLUTData"):
        need(rw, "RealWorldValueSlope", "RWVM")
        need(rw, "RealWorldValueIntercept", "RWVM")
    lab = need(rw, "LUTLabel", "RWVM")
    if lab is not None and len(lab) > 16:
        fail(f"LUT Label は SH（16 桁まで）: {lab!r}")
    expl = need(rw, "LUTExplanation", "RWVM")
    if expl is not None and len(expl) > 64:
        fail("LUT Explanation は LO（64 桁まで）")
    mu = seq1(rw, "MeasurementUnitsCodeSequence", "RWVM")
    if mu is not None:
        check_code(mu, "Measurement Units")


def real_values(ds):
    """pydicom の通常の読み方。範囲の外（First〜Last の外）は NaN、ほかは 傾き×画素＋切片。"""
    arr = ds.pixel_array.astype(np.float64)
    rw = ds.SharedFunctionalGroupsSequence[0].RealWorldValueMappingSequence[0]
    first, last = rw.RealWorldValueFirstValueMapped, rw.RealWorldValueLastValueMapped
    out = float(rw.RealWorldValueSlope) * arr + float(rw.RealWorldValueIntercept)
    out[(arr < first) | (arr > last)] = np.nan
    return out


def main(argv):
    ref = None
    args = argv[1:]
    if args[:1] == ["--reference"]:
        ref = np.load(args[1])
        args = args[2:]
    if not args:
        print(__doc__)
        return 2
    ok_all = True
    for i, p in enumerate(args):
        try:
            ok = check(p, ref if i == 0 else None)
        except Exception as e:  # 読めない
            print(f"読めない: {p}: {e}")
            return 2
        print(("合格 " if ok else "不適合 ") + p)
        ok_all &= ok
    for f in FAILS:
        print("  FAIL:", f)
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

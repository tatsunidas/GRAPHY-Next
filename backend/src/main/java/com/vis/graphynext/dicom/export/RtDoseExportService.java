/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;

/**
 * 線量分布 → DICOM RT Dose（RT Dose Storage）書き出し（host API の H23）。
 *
 * <p>本体にはこれまで RTDOSE の書き出しが無かった（{@code dicom/dose/} は RDSR ＝ X 線被曝線量で、
 * 内部被曝の吸収線量とは別物）。参照シリーズから患者・検査・FrameOfReference を引き継ぎ、
 * 多フレーム（{@code GridFrameOffsetVector}）の uint16 ＋ {@code DoseGridScaling} で書く。
 *
 * <h3>🔴 準拠していない点を黙って作らない</h3>
 *
 * <p>RT Dose モジュールの {@code ReferencedRTPlanSequence} は Type 1C で、
 * {@code DoseSummationType} が {@code PLAN} 等なら必須である。しかし
 * <b>核医学の線量評価に RT Plan は存在しない</b>。ここで空の Plan 参照や作り話の UID を書くと、
 * 受け側は「在るはずの計画」を辿って失敗する。本体は<b>書かない</b>かわりに
 * {@link Result#warnings()} に理由を載せ、呼び出し側（確認ダイアログ）が
 * <b>ユーザーに見せてから</b>保存する。準拠していないことを、知らせずに作らない。
 */
@Service
public class RtDoseExportService {

    private static final Logger log = LoggerFactory.getLogger(RtDoseExportService.class);

    /** プラグイン出力の SeriesDescription 接頭辞（派生シリーズ・SEG と揃える）。 */
    static final String PLUGIN_PREFIX = "[Plugin] ";

    /** DICOM の列挙値（PS3.3 RT Dose モジュール）。 */
    private static final Set<String> DOSE_UNITS = Set.of("GY", "RELATIVE");
    private static final Set<String> DOSE_TYPES = Set.of("PHYSICAL", "EFFECTIVE", "ERROR");
    private static final Set<String> SUMMATION_TYPES = Set.of(
            "PLAN", "MULTI_PLAN", "PLAN_OVERVIEW", "FRACTION", "BEAM", "BRACHY",
            "FRACTION_SESSION", "BEAM_SESSION", "BRACHY_SESSION", "CONTROL_POINT", "RECORD");
    private static final Set<String> HETEROGENEITY = Set.of("IMAGE", "ROI_OVERRIDE", "WATER");

    private final DicomStorageService storage;
    /** web モードのときだけ存在（STOW-RS 書き戻し用）。standalone では null。 */
    private final ObjectProvider<WebDicomDataService> webProvider;

    public RtDoseExportService(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    /**
     * 生成結果。
     *
     * @param warnings 出力はしたが DICOM の要求を満たしていない点（呼び出し側がユーザーに見せる）
     */
    public record Result(String seriesInstanceUid, String sopInstanceUid, List<String> warnings) {}

    public Result export(RtDoseExportRequest req) throws IOException {
        validate(req);

        WebDicomDataService web = webProvider != null ? webProvider.getIfAvailable() : null;
        Attributes tmpl = template(req, web);

        int frames = req.gridFrameOffsetVector().length;
        byte[] px = Base64.getDecoder().decode(req.pixels());
        int expected = req.rows() * req.columns() * frames * 2;
        if (px.length != expected) {
            throw new IllegalArgumentException("画素バイト長が rows*columns*frames*2 と一致しません"
                    + " (got=" + px.length + ", expected=" + expected + ")");
        }

        List<String> warnings = new ArrayList<>();
        Attributes a = build(tmpl, req, px, warnings);

        if (web != null) {
            web.storeDatasets(List.of(a));
        } else {
            ingest(a);
        }
        log.info("RTDOSE created: series={} sop={} frames={} scaling={} [{}]",
                a.getString(Tag.SeriesInstanceUID), a.getString(Tag.SOPInstanceUID), frames,
                req.doseGridScaling(), web != null ? "STOW-RS" : "local");
        return new Result(a.getString(Tag.SeriesInstanceUID), a.getString(Tag.SOPInstanceUID), warnings);
    }

    // ------------------------------------------------------------------
    // 構築（保管庫から切り離してある＝テストしやすさ）
    // ------------------------------------------------------------------

    /** RTDOSE の Attributes を組み立てる。{@code tmpl} は参照シリーズの代表インスタンスのヘッダ。 */
    Attributes build(Attributes tmpl, RtDoseExportRequest req, byte[] px, List<String> warnings) {
        Attributes a = new Attributes();

        // 患者・検査は参照シリーズから引き継ぐ（別患者の線量を作らないための単一の出所）。
        for (int tag : new int[] {
                Tag.SpecificCharacterSet,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
                Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
        }) {
            copyTag(tmpl, a, tag);
        }
        if (a.getString(Tag.SpecificCharacterSet) == null) {
            a.setSpecificCharacterSet("ISO_IR 192");
        }
        if (a.getString(Tag.StudyInstanceUID) == null) {
            a.setString(Tag.StudyInstanceUID, VR.UI, req.studyInstanceUid());
        }

        a.setString(Tag.SOPClassUID, VR.UI, UID.RTDoseStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.Modality, VR.CS, "RTDOSE");
        a.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.SeriesNumber, VR.IS,
                req.seriesNumber() != null ? req.seriesNumber() : tmpl.getInt(Tag.SeriesNumber, 0) + 6000);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        a.setString(Tag.SeriesDescription, VR.LO, seriesDescription(req));
        a.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next");
        copyTag(tmpl, a, Tag.ContentDate);
        copyTag(tmpl, a, Tag.ContentTime);

        // ★ 空間基準は参照シリーズから引き継ぐ（呼び出し側に書かせない）。
        //   ここを自由にすると「別の座標系の線量を、同じ座標系だ」と偽れてしまう。
        String forUid = tmpl.getString(Tag.FrameOfReferenceUID);
        if (forUid != null && !forUid.isBlank()) {
            a.setString(Tag.FrameOfReferenceUID, VR.UI, forUid);
            copyTag(tmpl, a, Tag.PositionReferenceIndicator);
        } else {
            // FoR が無い参照シリーズ（幾何を持たない派生など）に線量を紐付けても、
            // 受け側は重ねようがない。**黙って空で出さない**。
            warnings.add("参照シリーズに FrameOfReferenceUID がありません"
                    + "（他システムは画像へ重ねられません）");
        }

        // --- 画素（多フレーム uint16 ＋ DoseGridScaling）---
        a.setInt(Tag.Rows, VR.US, req.rows());
        a.setInt(Tag.Columns, VR.US, req.columns());
        a.setInt(Tag.NumberOfFrames, VR.IS, req.gridFrameOffsetVector().length);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        // 線量は非負なので unsigned。負値が要る使い方（誤差マップ）は DoseType=ERROR で
        // 別途設計する（今の呼び出し側には無い）。
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        // フレームの並びが何で増えるかを明示する（RTDOSE は GridFrameOffsetVector）。
        a.setInt(Tag.FrameIncrementPointer, VR.AT, Tag.GridFrameOffsetVector);
        a.setBytes(Tag.PixelData, VR.OW, px);

        // --- 幾何 ---
        a.setDouble(Tag.ImageOrientationPatient, VR.DS, req.imageOrientationPatient());
        a.setDouble(Tag.ImagePositionPatient, VR.DS, req.imagePositionPatient());
        a.setDouble(Tag.PixelSpacing, VR.DS, req.pixelSpacing());
        a.setDouble(Tag.GridFrameOffsetVector, VR.DS, req.gridFrameOffsetVector());

        // --- 線量そのもの ---
        a.setString(Tag.DoseUnits, VR.CS, req.doseUnits().toUpperCase());
        a.setString(Tag.DoseType, VR.CS, req.doseType().toUpperCase());
        a.setString(Tag.DoseSummationType, VR.CS, req.doseSummationType().toUpperCase());
        a.setDouble(Tag.DoseGridScaling, VR.DS, req.doseGridScaling());
        if (req.tissueHeterogeneityCorrection() != null && !req.tissueHeterogeneityCorrection().isBlank()) {
            a.setString(Tag.TissueHeterogeneityCorrection, VR.CS,
                    req.tissueHeterogeneityCorrection().toUpperCase());
        }
        if (req.doseComment() != null && !req.doseComment().isBlank()) {
            a.setString(Tag.DoseComment, VR.LO, req.doseComment());
        }

        // --- 参照 RT Plan（Type 1C。無いなら書かずに警告する）---
        RtDoseExportRequest.ReferencedRtPlan plan = req.referencedRtPlan();
        if (plan != null && plan.sopInstanceUid() != null && !plan.sopInstanceUid().isBlank()) {
            Attributes ref = new Attributes(2);
            ref.setString(Tag.ReferencedSOPClassUID, VR.UI,
                    plan.sopClassUid() != null && !plan.sopClassUid().isBlank()
                            ? plan.sopClassUid() : UID.RTPlanStorage);
            ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, plan.sopInstanceUid());
            a.newSequence(Tag.ReferencedRTPlanSequence, 1).add(ref);
        } else {
            warnings.add("ReferencedRTPlanSequence (Type 1C) を書いていません"
                    + "（放射性医薬品の線量評価に RT Plan は存在しないため）。"
                    + "受け側の実装によっては読み込めないことがあります。");
        }

        // --- 由来（どの画像から作った線量か）---
        List<String> srcSops = req.referencedSopInstanceUids();
        if (srcSops != null && !srcSops.isEmpty()) {
            String srcSopClass = tmpl.getString(Tag.SOPClassUID);
            Sequence seq = a.newSequence(Tag.SourceImageSequence, srcSops.size());
            for (String sop : srcSops) {
                if (sop == null || sop.isBlank()) {
                    continue;
                }
                Attributes ref = new Attributes(2);
                ref.setString(Tag.ReferencedSOPClassUID, VR.UI,
                        srcSopClass != null ? srcSopClass : UID.SecondaryCaptureImageStorage);
                ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sop);
                seq.add(ref);
            }
        }

        // プラグイン出力は機械可読な出所も残す（一覧の接頭辞と二重に明示する）。
        RtDoseExportRequest.Producer p = req.producer();
        if (p != null) {
            Attributes eq = new Attributes(4);
            eq.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next plugin");
            eq.setString(Tag.ManufacturerModelName, VR.LO,
                    p.name() != null && !p.name().isBlank() ? p.name() : p.id());
            eq.setString(Tag.SoftwareVersions, VR.LO, p.version() != null ? p.version() : "");
            eq.setString(Tag.ContributionDescription, VR.ST, "RT Dose produced by plugin " + p.id());
            a.newSequence(Tag.ContributingEquipmentSequence, 1).add(eq);
        }
        return a;
    }

    private String seriesDescription(RtDoseExportRequest req) {
        String desc = req.seriesDescription() != null && !req.seriesDescription().isBlank()
                ? req.seriesDescription() : "RT Dose";
        if (req.producer() == null) {
            return desc.length() <= 64 ? desc : desc.substring(0, 64);
        }
        String out = PLUGIN_PREFIX + desc;
        return out.length() <= 64 ? out : out.substring(0, 64);
    }

    private void validate(RtDoseExportRequest req) {
        if (req == null || req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.seriesInstanceUid() == null || req.seriesInstanceUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / seriesInstanceUid は必須です");
        }
        if (req.rows() <= 0 || req.columns() <= 0) {
            throw new IllegalArgumentException("rows / columns が不正です");
        }
        if (req.imageOrientationPatient() == null || req.imageOrientationPatient().length != 6) {
            throw new IllegalArgumentException("imageOrientationPatient は 6 要素必要です");
        }
        if (req.imagePositionPatient() == null || req.imagePositionPatient().length != 3) {
            throw new IllegalArgumentException("imagePositionPatient は 3 要素必要です");
        }
        if (req.pixelSpacing() == null || req.pixelSpacing().length != 2
                || req.pixelSpacing()[0] <= 0 || req.pixelSpacing()[1] <= 0) {
            throw new IllegalArgumentException("pixelSpacing が不正です");
        }
        double[] gfov = req.gridFrameOffsetVector();
        if (gfov == null || gfov.length == 0) {
            throw new IllegalArgumentException("gridFrameOffsetVector が空です");
        }
        // ★ 先頭を 0 にしない実装が実在する（IPP と二重にオフセットが掛かって線量が
        //   1 スライスぶんずれる）。ここで落として気付かせる。
        if (Math.abs(gfov[0]) > 1e-6) {
            throw new IllegalArgumentException(
                    "gridFrameOffsetVector の先頭は 0 でなければなりません（先頭フレームの位置は"
                    + " imagePositionPatient が表すため）: " + gfov[0]);
        }
        for (int i = 1; i < gfov.length; i++) {
            if (!Double.isFinite(gfov[i])) {
                throw new IllegalArgumentException("gridFrameOffsetVector に有限でない値があります");
            }
        }
        if (req.pixels() == null || req.pixels().isBlank()) {
            throw new IllegalArgumentException("pixels が空です");
        }
        if (!(req.doseGridScaling() > 0) || !Double.isFinite(req.doseGridScaling())) {
            // 0 や負の係数は「格納値をそのまま線量として読む」実装で静かに全域 0 の線量になる。
            throw new IllegalArgumentException("doseGridScaling は正の有限値である必要があります: "
                    + req.doseGridScaling());
        }
        requireEnum("doseUnits", req.doseUnits(), DOSE_UNITS);
        requireEnum("doseType", req.doseType(), DOSE_TYPES);
        requireEnum("doseSummationType", req.doseSummationType(), SUMMATION_TYPES);
        if (req.tissueHeterogeneityCorrection() != null && !req.tissueHeterogeneityCorrection().isBlank()) {
            requireEnum("tissueHeterogeneityCorrection", req.tissueHeterogeneityCorrection(), HETEROGENEITY);
        }
    }

    private static void requireEnum(String name, String value, Set<String> allowed) {
        if (value == null || !allowed.contains(value.toUpperCase())) {
            throw new IllegalArgumentException(name + " が DICOM の列挙値ではありません: " + value
                    + "（" + String.join(" / ", allowed.stream().sorted().toList()) + "）");
        }
    }

    /** 参照シリーズの代表インスタンスのヘッダ（standalone はローカル、web は WADO-RS）。 */
    private Attributes template(RtDoseExportRequest req, WebDicomDataService web) throws IOException {
        if (web != null) {
            List<Attributes> metas = web.seriesMetadata(req.studyInstanceUid(), req.seriesInstanceUid());
            if (metas.isEmpty()) {
                throw new IllegalArgumentException("参照シリーズが見つかりません (web, study="
                        + req.studyInstanceUid() + ", series=" + req.seriesInstanceUid() + ")");
            }
            return metas.get(0);
        }
        List<Path> files = storage.resolveFiles(req.studyInstanceUid(), List.of(req.seriesInstanceUid()));
        if (files.isEmpty()) {
            throw new IllegalArgumentException("参照シリーズが見つかりません (study=" + req.studyInstanceUid()
                    + ", series=" + req.seriesInstanceUid() + ")");
        }
        try (DicomInputStream in = new DicomInputStream(files.get(0).toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    private static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) {
            return;
        }
        VR vr = from.getVR(tag);
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) {
            to.setString(tag, vr, v);
        }
    }

    /** Part-10 一時ファイルに書き出してから保管庫へ取り込む。 */
    private void ingest(Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("rtdose-", ".dcm");
        boolean consumed = false;
        try {
            Attributes fmi = attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, attrs);
            }
            storage.ingest(tmp);
            consumed = true;
        } finally {
            if (!consumed) {
                Files.deleteIfExists(tmp);
            }
        }
    }
}

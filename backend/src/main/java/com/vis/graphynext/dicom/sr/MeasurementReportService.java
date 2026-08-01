/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import com.vis.graphynext.dicom.store.DicomStorageService;
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
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 計測レポート（DICOM SR）の生成・保存。
 *
 * <p><b>何を作るか</b>: TID 1500（Imaging Measurement Report）の形に沿った Comprehensive SR。
 * 病変ごとに Measurement Group を作り、**Tracking Identifier / Tracking Unique Identifier** と
 * 長径・短径、計測した画像への参照を入れる。時系列の判定（RECIST の効果判定など）は
 * 所見テキストとして同じ文書に入れる。
 *
 * <p><b>正直に言う制限</b>:
 * <ul>
 *   <li><b>TID 1500 完全準拠は主張しない。</b> 構造は TID 1500 に沿えているが、
 *       テンプレート識別（ContentTemplateSequence）を付けたうえでの完全な検証
 *       （dciodvfy 等）は通していない。相互運用の主眼は「計測値と追跡 ID が機械可読に残ること」。</li>
 *   <li><b>効果判定（CR/PR/SD/PD）はコード化していない</b>（自由文の所見として入れる）。
 *       手元に PS3.16 の該当 CID を確認できていないため、**確認できないコードを書かない**。
 *       誤ったコード値は、正しい値が無いことより有害である。</li>
 *   <li>長径・短径のコードは実務で広く使われている SRT の {@code G-A185 / G-A186} を使う
 *       （dcmjs / OHIF と同じ）。</li>
 * </ul>
 */
@Service
public class MeasurementReportService {

    private static final Logger log = LoggerFactory.getLogger(MeasurementReportService.class);

    /** プラグイン出力の SeriesDescription 接頭辞（派生シリーズと揃える）。 */
    static final String PLUGIN_PREFIX = "[Plugin] ";

    /** 対応する計測種別（これ以外は拒否する。知らない種別を無言で落とさない）。 */
    static final String LONG_AXIS = "longAxis";
    static final String SHORT_AXIS = "shortAxis";

    private static final DateTimeFormatter DA = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("HHmmss");

    private final DicomStorageService storage;

    public MeasurementReportService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** 生成結果。 */
    public record Result(String seriesInstanceUid, String sopInstanceUid) {}

    public Result create(MeasurementReportRequest req) throws IOException {
        validate(req);

        List<Path> files = storage.resolveFiles(req.studyInstanceUid(), null);
        if (files.isEmpty()) {
            throw new IllegalArgumentException("スタディが見つかりません: " + req.studyInstanceUid());
        }
        Attributes tmpl = readHeader(files.get(0));

        Attributes sr = build(tmpl, req, LocalDateTime.now());
        ingest(sr);
        log.info("SR created: study={} series={} sop={} groups={} findings={}",
                req.studyInstanceUid(),
                sr.getString(Tag.SeriesInstanceUID),
                sr.getString(Tag.SOPInstanceUID),
                req.groups() == null ? 0 : req.groups().size(),
                req.findings() == null ? 0 : req.findings().size());
        return new Result(sr.getString(Tag.SeriesInstanceUID), sr.getString(Tag.SOPInstanceUID));
    }

    // ------------------------------------------------------------------
    // 構築（テストしやすいよう保管庫から切り離してある）
    // ------------------------------------------------------------------

    /** SR の Attributes を組み立てる。{@code tmpl} は同じスタディの代表インスタンスのヘッダ。 */
    Attributes build(Attributes tmpl, MeasurementReportRequest req, LocalDateTime now) {
        Attributes a = new Attributes();

        // 患者・検査は元スタディから引き継ぐ（別患者の SR を作らないための単一の出所）。
        int[] inherit = {
                Tag.SpecificCharacterSet,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
                Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
        };
        for (int tag : inherit) {
            copyTag(tmpl, a, tag);
        }
        if (a.getString(Tag.SpecificCharacterSet) == null) {
            a.setSpecificCharacterSet("ISO_IR 192");
        }
        if (a.getString(Tag.StudyInstanceUID) == null) {
            a.setString(Tag.StudyInstanceUID, VR.UI, req.studyInstanceUid());
        }

        a.setString(Tag.Modality, VR.CS, "SR");
        a.setString(Tag.SOPClassUID, VR.UI, UID.ComprehensiveSRStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.SeriesNumber, VR.IS, 9000);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        a.setString(Tag.SeriesDescription, VR.LO, seriesDescription(req));
        a.setString(Tag.ContentDate, VR.DA, now.format(DA));
        a.setString(Tag.ContentTime, VR.TM, now.format(TM));
        a.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next");

        // 文書としての状態。**未検証（UNVERIFIED）**として出す。読影医の確認行為を
        // アプリが勝手に「検証済み」と記録してはいけない。
        a.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");
        a.setString(Tag.VerificationFlag, VR.CS, "UNVERIFIED");

        MeasurementReportRequest.Producer p = req.producer();
        if (p != null) {
            Attributes eq = new Attributes(4);
            eq.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next plugin");
            eq.setString(Tag.ManufacturerModelName, VR.LO,
                    p.name() != null && !p.name().isBlank() ? p.name() : p.id());
            eq.setString(Tag.SoftwareVersions, VR.LO, p.version() != null ? p.version() : "");
            eq.setString(Tag.ContributionDescription, VR.ST, "Measurement report produced by plugin " + p.id());
            a.newSequence(Tag.ContributingEquipmentSequence, 1).add(eq);
        }

        // 参照している画像（Current Requested Procedure Evidence Sequence）。
        // これが無いと、SR を受け取った側が元画像へ辿れない。
        addEvidence(a, req);

        // --- 内容ツリー（root は CONTAINER） ---
        a.setString(Tag.ValueType, VR.CS, "CONTAINER");
        a.newSequence(Tag.ConceptNameCodeSequence, 1)
                .add(code("126000", "DCM", "Imaging Measurement Report"));
        a.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");

        Sequence content = a.newSequence(Tag.ContentSequence, 8);

        // 言語（TID 1204）。
        Attributes lang = item("HAS CONCEPT MOD", "CODE",
                code("121049", "DCM", "Language of Content Item and Descendants"));
        lang.newSequence(Tag.ConceptCodeSequence, 1).add(code("eng", "RFC5646", "English"));
        content.add(lang);

        // 観測者（任意）。
        if (req.observerName() != null && !req.observerName().isBlank()) {
            Attributes obs = item("HAS OBS CONTEXT", "PNAME", code("121008", "DCM", "Person Observer Name"));
            obs.setString(Tag.PersonName, VR.PN, req.observerName().trim());
            content.add(obs);
        }

        // 文書タイトル（自由文）。TID 1500 のタイトルは概念名で表すが、
        // 人が一覧で見分けられるよう本文にも残す。
        String title = req.documentTitle() != null && !req.documentTitle().isBlank()
                ? req.documentTitle().trim()
                : "Imaging Measurement Report";
        content.add(text(code("121106", "DCM", "Comment"), title));

        // 画像ライブラリ（TID 1600）。
        content.add(imageLibrary(req));

        // 計測（TID 1500 の Imaging Measurements）。
        content.add(imagingMeasurements(req));

        // 所見（経時判定のまとめ等）。
        if (req.findings() != null && !req.findings().isEmpty()) {
            Attributes findings = container(code("121070", "DCM", "Findings"));
            Sequence fs = findings.newSequence(Tag.ContentSequence, req.findings().size());
            for (MeasurementReportRequest.Finding f : req.findings()) {
                if (f == null || f.text() == null || f.text().isBlank()) {
                    continue;
                }
                String label = f.label() == null || f.label().isBlank() ? "" : f.label().trim() + ": ";
                fs.add(text(code("121106", "DCM", "Comment"), label + f.text().trim()));
            }
            content.add(findings);
        }

        return a;
    }

    /** 画像ライブラリ。計測が参照する画像を 1 か所に列挙する。 */
    private Attributes imageLibrary(MeasurementReportRequest req) {
        Attributes lib = container(code("111028", "DCM", "Image Library"));
        Sequence libSeq = lib.newSequence(Tag.ContentSequence, 1);
        Attributes group = container(code("126200", "DCM", "Image Library Group"));
        Sequence images = group.newSequence(Tag.ContentSequence, 4);
        for (String sop : referencedSops(req)) {
            images.add(imageItem("CONTAINS", sop));
        }
        libSeq.add(group);
        return lib;
    }

    /** 計測本体。病変ごとに Measurement Group を作る。 */
    private Attributes imagingMeasurements(MeasurementReportRequest req) {
        Attributes measurements = container(code("126010", "DCM", "Imaging Measurements"));
        Sequence groups = measurements.newSequence(Tag.ContentSequence,
                req.groups() == null ? 0 : req.groups().size());
        if (req.groups() == null) {
            return measurements;
        }
        for (MeasurementReportRequest.MeasurementGroup g : req.groups()) {
            Attributes group = container(code("125007", "DCM", "Measurement Group"));
            Sequence gs = group.newSequence(Tag.ContentSequence, 6);

            // 追跡 ID / 追跡 UID。**時系列で同じ病変を結ぶ鍵**なので必ず入れる。
            gs.add(text2("HAS OBS CONTEXT", code("112039", "DCM", "Tracking Identifier"), g.trackingId()));
            String uid = g.trackingUid() != null && !g.trackingUid().isBlank()
                    ? g.trackingUid()
                    : UIDUtils.createUID();
            Attributes tuid = item("HAS OBS CONTEXT", "UIDREF", code("112040", "DCM", "Tracking Unique Identifier"));
            tuid.setString(Tag.UID, VR.UI, uid);
            gs.add(tuid);

            if (g.findingText() != null && !g.findingText().isBlank()) {
                gs.add(text(code("121071", "DCM", "Finding"), g.findingText().trim()));
            }

            // 計測した画像（この計測がどの画像に由来するか）。
            if (g.sopInstanceUid() != null && !g.sopInstanceUid().isBlank()) {
                Attributes src = imageItem("CONTAINS", g.sopInstanceUid());
                src.newSequence(Tag.ConceptNameCodeSequence, 1)
                        .add(code("121112", "DCM", "Source of Measurement"));
                gs.add(src);
            }

            for (MeasurementReportRequest.Measurement m : g.measurements()) {
                gs.add(num(m));
            }
            groups.add(group);
        }
        return measurements;
    }

    /** 数値計測 1 個（NUM）。 */
    private Attributes num(MeasurementReportRequest.Measurement m) {
        Attributes n = item("CONTAINS", "NUM", measurementCode(m.type()));
        Attributes measured = new Attributes(2);
        measured.setString(Tag.NumericValue, VR.DS, trimNumber(m.value()));
        measured.newSequence(Tag.MeasurementUnitsCodeSequence, 1)
                .add(code(unitOf(m), "UCUM", unitOf(m)));
        n.newSequence(Tag.MeasuredValueSequence, 1).add(measured);
        return n;
    }

    private static String unitOf(MeasurementReportRequest.Measurement m) {
        return m.unit() == null || m.unit().isBlank() ? "mm" : m.unit().trim();
    }

    /**
     * 計測種別のコード。**実務で広く使われている SRT のコード**を使う（dcmjs / OHIF と同じ）。
     * 受け側の実装がこの値で長径・短径を判別しているため、ここを独自コードにすると読めなくなる。
     */
    private static Attributes measurementCode(String type) {
        return switch (type) {
            case LONG_AXIS -> code("G-A185", "SRT", "Long Axis");
            case SHORT_AXIS -> code("G-A186", "SRT", "Short Axis");
            // validate() で弾いているのでここには来ない。
            default -> throw new IllegalArgumentException("未知の計測種別: " + type);
        };
    }

    /** 参照している SOP Instance UID を重複なく集める（列挙順は入力順）。 */
    private static Set<String> referencedSops(MeasurementReportRequest req) {
        Set<String> out = new LinkedHashSet<>();
        if (req.groups() == null) {
            return out;
        }
        for (MeasurementReportRequest.MeasurementGroup g : req.groups()) {
            if (g.sopInstanceUid() != null && !g.sopInstanceUid().isBlank()) {
                out.add(g.sopInstanceUid());
            }
        }
        return out;
    }

    /**
     * 参照画像の証跡（Current Requested Procedure Evidence Sequence）。
     * SR だけを受け取った側が、元のスタディ/シリーズ/インスタンスへ辿れるようにする。
     */
    private void addEvidence(Attributes a, MeasurementReportRequest req) {
        if (req.groups() == null || req.groups().isEmpty()) {
            return;
        }
        // series UID → SOP UID の集合。
        java.util.Map<String, Set<String>> bySeries = new java.util.LinkedHashMap<>();
        for (MeasurementReportRequest.MeasurementGroup g : req.groups()) {
            if (g.seriesInstanceUid() == null || g.seriesInstanceUid().isBlank()
                    || g.sopInstanceUid() == null || g.sopInstanceUid().isBlank()) {
                continue;
            }
            bySeries.computeIfAbsent(g.seriesInstanceUid(), k -> new LinkedHashSet<>()).add(g.sopInstanceUid());
        }
        if (bySeries.isEmpty()) {
            return;
        }
        Attributes study = new Attributes(2);
        study.setString(Tag.StudyInstanceUID, VR.UI, req.studyInstanceUid());
        Sequence seriesSeq = study.newSequence(Tag.ReferencedSeriesSequence, bySeries.size());
        for (var e : bySeries.entrySet()) {
            Attributes series = new Attributes(2);
            series.setString(Tag.SeriesInstanceUID, VR.UI, e.getKey());
            Sequence sops = series.newSequence(Tag.ReferencedSOPSequence, e.getValue().size());
            for (String sop : e.getValue()) {
                Attributes ref = new Attributes(2);
                // 元画像の SOP Class は分からないので、参照は Instance UID を主にする。
                // （受け側は Study/Series/Instance で取得できる）
                ref.setString(Tag.ReferencedSOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
                ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sop);
                sops.add(ref);
            }
            seriesSeq.add(series);
        }
        a.newSequence(Tag.CurrentRequestedProcedureEvidenceSequence, 1).add(study);
    }

    // ------------------------------------------------------------------
    // 小道具
    // ------------------------------------------------------------------

    private static Attributes code(String value, String scheme, String meaning) {
        Attributes c = new Attributes(3);
        c.setString(Tag.CodeValue, VR.SH, value);
        c.setString(Tag.CodingSchemeDesignator, VR.SH, scheme);
        c.setString(Tag.CodeMeaning, VR.LO, meaning);
        return c;
    }

    private static Attributes item(String relationship, String valueType, Attributes conceptName) {
        Attributes i = new Attributes(6);
        i.setString(Tag.RelationshipType, VR.CS, relationship);
        i.setString(Tag.ValueType, VR.CS, valueType);
        if (conceptName != null) {
            i.newSequence(Tag.ConceptNameCodeSequence, 1).add(conceptName);
        }
        return i;
    }

    private static Attributes container(Attributes conceptName) {
        Attributes c = item("CONTAINS", "CONTAINER", conceptName);
        c.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        return c;
    }

    private static Attributes text(Attributes conceptName, String value) {
        return text2("CONTAINS", conceptName, value);
    }

    private static Attributes text2(String relationship, Attributes conceptName, String value) {
        Attributes t = item(relationship, "TEXT", conceptName);
        t.setString(Tag.TextValue, VR.UT, value == null ? "" : value);
        return t;
    }

    private static Attributes imageItem(String relationship, String sopInstanceUid) {
        Attributes img = item(relationship, "IMAGE", null);
        Attributes ref = new Attributes(2);
        ref.setString(Tag.ReferencedSOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sopInstanceUid);
        img.newSequence(Tag.ReferencedSOPSequence, 1).add(ref);
        return img;
    }

    /** 数値を DS（16 文字）に収める。桁あふれで保存が壊れないようにする。 */
    static String trimNumber(double v) {
        String s = String.format("%.4f", v);
        // 末尾 0 を落とす（"76.0000" → "76"）。
        if (s.contains(".")) {
            s = s.replaceAll("0+$", "").replaceAll("\\.$", "");
        }
        return s.length() <= 16 ? s : s.substring(0, 16);
    }

    static String seriesDescription(MeasurementReportRequest req) {
        String desc = req.seriesDescription() != null && !req.seriesDescription().isBlank()
                ? req.seriesDescription().trim()
                : "Measurement Report";
        if (req.producer() == null || desc.startsWith(PLUGIN_PREFIX)) {
            return desc;
        }
        String out = PLUGIN_PREFIX + desc;
        return out.length() <= 64 ? out : out.substring(0, 64);
    }

    private void validate(MeasurementReportRequest req) {
        if (req == null || req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid は必須です");
        }
        boolean noGroups = req.groups() == null || req.groups().isEmpty();
        boolean noFindings = req.findings() == null || req.findings().isEmpty();
        if (noGroups && noFindings) {
            // 中身の無い SR を保管庫に増やさない。
            throw new IllegalArgumentException("groups か findings のどちらかは必要です");
        }
        if (req.groups() != null) {
            for (MeasurementReportRequest.MeasurementGroup g : req.groups()) {
                if (g.trackingId() == null || g.trackingId().isBlank()) {
                    throw new IllegalArgumentException("trackingId は必須です（時系列で病変を結ぶ鍵）");
                }
                if (g.measurements() == null || g.measurements().isEmpty()) {
                    throw new IllegalArgumentException("計測が空のグループがあります: " + g.trackingId());
                }
                for (MeasurementReportRequest.Measurement m : g.measurements()) {
                    if (m.type() == null || !(LONG_AXIS.equals(m.type()) || SHORT_AXIS.equals(m.type()))) {
                        // **知らない種別を黙って落とさない。** 落とすと「入れたはずの計測が無い」SR ができる。
                        throw new IllegalArgumentException("未知の計測種別: " + m.type());
                    }
                    if (m.value() == null || !Double.isFinite(m.value()) || m.value() < 0) {
                        throw new IllegalArgumentException("計測値が不正です: " + m.value());
                    }
                }
            }
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

    private Attributes readHeader(Path p) throws IOException {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    /** Part-10 一時ファイルに書き出してから保管庫へ取り込む。 */
    private void ingest(Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("sr-", ".dcm");
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

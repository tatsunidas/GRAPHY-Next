/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 動画の<b>フレームごとの値</b>を持つ DICOM SR（Comprehensive SR）を組み立て・読む（H48 / H49）。
 *
 * <h3>何を入れるか</h3>
 * プラグインが動画の各フレームについて出した数値の列（例: UVS の色画素比 CPR・平均絶対差 MAD）。
 * 数値は解析のやり直しに使う値なので、<b>丸めずに</b> {@code FloatingPointValue}（FD）にも入れる
 * （{@code NumericValue} は DS＝16 文字までで桁が落ちる。閾値 0.5 付近の比較が変わりうる）。
 *
 * <h3>構成</h3>
 * <pre>
 * CONTAINER  Per-frame values（根）
 *   ├ HAS CONCEPT MOD  Language = English
 *   ├ CONTAINS IMAGE   対象の動画（SOP）
 *   ├ CONTAINS TEXT    Producer plugin = プラグイン id
 *   ├ CONTAINS TEXT    Parameter = "key=value"（0 個以上）
 *   └ CONTAINS CONTAINER  系列（コード = 系列の key、意味 = 表示名）…系列ごと
 *        ├ CONTAINS TEXT  Frames in order = "1-N"
 *        └ CONTAINS NUM × N（フレーム 1〜N の順）
 * </pre>
 * コードは私用スキーム {@value #SCHEME}（本体の計測概念 99GRAPHY とは分ける。系列の key はプラグインが決めるため）。
 *
 * <p>🔴 <b>DICOM はプラグインに書かせない</b>（H4b / H9 と同じ方針）。プラグインが渡すのは数値の列と
 * 名前だけで、構造・UID・患者/検査の継承・出所（{@code [Plugin] }・ContributingEquipment）は本体が入れる。
 */
public final class FrameValuesSr {

    private FrameValuesSr() {
    }

    static final String SCHEME = "99GRAPHY-PLUGIN";
    static final String SCHEME_UID = VideoProbe.uidFrom("graphy-next/coding-scheme", SCHEME);
    static final String PLUGIN_PREFIX = "[Plugin] ";
    /** 系列の key（= CodeValue。SH は 16 文字まで）。 */
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_]{1,16}");
    private static final DateTimeFormatter DA = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("HHmmss");

    /** 1 系列（フレーム 1〜N の順の値）。{@code unit} は UCUM（無次元は "1"）。 */
    public record Series(String key, String label, String unit, List<Double> values) {
    }

    /** SR の中身。 */
    public record Content(List<Series> series, Map<String, String> params) {
    }

    /** 読み戻した結果。 */
    public record Read(String sopInstanceUid, String videoSopInstanceUid, String producerId,
                       String contentDate, List<Series> series, Map<String, String> params) {
    }

    /** 出所（プラグイン）。本体がマニフェストから入れる（プラグインに名乗らせない）。 */
    public record Producer(String id, String name, String version) {
    }

    /**
     * 中身を確かめる。
     *
     * @param frames 動画の NumberOfFrames。<b>系列の長さはこれと一致すること</b>（ずれた値の列は、
     *               もっともらしいが別のフレームの値になり、見て気付けない）
     */
    public static void validate(Content c, int frames) {
        if (c == null || c.series() == null || c.series().isEmpty()) {
            throw new IllegalArgumentException("frameValues.series が空です");
        }
        List<String> keys = new ArrayList<>();
        for (Series s : c.series()) {
            if (s.key() == null || !KEY.matcher(s.key()).matches()) {
                throw new IllegalArgumentException("系列の key は英数字と _ の 1〜16 文字: " + s.key());
            }
            if (keys.contains(s.key())) throw new IllegalArgumentException("系列の key が重複しています: " + s.key());
            keys.add(s.key());
            if (s.values() == null || s.values().size() != frames) {
                throw new IllegalArgumentException("系列 " + s.key() + " の長さ "
                        + (s.values() == null ? 0 : s.values().size()) + " が動画のフレーム数 " + frames + " と違います");
            }
            for (Double v : s.values()) {
                if (v == null || !Double.isFinite(v)) {
                    throw new IllegalArgumentException("系列 " + s.key() + " に有限でない値があります");
                }
            }
        }
    }

    /**
     * SR を組み立てる。
     *
     * @param video 対象の動画のヘッダ（患者・検査・SOP を継承する単一の出所）
     * @param sopUid / seriesUid SR の UID（呼び出し側が決める。動画ごとに決め打ちにして、再採点で置き換える）
     */
    public static Attributes build(Attributes video, Content c, Producer producer,
                                   String sopUid, String seriesUid, LocalDateTime now) {
        Attributes a = new Attributes();
        int[] inherit = {
                Tag.SpecificCharacterSet,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
                Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
        };
        for (int tag : inherit) copy(video, a, tag);
        if (a.getString(Tag.SpecificCharacterSet) == null) a.setSpecificCharacterSet("ISO_IR 192");

        a.setString(Tag.Modality, VR.CS, "SR");
        a.setString(Tag.SOPClassUID, VR.UI, UID.ComprehensiveSRStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        a.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        a.setInt(Tag.SeriesNumber, VR.IS, 9100);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        String name = producer.name() != null && !producer.name().isBlank() ? producer.name() : producer.id();
        a.setString(Tag.SeriesDescription, VR.LO, clip(PLUGIN_PREFIX + name + " frame values", 64));
        a.setString(Tag.ContentDate, VR.DA, now.format(DA));
        a.setString(Tag.ContentTime, VR.TM, now.format(TM));
        a.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next");
        // 読影医の確認行為をアプリが騙らない（H9 と同じ）
        a.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");
        a.setString(Tag.VerificationFlag, VR.CS, "UNVERIFIED");
        a.newSequence(Tag.ContributingEquipmentSequence, 1).add(equipment(producer));

        Attributes scheme = new Attributes(4);
        scheme.setString(Tag.CodingSchemeDesignator, VR.SH, SCHEME);
        scheme.setString(Tag.CodingSchemeUID, VR.UI, SCHEME_UID);
        scheme.setString(Tag.CodingSchemeName, VR.ST, "GRAPHY-Next plugin-defined concepts");
        scheme.setString(Tag.CodingSchemeResponsibleOrganization, VR.ST, "Visionary Imaging Services, Inc.");
        a.newSequence(Tag.CodingSchemeIdentificationSequence, 1).add(scheme);

        String videoSop = video.getString(Tag.SOPInstanceUID);
        String videoClass = video.getString(Tag.SOPClassUID, UID.UltrasoundMultiFrameImageStorage);
        Attributes evStudy = new Attributes(2);
        evStudy.setString(Tag.StudyInstanceUID, VR.UI, video.getString(Tag.StudyInstanceUID));
        Attributes evSeries = new Attributes(2);
        evSeries.setString(Tag.SeriesInstanceUID, VR.UI, video.getString(Tag.SeriesInstanceUID));
        evSeries.newSequence(Tag.ReferencedSOPSequence, 1).add(sopRef(videoClass, videoSop));
        evStudy.newSequence(Tag.ReferencedSeriesSequence, 1).add(evSeries);
        a.newSequence(Tag.CurrentRequestedProcedureEvidenceSequence, 1).add(evStudy);

        a.setString(Tag.ValueType, VR.CS, "CONTAINER");
        a.newSequence(Tag.ConceptNameCodeSequence, 1).add(code("PFV", SCHEME, "Per-frame values"));
        a.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        Sequence content = a.newSequence(Tag.ContentSequence, 4 + c.series().size());

        Attributes lang = item("HAS CONCEPT MOD", "CODE", code("121049", "DCM", "Language of Content Item and Descendants"));
        lang.newSequence(Tag.ConceptCodeSequence, 1).add(code("eng", "RFC5646", "English"));
        content.add(lang);
        Attributes img = item("CONTAINS", "IMAGE", null);
        img.newSequence(Tag.ReferencedSOPSequence, 1).add(sopRef(videoClass, videoSop));
        content.add(img);
        content.add(text(code("PFV-PRODUCER", SCHEME, "Producer plugin"), producer.id()));
        if (c.params() != null) {
            for (var e : c.params().entrySet()) {
                content.add(text(code("PFV-PARAM", SCHEME, "Parameter"), e.getKey() + "=" + e.getValue()));
            }
        }
        for (Series s : c.series()) {
            Attributes seriesCode = code(s.key(), SCHEME, s.label() != null && !s.label().isBlank() ? s.label() : s.key());
            Attributes box = item("CONTAINS", "CONTAINER", seriesCode);
            box.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
            Sequence nums = box.newSequence(Tag.ContentSequence, s.values().size() + 1);
            nums.add(text(code("PFV-FRAMES", SCHEME, "Frames in order"), "1-" + s.values().size()));
            String unit = s.unit() != null && !s.unit().isBlank() ? s.unit() : "1";
            for (Double v : s.values()) nums.add(num(seriesCode, unit, v));
            content.add(box);
        }
        return a;
    }

    /** 読み戻す。この形の SR でなければ null。 */
    public static Read read(Attributes sr) {
        Attributes root = first(sr.getSequence(Tag.ConceptNameCodeSequence));
        if (root == null || !"PFV".equals(root.getString(Tag.CodeValue))
                || !SCHEME.equals(root.getString(Tag.CodingSchemeDesignator))) {
            return null;
        }
        String videoSop = null;
        String producer = null;
        Map<String, String> params = new LinkedHashMap<>();
        List<Series> series = new ArrayList<>();
        Sequence content = sr.getSequence(Tag.ContentSequence);
        for (Attributes it : content == null ? List.<Attributes>of() : content) {
            String vt = it.getString(Tag.ValueType);
            Attributes cn = first(it.getSequence(Tag.ConceptNameCodeSequence));
            String cv = cn == null ? null : cn.getString(Tag.CodeValue);
            if ("IMAGE".equals(vt)) {
                Attributes ref = first(it.getSequence(Tag.ReferencedSOPSequence));
                if (ref != null) videoSop = ref.getString(Tag.ReferencedSOPInstanceUID);
            } else if ("TEXT".equals(vt) && "PFV-PRODUCER".equals(cv)) {
                producer = it.getString(Tag.TextValue);
            } else if ("TEXT".equals(vt) && "PFV-PARAM".equals(cv)) {
                String t = it.getString(Tag.TextValue, "");
                int eq = t.indexOf('=');
                if (eq > 0) params.put(t.substring(0, eq), t.substring(eq + 1));
            } else if ("CONTAINER".equals(vt) && cn != null) {
                List<Double> values = new ArrayList<>();
                String unit = "1";
                Sequence kids = it.getSequence(Tag.ContentSequence);
                for (Attributes k : kids == null ? List.<Attributes>of() : kids) {
                    if (!"NUM".equals(k.getString(Tag.ValueType))) continue;
                    Attributes mv = first(k.getSequence(Tag.MeasuredValueSequence));
                    if (mv == null) continue;
                    double v = mv.contains(Tag.FloatingPointValue)
                            ? mv.getDouble(Tag.FloatingPointValue, Double.NaN)
                            : Double.parseDouble(mv.getString(Tag.NumericValue, "NaN"));
                    values.add(v);
                    Attributes u = first(mv.getSequence(Tag.MeasurementUnitsCodeSequence));
                    if (u != null) unit = u.getString(Tag.CodeValue, unit);
                }
                series.add(new Series(cv, cn.getString(Tag.CodeMeaning), unit, values));
            }
        }
        return new Read(sr.getString(Tag.SOPInstanceUID), videoSop, producer,
                sr.getString(Tag.ContentDate), series, params);
    }

    // ── 小道具 ──

    static Attributes equipment(Producer p) {
        Attributes eq = new Attributes(4);
        eq.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next plugin");
        eq.setString(Tag.ManufacturerModelName, VR.LO, p.name() != null && !p.name().isBlank() ? clip(p.name(), 64) : p.id());
        eq.setString(Tag.SoftwareVersions, VR.LO, p.version() != null ? p.version() : "");
        eq.setString(Tag.ContributionDescription, VR.ST, "Produced by plugin " + p.id());
        return eq;
    }

    private static Attributes num(Attributes concept, String unit, double v) {
        Attributes n = item("CONTAINS", "NUM", new Attributes(concept));
        Attributes mv = new Attributes(3);
        mv.newSequence(Tag.MeasurementUnitsCodeSequence, 1).add(code(unit, "UCUM", unit));
        mv.setString(Tag.NumericValue, VR.DS, ds(v));
        mv.setDouble(Tag.FloatingPointValue, VR.FD, v); // 丸めない値
        n.newSequence(Tag.MeasuredValueSequence, 1).add(mv);
        return n;
    }

    /** DS（16 文字まで）。桁が収まらなければ指数表記に落とす。正確な値は FD に入っている。 */
    static String ds(double v) {
        String s = Double.toString(v);
        if (s.length() <= 16) return s;
        for (int digits = 9; digits >= 1; digits--) {
            String e = String.format(java.util.Locale.ROOT, "%." + digits + "E", v);
            if (e.length() <= 16) return e;
        }
        return String.format(java.util.Locale.ROOT, "%.1E", v);
    }

    private static Attributes sopRef(String cls, String sop) {
        Attributes r = new Attributes(2);
        r.setString(Tag.ReferencedSOPClassUID, VR.UI, cls);
        r.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sop);
        return r;
    }

    private static Attributes code(String value, String scheme, String meaning) {
        Attributes c = new Attributes(3);
        c.setString(Tag.CodeValue, VR.SH, value);
        c.setString(Tag.CodingSchemeDesignator, VR.SH, scheme);
        c.setString(Tag.CodeMeaning, VR.LO, clip(meaning, 64));
        return c;
    }

    private static Attributes item(String relationship, String valueType, Attributes conceptName) {
        Attributes i = new Attributes(6);
        i.setString(Tag.RelationshipType, VR.CS, relationship);
        i.setString(Tag.ValueType, VR.CS, valueType);
        if (conceptName != null) i.newSequence(Tag.ConceptNameCodeSequence, 1).add(conceptName);
        return i;
    }

    private static Attributes text(Attributes conceptName, String value) {
        Attributes t = item("CONTAINS", "TEXT", conceptName);
        t.setString(Tag.TextValue, VR.UT, value == null ? "" : value);
        return t;
    }

    private static Attributes first(Sequence s) {
        return s == null || s.isEmpty() ? null : s.get(0);
    }

    private static void copy(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) return;
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) to.setString(tag, from.getVR(tag), v);
    }

    static String clip(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}

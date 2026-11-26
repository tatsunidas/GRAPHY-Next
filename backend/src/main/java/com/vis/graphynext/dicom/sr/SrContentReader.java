/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * DICOM SR の**内容の木**を、画面（SeriesViewer の SR 表示）が読める形にする。
 *
 * <p>入力は SR のデータセット（{@link Attributes}）。出力は、値の型ごとに必要な値だけを持つ木。
 * <b>テンプレートには依存しない</b>（Basic Text・Enhanced・Comprehensive・X 線被ばく線量 SR・本体が書く計測レポートなど、
 * どれも同じ「コンテナ ＋ 項目」の構造なので、汎用の木として読む）。
 *
 * <h3>安全</h3>
 * SR は外から取り込んだ入力なので、<b>深さ・項目数・テキストの長さ</b>に上限を置く（上限を超えたら、**黙って切らず**、
 * {@link SrDocument#truncated()} と理由を返す）。患者名・患者 ID は返さない（画面の他の場所にあり、SR の本文に要らない）。
 * 値はすべて文字列・数値として返す（HTML は作らない。画面側が文字として描く）。
 */
public final class SrContentReader {

    /** コンテナの入れ子の深さの上限。 */
    public static final int MAX_DEPTH = 64;
    /** 項目数の上限。 */
    public static final int MAX_ITEMS = 20_000;
    /** テキスト 1 つの長さの上限（文字数）。 */
    public static final int MAX_TEXT_CHARS = 1_000_000;

    private SrContentReader() {
    }

    /** コード 1 つ（コード値・コーディングスキーム・意味）。 */
    public record Code(String value, String scheme, String meaning) {
    }

    /** 参照した SOP（IMAGE・COMPOSITE・WAVEFORM）。 */
    public record Ref(String sopClassUid, String sopInstanceUid, List<Integer> frames, List<Integer> segments) {
    }

    /** 図形（SCOORD・SCOORD3D）。座標は数の並び。 */
    public record Graphic(String type, List<Double> data, String frameOfReferenceUid) {
    }

    /** 時間座標（TCOORD）。 */
    public record Temporal(String rangeType, List<Long> samplePositions, List<Double> timeOffsets, List<String> dateTimes) {
    }

    /** 数値（NUM）。値は文字列（DS の桁を保つ）、単位はコード。 */
    public record Num(String value, Code unit, Code qualifier) {
    }

    /**
     * 内容の項目 1 つ。型に関係の無い欄は null。
     *
     * @param relationship ルートは null。{@code CONTAINS} / {@code HAS OBS CONTEXT} など
     * @param valueType    {@code CONTAINER} / {@code TEXT} / {@code NUM} / {@code CODE} …
     */
    public record Node(
            String relationship,
            String valueType,
            Code concept,
            String text,
            Num num,
            Code code,
            String uid,
            String date,
            String time,
            String dateTime,
            String personName,
            String continuity,
            Ref ref,
            Graphic graphic,
            Temporal temporal,
            List<Node> children) {
    }

    public record Verifier(String organization, String dateTime, String name) {
    }

    public record Header(
            String sopClassUid,
            String sopClassName,
            String studyInstanceUid,
            String seriesInstanceUid,
            String sopInstanceUid,
            /** {@code COMPLETE} / {@code PARTIAL}。無ければ null。 */
            String completionFlag,
            /** {@code VERIFIED} / {@code UNVERIFIED}。無ければ null。 */
            String verificationFlag,
            String contentDate,
            String contentTime,
            List<Verifier> verifiers) {
    }

    /** 読み取りの結果。{@code truncated} が真なら、上限に当たって木が途中で切れている。 */
    public record SrDocument(Header header, Node root, boolean truncated, String truncatedReason, int itemCount) {
    }

    /** SR として読めない（SOP クラスが SR でない・内容が無い）。 */
    public static final class NotSrException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public NotSrException(String message) {
            super(message);
        }
    }

    /** SR の SOP クラス名。一覧に無いものは、UID をそのまま名前にする。 */
    private static final Map<String, String> SR_CLASSES = Map.ofEntries(
            Map.entry(UID.BasicTextSRStorage, "Basic Text SR"),
            Map.entry(UID.EnhancedSRStorage, "Enhanced SR"),
            Map.entry(UID.ComprehensiveSRStorage, "Comprehensive SR"),
            Map.entry(UID.Comprehensive3DSRStorage, "Comprehensive 3D SR"),
            Map.entry(UID.ExtensibleSRStorage, "Extensible SR"),
            Map.entry(UID.ProcedureLogStorage, "Procedure Log"),
            Map.entry(UID.MammographyCADSRStorage, "Mammography CAD SR"),
            Map.entry(UID.ChestCADSRStorage, "Chest CAD SR"),
            Map.entry(UID.ColonCADSRStorage, "Colon CAD SR"),
            Map.entry(UID.XRayRadiationDoseSRStorage, "X-Ray Radiation Dose SR"),
            Map.entry(UID.RadiopharmaceuticalRadiationDoseSRStorage, "Radiopharmaceutical Radiation Dose SR"),
            Map.entry(UID.SpectaclePrescriptionReportStorage, "Spectacle Prescription Report"),
            Map.entry(UID.MacularGridThicknessAndVolumeReportStorage, "Macular Grid Thickness and Volume Report"),
            Map.entry(UID.ImplantationPlanSRStorage, "Implantation Plan SR"),
            Map.entry(UID.AcquisitionContextSRStorage, "Acquisition Context SR"),
            Map.entry(UID.SimplifiedAdultEchoSRStorage, "Simplified Adult Echo SR"),
            Map.entry(UID.PatientRadiationDoseSRStorage, "Patient Radiation Dose SR"),
            Map.entry(UID.PerformedImagingAgentAdministrationSRStorage, "Performed Imaging Agent Administration SR"),
            Map.entry(UID.PlannedImagingAgentAdministrationSRStorage, "Planned Imaging Agent Administration SR"));

    /** SOP クラスが SR か。 */
    public static boolean isSrClass(String sopClassUid) {
        return sopClassUid != null && SR_CLASSES.containsKey(sopClassUid);
    }

    /** 読み取りの途中の状態（項目数・切り詰めの有無）。 */
    private static final class State {
        int items;
        boolean truncated;
        String reason;

        void truncate(String why) {
            if (!truncated) {
                truncated = true;
                reason = why;
            }
        }
    }

    /**
     * SR のデータセットを読む。
     *
     * @throws NotSrException SR の SOP クラスでない、または内容（ValueType・ContentSequence）が無い
     */
    public static SrDocument read(Attributes ds) {
        String sopClass = ds.getString(Tag.SOPClassUID);
        if (!isSrClass(sopClass) && ds.getString(Tag.ValueType) == null) {
            throw new NotSrException("SR ではありません（SOP クラス: " + sopClass + "）");
        }
        if (ds.getString(Tag.ValueType) == null) {
            throw new NotSrException("SR の内容（ValueType）がありません");
        }
        State st = new State();
        Node root = readNode(ds, null, 0, st);
        return new SrDocument(headerOf(ds), root, st.truncated, st.reason, st.items);
    }

    private static Header headerOf(Attributes ds) {
        String sop = ds.getString(Tag.SOPClassUID);
        List<Verifier> verifiers = new ArrayList<>();
        Sequence vs = ds.getSequence(Tag.VerifyingObserverSequence);
        if (vs != null) {
            for (Attributes v : vs) {
                verifiers.add(new Verifier(
                        v.getString(Tag.VerifyingOrganization),
                        v.getString(Tag.VerificationDateTime),
                        v.getString(Tag.VerifyingObserverName)));
            }
        }
        return new Header(
                sop,
                SR_CLASSES.getOrDefault(sop, sop),
                ds.getString(Tag.StudyInstanceUID),
                ds.getString(Tag.SeriesInstanceUID),
                ds.getString(Tag.SOPInstanceUID),
                ds.getString(Tag.CompletionFlag),
                ds.getString(Tag.VerificationFlag),
                ds.getString(Tag.ContentDate),
                ds.getString(Tag.ContentTime),
                verifiers);
    }

    private static Node readNode(Attributes a, String relationship, int depth, State st) {
        st.items++;
        String type = a.getString(Tag.ValueType);
        String text = null;
        Num num = null;
        Code code = null;
        String uid = null;
        String date = null;
        String time = null;
        String dateTime = null;
        String pname = null;
        String continuity = null;
        Ref ref = null;
        Graphic graphic = null;
        Temporal temporal = null;

        if (type != null) {
            switch (type) {
                case "TEXT" -> text = clip(a.getString(Tag.TextValue), st);
                case "NUM" -> num = numOf(a);
                case "CODE" -> code = codeOf(first(a.getSequence(Tag.ConceptCodeSequence)));
                case "DATE" -> date = a.getString(Tag.Date);
                case "TIME" -> time = a.getString(Tag.Time);
                case "DATETIME" -> dateTime = a.getString(Tag.DateTime);
                case "PNAME" -> pname = a.getString(Tag.PersonName);
                case "UIDREF" -> uid = a.getString(Tag.UID);
                case "CONTAINER" -> continuity = a.getString(Tag.ContinuityOfContent);
                case "IMAGE", "COMPOSITE", "WAVEFORM" -> ref = refOf(a);
                case "SCOORD", "SCOORD3D" -> graphic = graphicOf(a);
                case "TCOORD" -> temporal = temporalOf(a);
                default -> {
                    // 未知の型は、型名だけを返して値は読まない（黙って別の意味にしない）。
                }
            }
        }

        List<Node> children = new ArrayList<>();
        Sequence content = a.getSequence(Tag.ContentSequence);
        if (content != null && !content.isEmpty()) {
            if (depth + 1 > MAX_DEPTH) {
                st.truncate("入れ子の深さが上限（" + MAX_DEPTH + "）を超えました");
            } else {
                for (Attributes item : content) {
                    if (st.items >= MAX_ITEMS) {
                        st.truncate("項目数が上限（" + MAX_ITEMS + "）を超えました");
                        break;
                    }
                    children.add(readNode(item, item.getString(Tag.RelationshipType), depth + 1, st));
                }
            }
        }
        return new Node(relationship, type, codeOf(first(a.getSequence(Tag.ConceptNameCodeSequence))), text, num, code,
                uid, date, time, dateTime, pname, continuity, ref, graphic, temporal, children);
    }

    private static String clip(String s, State st) {
        if (s != null && s.length() > MAX_TEXT_CHARS) {
            st.truncate("テキストが上限（" + MAX_TEXT_CHARS + " 文字）を超えました");
            return s.substring(0, MAX_TEXT_CHARS);
        }
        return s;
    }

    private static Attributes first(Sequence seq) {
        return seq == null || seq.isEmpty() ? null : seq.get(0);
    }

    private static Code codeOf(Attributes c) {
        if (c == null) {
            return null;
        }
        return new Code(c.getString(Tag.CodeValue), c.getString(Tag.CodingSchemeDesignator), c.getString(Tag.CodeMeaning));
    }

    private static Num numOf(Attributes a) {
        Attributes mv = first(a.getSequence(Tag.MeasuredValueSequence));
        String value = null;
        Code unit = null;
        if (mv != null) {
            value = mv.getString(Tag.NumericValue);
            if (value == null && mv.containsValue(Tag.FloatingPointValue)) {
                value = String.valueOf(mv.getDouble(Tag.FloatingPointValue, Double.NaN));
            }
            unit = codeOf(first(mv.getSequence(Tag.MeasurementUnitsCodeSequence)));
        }
        return new Num(value, unit, codeOf(first(a.getSequence(Tag.NumericValueQualifierCodeSequence))));
    }

    private static Ref refOf(Attributes a) {
        Attributes r = first(a.getSequence(Tag.ReferencedSOPSequence));
        if (r == null) {
            return null;
        }
        return new Ref(r.getString(Tag.ReferencedSOPClassUID), r.getString(Tag.ReferencedSOPInstanceUID),
                ints(r.getInts(Tag.ReferencedFrameNumber)), ints(r.getInts(Tag.ReferencedSegmentNumber)));
    }

    private static Graphic graphicOf(Attributes a) {
        float[] data = a.getFloats(Tag.GraphicData);
        List<Double> out = new ArrayList<>();
        if (data != null) {
            for (float v : data) {
                out.add((double) v);
            }
        }
        return new Graphic(a.getString(Tag.GraphicType), out, a.getString(Tag.ReferencedFrameOfReferenceUID));
    }

    private static Temporal temporalOf(Attributes a) {
        List<Long> positions = new ArrayList<>();
        int[] pos = a.getInts(Tag.ReferencedSamplePositions);
        if (pos != null) {
            for (int p : pos) {
                positions.add(p & 0xFFFFFFFFL); // UL
            }
        }
        List<Double> offsets = new ArrayList<>();
        double[] off = a.getDoubles(Tag.ReferencedTimeOffsets);
        if (off != null) {
            for (double d : off) {
                offsets.add(d);
            }
        }
        String[] dts = a.getStrings(Tag.ReferencedDateTime);
        return new Temporal(a.getString(Tag.TemporalRangeType), positions, offsets,
                dts == null ? List.of() : List.of(dts));
    }

    private static List<Integer> ints(int[] v) {
        List<Integer> out = new ArrayList<>();
        if (v != null) {
            for (int i : v) {
                out.add(i);
            }
        }
        return out;
    }
}

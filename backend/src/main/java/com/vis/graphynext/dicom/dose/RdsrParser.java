/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.dose;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * X-Ray Radiation Dose SR（RDSR, 1.2.840.10008.5.1.4.1.1.88.67）のパーサ
 * （{@code fw/angio-design.md} §14.2 / A9）。純関数。
 *
 * <h3>設計方針: コード表に依存しすぎない</h3>
 * RDSR は TID 10001（Projection X-Ray Radiation Dose）→ TID 10003（Irradiation Event X-Ray Data）
 * という入れ子だが、<b>DCM のコード値をハードコードした表で引くと、表が 1 つ間違っているだけで
 * 「何も見つからない」パーサになる</b>（しかも例外は出ないので気づけない）。
 *
 * <p>そこで
 * <ul>
 *   <li>содержимое の木は<b>汎用に全部読む</b>（ValueType=NUM/TEXT/CODE/UIDREF/DATETIME を素直に拾う）</li>
 *   <li>集計は<b>ファイル自身が持っている CodeMeaning</b>で突き合わせる
 *       （"Dose Area Product Total" 等。RDSR は必ず CodeMeaning を書く）</li>
 *   <li>コード値（{@code 1135xx} 等）は<b>参考情報として一緒に返す</b>だけにする</li>
 * </ul>
 * とした。表に無い項目も UI に出るので、実データを見てから対応表を育てられる。
 *
 * <p>⚠️ <b>これは線量管理システムの代替ではない</b>。皮膚線量分布の計算・警告閾値・施設 DRL 比較は
 * やらない（読み取りと表示まで）。
 */
public final class RdsrParser {

    /** X-Ray Radiation Dose SR の SOP Class UID。 */
    public static final String RDSR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.88.67";

    private RdsrParser() {
    }

    /** SR の 1 項目（NUM / TEXT / CODE / UIDREF / DATETIME）。 */
    public record DoseItem(
            /** ConceptNameCodeSequence の CodeValue（"113722" 等）。無ければ null。 */
            String code,
            /** 同 CodeMeaning（"Dose Area Product Total" 等）。突き合わせはこちらで行う。 */
            String meaning,
            /** ValueType（"NUM" / "TEXT" / "CODE" / "UIDREF" / "DATETIME"）。 */
            String valueType,
            /** NUM の数値。NUM 以外は null。 */
            Double numericValue,
            /** NUM の単位（UCUM の CodeValue。"mGy.cm2" 等）。 */
            String unit,
            /** TEXT/CODE/UIDREF/DATETIME の文字列表現。 */
            String textValue) {
    }

    /** 1 回の照射イベント（TID 10003 相当）。 */
    public record IrradiationEvent(
            int index,
            /** Irradiation Event Type（"Fluoroscopy" / "Stationary Acquisition" 等）。無ければ null。 */
            String eventType,
            /** Irradiation Event UID。無ければ null。 */
            String eventUid,
            /** このイベント配下の全項目。 */
            List<DoseItem> items) {
    }

    /** 1 つの RDSR インスタンスの読み取り結果。 */
    public record DoseReport(
            String sopInstanceUid,
            String studyInstanceUid,
            String seriesInstanceUid,
            /** ContentDate + ContentTime（"20260814093000" 形式）。無ければ null。 */
            String contentDateTime,
            String manufacturer,
            /** 積算線量（"Accumulated ..." コンテナ配下の NUM）。 */
            List<DoseItem> accumulated,
            List<IrradiationEvent> events) {
    }

    /** この Attributes が RDSR か。 */
    public static boolean isRdsr(Attributes ds) {
        return ds != null && RDSR_SOP_CLASS.equals(ds.getString(Tag.SOPClassUID));
    }

    /** RDSR を読む。RDSR でなければ null。 */
    public static DoseReport parse(Attributes ds) {
        if (!isRdsr(ds)) {
            return null;
        }
        List<DoseItem> accumulated = new ArrayList<>();
        List<IrradiationEvent> events = new ArrayList<>();
        walk(ds, accumulated, events, false);

        String date = ds.getString(Tag.ContentDate);
        String time = ds.getString(Tag.ContentTime);
        String dt = date == null ? null : date + (time == null ? "" : time);

        return new DoseReport(
                ds.getString(Tag.SOPInstanceUID),
                ds.getString(Tag.StudyInstanceUID),
                ds.getString(Tag.SeriesInstanceUID),
                dt,
                ds.getString(Tag.Manufacturer),
                accumulated,
                events);
    }

    /**
     * ContentSequence を再帰的に降りる。
     *
     * @param inAccumulated 「積算線量」コンテナの配下にいるか（そこの NUM を accumulated に積む）
     */
    private static void walk(
            Attributes node, List<DoseItem> accumulated, List<IrradiationEvent> events, boolean inAccumulated) {
        Sequence content = node.getSequence(Tag.ContentSequence);
        if (content == null) {
            return;
        }
        for (Attributes child : content) {
            String meaning = conceptMeaning(child);
            String lower = meaning == null ? "" : meaning.toLowerCase(Locale.ROOT);

            // 照射イベント: この配下は 1 イベントとしてまとめる（入れ子の CONTAINER も含めて回収）。
            if (lower.contains("irradiation event")) {
                List<DoseItem> items = new ArrayList<>();
                collectItems(child, items);
                events.add(new IrradiationEvent(
                        events.size(),
                        findText(items, "irradiation event type"),
                        findText(items, "irradiation event uid"),
                        items));
                continue;
            }
            // 積算線量コンテナ。
            boolean nextAccumulated = inAccumulated || lower.contains("accumulated");
            DoseItem item = toItem(child, meaning);
            if (item != null && nextAccumulated && "NUM".equals(item.valueType())) {
                accumulated.add(item);
            }
            walk(child, accumulated, events, nextAccumulated);
        }
    }

    /** ノード配下（自身を含む）の値項目をすべて集める。 */
    private static void collectItems(Attributes node, List<DoseItem> out) {
        DoseItem self = toItem(node, conceptMeaning(node));
        if (self != null && !"CONTAINER".equals(self.valueType())) {
            out.add(self);
        }
        Sequence content = node.getSequence(Tag.ContentSequence);
        if (content == null) {
            return;
        }
        for (Attributes child : content) {
            collectItems(child, out);
        }
    }

    private static String conceptMeaning(Attributes node) {
        Attributes concept = node.getNestedDataset(Tag.ConceptNameCodeSequence);
        return concept == null ? null : concept.getString(Tag.CodeMeaning);
    }

    private static String conceptCode(Attributes node) {
        Attributes concept = node.getNestedDataset(Tag.ConceptNameCodeSequence);
        return concept == null ? null : concept.getString(Tag.CodeValue);
    }

    /** 1 ノードを DoseItem に。値を持たない CONTAINER も型だけ返す（呼び出し側で捨てる）。 */
    private static DoseItem toItem(Attributes node, String meaning) {
        String valueType = node.getString(Tag.ValueType);
        if (valueType == null) {
            return null;
        }
        String code = conceptCode(node);
        switch (valueType) {
            case "NUM" -> {
                Attributes measured = node.getNestedDataset(Tag.MeasuredValueSequence);
                if (measured == null) {
                    return new DoseItem(code, meaning, valueType, null, null, null);
                }
                Double value = measured.containsValue(Tag.NumericValue) ? measured.getDouble(Tag.NumericValue, Double.NaN) : null;
                if (value != null && value.isNaN()) {
                    value = null;
                }
                Attributes units = measured.getNestedDataset(Tag.MeasurementUnitsCodeSequence);
                String unit = units == null ? null : units.getString(Tag.CodeValue);
                return new DoseItem(code, meaning, valueType, value, unit, null);
            }
            case "CODE" -> {
                Attributes v = node.getNestedDataset(Tag.ConceptCodeSequence);
                return new DoseItem(code, meaning, valueType, null, null, v == null ? null : v.getString(Tag.CodeMeaning));
            }
            case "TEXT" -> {
                return new DoseItem(code, meaning, valueType, null, null, node.getString(Tag.TextValue));
            }
            case "UIDREF" -> {
                return new DoseItem(code, meaning, valueType, null, null, node.getString(Tag.UID));
            }
            case "DATETIME" -> {
                return new DoseItem(code, meaning, valueType, null, null, node.getString(Tag.DateTime));
            }
            default -> {
                return new DoseItem(code, meaning, valueType, null, null, null);
            }
        }
    }

    /** meaning に部分一致する最初の項目の文字列値。 */
    private static String findText(List<DoseItem> items, String meaningContains) {
        for (DoseItem i : items) {
            if (i.meaning() != null && i.meaning().toLowerCase(Locale.ROOT).contains(meaningContains)) {
                return i.textValue();
            }
        }
        return null;
    }

    /**
     * 集計（UI のサマリ用）。<b>CodeMeaning の部分一致</b>で拾う。
     * 見つからなければ null を返し、UI は「—」を出す（0 と区別する）。
     */
    public static Double sumByMeaning(List<DoseItem> items, String meaningContains) {
        Double sum = null;
        String needle = meaningContains.toLowerCase(Locale.ROOT);
        for (DoseItem i : items) {
            if (i.numericValue() == null || i.meaning() == null) {
                continue;
            }
            if (i.meaning().toLowerCase(Locale.ROOT).contains(needle)) {
                sum = (sum == null ? 0 : sum) + i.numericValue();
            }
        }
        return sum;
    }
}

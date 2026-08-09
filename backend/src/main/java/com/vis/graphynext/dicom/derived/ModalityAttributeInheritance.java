/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

import java.util.ArrayList;
import java.util.List;

/**
 * 派生シリーズへ引き継ぐ**モダリティ別**の属性表（設計 {@code fw/registration-design.md} §8.3）。
 *
 * <h3>なぜ要るのか</h3>
 *
 * <p>派生シリーズは幾何（IOP/IPP/PixelSpacing）を作り直すが、
 * <b>画素値が何の量なのかを説明する属性は元シリーズのまま</b>でなければならない。
 * ところが従来の引き継ぎ一覧は患者・検査・表示系だけで、<b>PET 固有のタグが 1 つも
 * 入っていなかった</b>。その結果、リサンプルした PET を保存すると
 *
 * <ul>
 *   <li>{@code Modality} は {@code PT} のまま</li>
 *   <li>{@code SOPClassUID} も PET Image Storage のまま</li>
 *   <li>画像は普通に開けて画素値も出る</li>
 *   <li><b>しかし SUV だけが計算できない</b></li>
 * </ul>
 *
 * <p>という、最も気付きにくい壊れ方をする。フロントの {@code viewer/suv.ts} は
 * {@code Units} / {@code RadiopharmaceuticalInformationSequence}（投与量・投与時刻・半減期）/
 * {@code PatientWeight} / 減衰補正の基準時刻を必要とするため、どれか欠けると
 * {@code missingHalfLife} 等で静かに失敗する。
 *
 * <h3>方針</h3>
 *
 * <p>モダリティごとに「引き継ぐタグ」と「これが欠けたら保存を拒否する必須タグ」を持つ。
 * 拒否するのは、{@code plugin-architecture.md} H4b の
 * 「{@code background} 未指定は同意を求める前に拒否」と同じ考え方で、
 * <b>壊れたシリーズを黙って作るくらいなら作らない</b>ため。
 */
final class ModalityAttributeInheritance {

    private ModalityAttributeInheritance() {}

    /**
     * どのモダリティでも引き継ぐ属性（患者・検査・表示系）。
     * 従来 {@code DerivedSeriesService} が持っていた一覧そのもの。
     */
    static final int[] COMMON = {
            Tag.SpecificCharacterSet,
            Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex, Tag.PatientAge,
            Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
            Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
            Tag.Manufacturer, Tag.ManufacturerModelName,
            Tag.PatientPosition,
            Tag.WindowCenter, Tag.WindowWidth, Tag.VOILUTFunction,
    };

    /**
     * PET（{@code PT}）で追加で引き継ぐ属性。
     *
     * <p>いずれも「画素値が何の量か」「どう補正されているか」を説明するもので、
     * 幾何を作り直しても真であり続ける。
     */
    static final int[] PT = {
            Tag.Units,                                   // (0054,1001) BQML / CNTS / GML
            Tag.CorrectedImage,                          // (0028,0051) DECY / ATTN 等
            Tag.DecayCorrection,                         // (0054,1102) START 等
            Tag.SeriesDate, Tag.SeriesTime,              // 減衰補正の基準時刻
            Tag.AcquisitionDate, Tag.AcquisitionTime,
            Tag.PatientWeight, Tag.PatientSize,          // SUV の分母
            Tag.SUVType,                                 // (0054,1006) すでに SUV 化されている場合
            Tag.RadiopharmaceuticalInformationSequence,  // (0054,0016) 投与量・投与時刻・半減期・核種
    };

    /** NM でも PET と同じ属性群が意味を持つ（定量の枠組みが共通）。 */
    static final int[] NM = PT;

    /**
     * MR で追加で引き継ぐ属性。<b>当面は最小限</b>（設計 §8.3）。
     * MR は定量が標準化されていないので、まず「何で撮ったか」を失わないことを優先する。
     */
    static final int[] MR = {
            Tag.MagneticFieldStrength,
            Tag.ScanningSequence, Tag.SequenceVariant, Tag.ScanOptions, Tag.MRAcquisitionType,
            Tag.RepetitionTime, Tag.EchoTime, Tag.FlipAngle,
            Tag.SeriesDate, Tag.SeriesTime,
    };

    /**
     * PET で「これが無いと SUV が計算できない」タグ。
     *
     * <p>{@code RadiopharmaceuticalInformationSequence} の中身（投与量・投与時刻・半減期）は
     * {@link #missingRequired} で個別に見る。
     */
    private static final int[] PT_REQUIRED = {
            Tag.Units,
            Tag.PatientWeight,
            Tag.RadiopharmaceuticalInformationSequence,
    };

    /** モダリティに応じた追加の引き継ぎ属性。未知のモダリティなら空。 */
    static int[] extraFor(String modality) {
        if (modality == null) return new int[0];
        return switch (modality.toUpperCase()) {
            case "PT" -> PT;
            case "NM" -> NM;
            case "MR" -> MR;
            default -> new int[0];
        };
    }

    /**
     * 元シリーズから派生シリーズへ、モダリティ別の属性を引き継ぐ。
     *
     * <p>シーケンス（{@code RadiopharmaceuticalInformationSequence}）は
     * <b>中身ごと複製する</b>。参照だけ渡すと、元の {@code Attributes} が解放された後に
     * 空になることがある。
     */
    static void inherit(Attributes tmpl, Attributes dst, String modality) {
        for (int tag : COMMON) copy(tmpl, dst, tag);
        for (int tag : extraFor(modality)) copy(tmpl, dst, tag);
    }

    private static void copy(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) return;
        if (from.getSequence(tag) != null) {
            Sequence src = from.getSequence(tag);
            Sequence dst = to.newSequence(tag, src.size());
            for (Attributes item : src) {
                dst.add(new Attributes(item));
            }
            return;
        }
        to.setValue(tag, from.getVR(tag), from.getValue(tag));
    }

    /**
     * SUV 計算に必要なタグのうち、引き継げなかったものを返す（PET / NM のみ）。
     *
     * <p>空でなければ<b>保存を拒否する</b>。「見た目は PET なのに定量できない」シリーズを
     * 黙って作らないため。
     */
    static List<String> missingRequired(Attributes dst, String modality) {
        List<String> missing = new ArrayList<>();
        if (modality == null) return missing;
        String m = modality.toUpperCase();
        if (!m.equals("PT") && !m.equals("NM")) return missing;

        for (int tag : PT_REQUIRED) {
            if (!dst.contains(tag) || isEmpty(dst, tag)) {
                missing.add(tagLabel(tag));
            }
        }
        // 半減期と投与量はシーケンスの中にある。表側が在っても中身が空なら SUV は出せない。
        Sequence rad = dst.getSequence(Tag.RadiopharmaceuticalInformationSequence);
        if (rad != null && !rad.isEmpty()) {
            Attributes item = rad.get(0);
            if (item.getDouble(Tag.RadionuclideTotalDose, 0) <= 0) {
                missing.add("(0018,1074) RadionuclideTotalDose");
            }
            if (item.getDouble(Tag.RadionuclideHalfLife, 0) <= 0) {
                missing.add("(0018,1075) RadionuclideHalfLife");
            }
            String startTime = item.getString(Tag.RadiopharmaceuticalStartTime);
            String startDateTime = item.getString(Tag.RadiopharmaceuticalStartDateTime);
            if ((startTime == null || startTime.isBlank())
                    && (startDateTime == null || startDateTime.isBlank())) {
                missing.add("(0018,1072) RadiopharmaceuticalStartTime");
            }
        }
        return missing;
    }

    private static boolean isEmpty(Attributes a, int tag) {
        if (a.getSequence(tag) != null) return a.getSequence(tag).isEmpty();
        String s = a.getString(tag);
        return s == null || s.isBlank();
    }

    /** 人が読める「(gggg,eeee) Keyword」表記。エラーメッセージ用。 */
    private static String tagLabel(int tag) {
        String kw = org.dcm4che3.data.ElementDictionary.keywordOf(tag, null);
        String hex = String.format("(%04X,%04X)", tag >>> 16, tag & 0xFFFF);
        return kw != null && !kw.isBlank() ? hex + " " + kw : hex;
    }

    /**
     * {@code RescaleType} の既定値をモダリティと {@code Units} から決める。
     *
     * <p>従来は「CT なら HU」しか無く、PET には何も入らなかった。PET の画素は
     * {@code Units} が示す量（BQML など）なので、それをそのまま {@code RescaleType} にする。
     *
     * @return 設定すべき値。決められなければ {@code null}（その場合はタグを書かない）。
     */
    static String defaultRescaleType(String modality, Attributes tmpl) {
        if (modality == null) return null;
        String m = modality.toUpperCase();
        if (m.equals("CT")) return "HU";
        if (m.equals("PT") || m.equals("NM")) {
            String units = tmpl.getString(Tag.Units);
            return units != null && !units.isBlank() ? units : null;
        }
        return null;
    }

    /** VR を明示して文字列を書く（{@code setValue} が使えない新規タグ用）。 */
    static void setString(Attributes a, int tag, VR vr, String value) {
        if (value != null && !value.isBlank()) a.setString(tag, vr, value);
    }
}

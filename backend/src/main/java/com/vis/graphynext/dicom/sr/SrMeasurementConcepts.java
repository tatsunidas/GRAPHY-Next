/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * SR の数値計測（NUM）で使う**計測種別 → 概念コード・既定単位**の表（host API の H16）。
 *
 * <h3>なぜ表を 1 か所に置くか</h3>
 *
 * <p>計測種別が増えるたびに {@code switch} が 3 か所（検証・コード・単位）に散ると、
 * 「検証は通るがコードが無い」種別が生まれる。表を単一の出所にして、
 * <b>表に無い種別は受け付けない</b>（＝黙って落とさない）で通す。
 *
 * <h3>🔴 確認できない標準コードを書かない</h3>
 *
 * <p>長径・短径は実務で広く使われている SRT の {@code G-A185 / G-A186}（dcmjs / OHIF と同じ）を使う。
 * 一方、<b>吸収線量・時間積分放射能・有効半減期・質量・BED / EQD2 に対応する PS3.16 の
 * 標準コードは手元で確認できていない</b>。ここで「それらしい標準コード」を書くと、
 * 受け側は標準コードとして解釈するので、<b>誤った標準コードは、標準コードが無いことより有害</b>である
 * （{@code MeasurementReportService} の冒頭に書いた方針と同じ）。
 *
 * <p>そこで確認できないものは <b>私用コーディングスキーム {@value #PRIVATE_SCHEME}</b> で書く。
 * 私用であることが designator から明白なので、受け側が標準コードと取り違えることはない。
 * DICOM の要求どおり {@code CodingSchemeIdentificationSequence} も併せて書く
 * （{@link MeasurementReportService} が、私用コードを 1 つでも使ったときだけ付ける）。
 *
 * <p>⚠ <b>PS3.16 の該当コードが確認できたら、この表の 1 行を差し替えるだけで移行できる。</b>
 * 差し替えると既存 SR と新 SR でコードが変わるので、そのときは
 * {@code fw/plugin-architecture.md} に版を書き残すこと。
 *
 * <h3>単位</h3>
 *
 * <p>単位は <b>UCUM</b>（{@code mm} / {@code mL} / {@code Gy} / {@code Bq.s} / {@code h} / {@code g}）。
 * 呼び出し側が単位を明示したらそれを優先する（換算はしない＝値と単位を食い違わせない）。
 */
final class SrMeasurementConcepts {

    private SrMeasurementConcepts() {}

    /** 私用コーディングスキームの designator（DICOM の規則で "99" 始まり）。 */
    static final String PRIVATE_SCHEME = "99GRAPHY";

    /**
     * 私用コーディングスキームの UID。
     *
     * <p>登録済みの OID を持たないので、UUID から導出した {@code 2.25.…}（DICOM PS3.5 B.2 が
     * 認めている採番）を<b>1 度だけ生成して固定</b>してある。値を変えると、過去に出した SR と
     * 同じ私用コードが別スキームに見えるので<b>変更しないこと</b>。
     */
    static final String PRIVATE_SCHEME_UID = "2.25.53431882557562859552419770557916361725";

    static final String PRIVATE_SCHEME_NAME = "GRAPHY-Next private measurement concepts";

    /**
     * 計測種別 1 つ。
     *
     * @param codeValue   CodeValue (0008,0100)
     * @param scheme      CodingSchemeDesignator (0008,0102)
     * @param meaning     CodeMeaning (0008,0104)
     * @param defaultUnit 呼び出し側が単位を指定しなかったときの UCUM 単位
     */
    record Concept(String codeValue, String scheme, String meaning, String defaultUnit) {
        boolean isPrivate() {
            return PRIVATE_SCHEME.equals(scheme);
        }
    }

    private static final Map<String, Concept> TABLE = new LinkedHashMap<>();

    private static void put(String type, Concept c) {
        TABLE.put(type, c);
    }

    static {
        // --- 確認済み（実務で広く使われている SRT。受け側がこの値で長径・短径を判別している）---
        put("longAxis", new Concept("G-A185", "SRT", "Long Axis", "mm"));
        put("shortAxis", new Concept("G-A186", "SRT", "Short Axis", "mm"));

        // --- 標準コードを確認できていないもの（私用スキームで明示的に私用として書く）---
        put("volume", new Concept("VOLUME", PRIVATE_SCHEME, "Volume", "mL"));
        put("mass", new Concept("MASS", PRIVATE_SCHEME, "Mass", "g"));
        put("absorbedDose", new Concept("ABSORBED_DOSE", PRIVATE_SCHEME, "Absorbed Dose", "Gy"));
        put("timeIntegratedActivity",
                new Concept("TIA", PRIVATE_SCHEME, "Time Integrated Activity", "Bq.s"));
        put("effectiveHalfLife", new Concept("T_EFF", PRIVATE_SCHEME, "Effective Half-Life", "h"));
        put("bed", new Concept("BED", PRIVATE_SCHEME, "Biologically Effective Dose", "Gy"));
        put("eqd2", new Concept("EQD2", PRIVATE_SCHEME, "Equivalent Dose in 2 Gy Fractions", "Gy"));
    }

    /** 表に無ければ null（＝呼び出し側が拒否する）。 */
    static Concept of(String type) {
        return type == null ? null : TABLE.get(type);
    }

    /** 受け付ける種別の一覧（エラーメッセージ用）。 */
    static String supportedTypes() {
        return String.join(", ", TABLE.keySet());
    }
}

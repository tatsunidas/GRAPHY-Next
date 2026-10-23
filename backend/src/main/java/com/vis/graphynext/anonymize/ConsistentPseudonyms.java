/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import java.math.BigInteger;
import java.util.HexFormat;
import java.util.Map;

/**
 * 鍵つきハッシュ（{@link PseudonymKey}）から導く、いつ届いても同じ仮名。
 *
 * <p>受信は 1 枚ずつ・別々の関連付け・日をまたいで届くので、1 回の実行の中だけ一貫する乱数の UID
 * （{@code DicomAnonymizerEngine} の既定）では同じ検査がばらける。ここでは元の値と鍵だけから決まる
 * 値を返す。同じ鍵なら再起動しても同じ、別の鍵なら無関係な値になる。
 */
public final class ConsistentPseudonyms {

    /** 患者 ID（LO）の最大長。接頭辞 + 10 桁がこれに収まること。 */
    private static final int PATIENT_ID_MAX = 64;
    private static final int HEX_DIGITS = 10;

    private final PseudonymKey key;

    public ConsistentPseudonyms(PseudonymKey key) {
        this.key = key;
    }

    /** 元の UID → {@code 2.25.<128 ビットの 10 進>}（PS3.5 の UUID 由来 UID。最大 44 文字）。 */
    public String uid(String originalUid) {
        byte[] h = key.hmac("uid", originalUid);
        byte[] b = new byte[16];
        System.arraycopy(h, 0, b, 0, 16);
        return "2.25." + new BigInteger(1, b);
    }

    /** 元の PatientID → 接頭辞 + HMAC 先頭 10 桁（16 進、大文字）。 */
    public String patientId(String originalPatientId, String prefix) {
        String p = prefix == null ? "" : prefix;
        if (p.length() + HEX_DIGITS > PATIENT_ID_MAX) {
            throw new IllegalArgumentException("患者 ID の接頭辞が長すぎます（最大 " + (PATIENT_ID_MAX - HEX_DIGITS) + " 文字）");
        }
        byte[] h = key.hmac("patientId", originalPatientId);
        return p + HexFormat.of().withUpperCase().formatHex(h).substring(0, HEX_DIGITS);
    }

    /** 日付シフトの種。{@link DateShifter#shiftDaysFor} へそのまま渡す（患者ごとの日数は元 PatientID と種で決まる）。 */
    public long dateSeed() {
        byte[] h = key.hmac("dateSeed", "");
        long v = 0;
        for (int i = 0; i < 8; i++) {
            v = (v << 8) | (h[i] & 0xFFL);
        }
        return v;
    }

    /** エンジンの {@code uidMap} に渡す、この仮名を返す Map。 */
    public Map<String, String> uidMap() {
        return new ConsistentUidMap(this);
    }
}

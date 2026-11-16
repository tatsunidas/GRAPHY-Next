/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * dcm4che の findscu / getscu / movescu の出力（と終了コード）を読み、相手の返事を分類する（純関数）。
 *
 * <p>🔴 終了コード 0 は「成功」ではない。相手が a900H・c000H などのエラー status を返しても、
 * ツールは 0 で終わる（0 件に見える原因）。終了コード 2 も原因は様々なので、出力の文言で分ける。
 * 文言は dcm4che 5.34 の実測（{@code src/test/resources/findscu-output/}）に基づく。
 */
public record DimseOutcome(Kind kind, Integer status, String errorComment, String reason) {

    public enum Kind {
        /** 正常に終了（status 0000H。ff01H・b000H の警告を含む）。 */
        OK,
        /** 相手が Q/R のサービス（情報モデル）を受けない。abstract-syntax-not-supported。 */
        SERVICE_REFUSED,
        /** 接続（アソシエーション）を拒否された。A-ASSOCIATE-RJ。 */
        ASSOCIATION_REJECTED,
        /** 接続はできたが、要求の後に応答なく切られた（EOF・A-ABORT・reset）。 */
        DROPPED,
        /** 相手に届かない（接続拒否・到達不能・名前解決）。 */
        UNREACHABLE,
        /** 応答待ちの時間切れ。 */
        TIMEOUT,
        /** 相手がエラーの status を返した（a700H・a801H・a900H・cxxxH など）。 */
        STATUS_ERROR,
        /** 上のどれとも読めなかった。 */
        UNKNOWN
    }

    private static final Pattern RSP = Pattern.compile(
            "C-(?:FIND|GET|MOVE)-RSP\\[pcid=\\d+, status=([0-9a-fA-F]+)H(?:, errorComment=([^\\r\\n\\]]*))?");
    /** A-ASSOCIATE-RQ のダンプの「PC の番号 → 抽象構文（SOP クラス UID）」。 */
    private static final Pattern PC_AS = Pattern.compile("PresentationContext\\[id: (\\d+)\\s+as: ([0-9.]+)");
    /** A-ASSOCIATE-AC のダンプの「PC の番号 → 結果（0=受理、3=抽象構文の拒否、4=転送構文の拒否…）」。 */
    private static final Pattern PC_RESULT = Pattern.compile("PresentationContext\\[id: (\\d+)\\s+result: (\\d+) - ([\\w-]+)");
    private static final Pattern RJ = Pattern.compile(
            "A-ASSOCIATE-RJ\\[result: \\d+ - ([\\w-]+), source: \\d+ - ([\\w-]+), reason: \\d+ - ([\\w-]+)\\]");

    public boolean ok() {
        return kind == Kind.OK;
    }

    /**
     * @param exitCode ツールの終了コード
     * @param output   ツールの出力（標準出力＋標準エラー）
     */
    public static DimseOutcome parse(int exitCode, String output) {
        String out = output == null ? "" : output;

        // 1) 相手の C-xxx-RSP。最後のもの（pending ff00H/ff01H を除く）が最終 status。
        Integer last = null;
        String comment = null;
        boolean sawPending = false;
        Matcher m = RSP.matcher(out);
        while (m.find()) {
            int s = Integer.parseInt(m.group(1), 16);
            if (s == 0xFF00 || s == 0xFF01) {
                sawPending = true;
                continue;
            }
            last = s;
            comment = m.group(2) == null || m.group(2).isBlank() ? null : m.group(2).trim();
        }
        if (last != null) {
            if (last == 0x0000 || last == 0xB000) {
                return new DimseOutcome(Kind.OK, last, null, null);
            }
            return new DimseOutcome(Kind.STATUS_ERROR, last, comment, null);
        }

        // 2) 接続段階の拒否・切断（RSP が 1 つも無いとき）
        Matcher rj = RJ.matcher(out);
        if (rj.find()) {
            return new DimseOutcome(Kind.ASSOCIATION_REJECTED, null, null, rj.group(3));
        }
        // 🔴 Q/R の SOP クラス（Patient Root／Study Root／MWL の FIND・MOVE・GET）の PC が、A-ASSOCIATE-AC で受理されなかった。
        // 相手がそのあと接続を切っても（EOF・Socket closed）、原因は切断ではなく「この AE にその Q/R を許していない」こと
        // （実機: PSP 中継サーバー）。切断の判定より先に見る。保存用の SOP クラスの拒否は、GET でも普通に起きるので見ない。
        String refusedPc = refusedQrContext(out);
        if (refusedPc != null) {
            return new DimseOutcome(Kind.SERVICE_REFUSED, null, null, refusedPc);
        }
        if (out.contains("NoPresentationContextException") || out.contains("No Presentation Context for Abstract Syntax")) {
            return new DimseOutcome(Kind.SERVICE_REFUSED, null, null, "abstract-syntax-not-supported");
        }
        if (out.contains("A-ABORT") || out.contains("EOFException") || out.contains("Connection reset")
                || out.contains("SocketException")) {
            return new DimseOutcome(Kind.DROPPED, null, null, firstLineWith(out, "EOFException", "A-ABORT", "reset"));
        }
        if (out.contains("SocketTimeoutException") || out.contains("timeout") || out.contains("Timeout")) {
            return new DimseOutcome(Kind.TIMEOUT, null, null, null);
        }
        if (out.contains("ConnectException") || out.contains("NoRouteToHostException")
                || out.contains("UnknownHostException") || out.contains("Connection refused")) {
            return new DimseOutcome(Kind.UNREACHABLE, null, null, firstLineWith(out, "Connection refused", "NoRoute", "Unknown"));
        }

        // 3) status は無いが、正常終了で結果が来ていた（出力が長く最終行が切れた場合など）
        if (exitCode == 0) {
            return new DimseOutcome(Kind.OK, null, null, sawPending ? "status-not-captured" : null);
        }
        return new DimseOutcome(Kind.UNKNOWN, null, null, firstLineWith(out, "findscu:", "getscu:", "movescu:"));
    }

    /** Q/R（検索・取得）の SOP クラスか。Patient Root／Study Root／Patient-Study の FIND・MOVE・GET と、MWL。 */
    private static boolean isQrSopClass(String uid) {
        return uid.startsWith("1.2.840.10008.5.1.4.1.2.") || uid.equals("1.2.840.10008.5.1.4.31");
    }

    /**
     * 出力に A-ASSOCIATE-RQ と -AC のダンプがあれば、Q/R の SOP クラスの PC のうち受理されなかったものの理由
     * （{@code abstract-syntax-not-supported}・{@code transfer-syntaxes-not-supported} など）を返す。無ければ null。
     */
    static String refusedQrContext(String out) {
        java.util.Map<String, String> qrIds = new java.util.HashMap<>();
        Matcher a = PC_AS.matcher(out);
        while (a.find()) {
            if (isQrSopClass(a.group(2))) {
                qrIds.put(a.group(1), a.group(2));
            }
        }
        if (qrIds.isEmpty()) {
            return null;
        }
        Matcher r = PC_RESULT.matcher(out);
        while (r.find()) {
            if (qrIds.containsKey(r.group(1)) && !"0".equals(r.group(2))) {
                return r.group(3);
            }
        }
        return null;
    }

    /**
     * 診断・エラー表示に出してよい行だけを抜く（相手の返事の status・受理/拒否・例外の 1 行目）。
     * 🔴 ツールの出力は DEBUG で応答の中身（患者名・ID など）を含むので、<b>そのまま出さない</b>。
     */
    public static String evidence(String output) {
        if (output == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (String line : output.split("\\r?\\n")) {
            if (EVIDENCE.matcher(line).find()) {
                String t = line.replaceFirst("^\\d\\d:\\d\\d:\\d\\d\\.\\d+\\s+\\w+\\s+-\\s+", "").trim();
                if (t.length() > 220) {
                    t = t.substring(0, 220);
                }
                if (sb.indexOf(t) < 0) {
                    sb.append(t).append('\n');
                }
            }
        }
        return sb.toString().trim();
    }

    private static final Pattern EVIDENCE = Pattern.compile(
            "C-(?:FIND|GET|MOVE)-RSP\\[|result: \\d+ - |A-ASSOCIATE-RJ\\[|A-ABORT|i/o exception|"
                    + "^(?:findscu|getscu|movescu): |Connection refused|NoRouteToHost|UnknownHost");

    private static String firstLineWith(String out, String... needles) {
        for (String line : out.split("\\r?\\n")) {
            for (String n : needles) {
                if (line.contains(n)) {
                    String t = line.trim();
                    return t.length() > 200 ? t.substring(0, 200) : t;
                }
            }
        }
        return null;
    }
}

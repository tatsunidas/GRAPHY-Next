package com.vis.graphynext.dicom;

/**
 * C-ECHO（Verification）の結果。
 *
 * @param success    疎通成功なら true
 * @param status     DIMSE ステータスコード（成功時 0x0000）。失敗時は -1。
 * @param elapsedMs  接続〜応答までの経過ミリ秒
 * @param message    人間可読のメッセージ（成功/失敗理由）
 */
public record EchoResult(boolean success, int status, long elapsedMs, String message) {

    public static EchoResult ok(int status, long elapsedMs) {
        return new EchoResult(true, status, elapsedMs, "C-ECHO succeeded");
    }

    public static EchoResult failure(long elapsedMs, String message) {
        return new EchoResult(false, -1, elapsedMs, message);
    }
}

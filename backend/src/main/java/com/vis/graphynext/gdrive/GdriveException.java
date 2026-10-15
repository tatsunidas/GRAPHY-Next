/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

/** Drive 呼び出しの失敗。{@link Kind} が呼び出し側の振る舞い（再試行する／止める）を決める。 */
public class GdriveException extends Exception {

    public enum Kind {
        /** 接続断・タイムアウト・429・5xx。時間を置いて再試行する。 */
        RETRY,
        /** 接続できない（ネットワーク）。キュー全体を止めて次の周期で再開する。 */
        OFFLINE,
        /** refresh token が失効・取り消し。再ログインが要る。 */
        RELOGIN,
        /** 容量超過。利用者の対応が要る（無限に叩かない）。 */
        QUOTA,
        /** 権限なし。その項目だけ止め、Drive 側には触れない。 */
        BLOCKED,
        /** 相手が無い（404）。 */
        NOT_FOUND,
        /** その他の恒久的な失敗（400 など）。 */
        FATAL
    }

    private final Kind kind;
    private final int status;

    public GdriveException(Kind kind, int status, String message) {
        super(message);
        this.kind = kind;
        this.status = status;
    }

    public GdriveException(Kind kind, String message, Throwable cause) {
        super(message, cause);
        this.kind = kind;
        this.status = 0;
    }

    public Kind kind() {
        return kind;
    }

    public int status() {
        return status;
    }
}

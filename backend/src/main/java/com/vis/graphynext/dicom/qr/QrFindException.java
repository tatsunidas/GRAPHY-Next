/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import java.io.IOException;

/**
 * 相手との C-FIND／C-GET／C-MOVE が、成功と読めなかったときの例外（{@link DimseOutcome} を持つ）。
 * {@link IOException} の子なので、従来どおり {@code IOException} を捕まえる呼び出し側もそのまま動く。
 */
public class QrFindException extends IOException {

    private final transient DimseOutcome outcome;

    public QrFindException(String what, DimseOutcome outcome, String tail) {
        super(what + " 失敗 (" + outcome.kind()
                + (outcome.status() != null ? String.format(" status=%04XH", outcome.status()) : "")
                + (outcome.errorComment() != null ? " " + outcome.errorComment() : "")
                + (outcome.reason() != null ? " " + outcome.reason() : "") + ")"
                + (tail == null || tail.isBlank() ? "" : ": " + tail));
        this.outcome = outcome;
    }

    public DimseOutcome outcome() {
        return outcome;
    }
}

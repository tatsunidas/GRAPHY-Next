/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

/**
 * Jupyter Server との通信の失敗。{@link #status()} は HTTP の状態コード（通信自体の失敗なら 0）。
 */
public class JupyterException extends RuntimeException {

    private final int status;

    public JupyterException(String message, int status) {
        super(message);
        this.status = status;
    }

    public JupyterException(String message, Throwable cause) {
        super(message, cause);
        this.status = 0;
    }

    public int status() {
        return status;
    }
}

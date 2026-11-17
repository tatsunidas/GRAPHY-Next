/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

/** プロセスを終える。テストで差し替えるために分けてある。 */
public interface ProcessExiter {
    void exit(int code);
}

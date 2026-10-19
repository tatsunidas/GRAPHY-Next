/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.concurrent.Callable;
import java.util.concurrent.locks.ReentrantLock;

/**
 * RadiomicsJ のプロセス広域の static を守るロック。
 *
 * <p>RadiomicsJ は設定（ビン数・delta・GLAM のパラメータ・補間の方式）と途中結果
 * （{@code RadiomicsJ.discretiseImp}）を static に持ち、特徴クラスは窓ごとのコンストラクタで
 * それを読む。{@code new RadiomicsJ()} は {@code resetSettings()} を呼ぶ。だから ROI の一括抽出と
 * マップ・GLAM 解析・リサンプリングが並行すると、互いの設定で黙って違う値を出す。
 * RadiomicsJ を呼ぶ経路はすべてここを通す。再入できる。
 */
final class RadiomicsLock {

    private static final ReentrantLock LOCK = new ReentrantLock();

    private RadiomicsLock() {}

    static <T> T call(Callable<T> body) throws Exception {
        LOCK.lock();
        try {
            return body.call();
        } finally {
            LOCK.unlock();
        }
    }

    /** 検査済み例外を投げない本体用。 */
    static <T> T get(java.util.function.Supplier<T> body) {
        LOCK.lock();
        try {
            return body.get();
        } finally {
            LOCK.unlock();
        }
    }
}

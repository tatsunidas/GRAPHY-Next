/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

/**
 * マップ計算の進み具合の受け口。
 *
 * <p>{@link #update} から例外を投げると計算はそこで打ち切られる。ジョブのキャンセルはこれで行う。
 */
@FunctionalInterface
public interface TextureProgress {

    /** 何も見ていない受け口。 */
    TextureProgress NONE = (done, total) -> { };

    /**
     * @param slicesDone  終わったスライス数
     * @param slicesTotal このマップが覆うスライス数
     */
    void update(int slicesDone, int slicesTotal);
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import java.nio.file.Path;
import java.util.Collection;
import java.util.function.BooleanSupplier;

/**
 * 保管庫の「手元に無いファイルを取り寄せる」側の契約（モード A: 正本は Drive、手元は容量上限つきのキャッシュ）。
 * {@link StorageLayout#resolveForRead} が呼ぶ。相対パスは保管庫ルートからの {@code /} 区切り（索引の値と同じ形）。
 *
 * <p>既定は何もしない {@link #NONE}（モード B・Drive なし）。実装は {@code gdrive.GdriveSyncService}。
 */
public interface StorageBackend {

    /** 手元が上限つきのキャッシュで、無いファイルを取り寄せられるモードか。 */
    boolean cacheMode();

    /**
     * 手元に無ければ取り寄せて、そのパスを返す。このバックエンドが知らないファイル（追い出されていない・未登録）は null。
     * 取り寄せに失敗したら {@link StorageUnavailableException}（null にしない）。
     */
    Path ensureLocal(String relPath);

    /** 複数をまとめて先に取り寄せる（並列）。1 件でも失敗すれば {@link StorageUnavailableException}。取り消されたら途中で止める。 */
    void prefetch(Collection<String> relPaths, BooleanSupplier cancelled);

    /** 読まれた（追い出しの順序に使う）。安い呼び出しであること。 */
    void touch(String relPath);

    StorageBackend NONE = new StorageBackend() {
        @Override
        public boolean cacheMode() {
            return false;
        }

        @Override
        public Path ensureLocal(String relPath) {
            return null;
        }

        @Override
        public void prefetch(Collection<String> relPaths, BooleanSupplier cancelled) {
        }

        @Override
        public void touch(String relPath) {
        }
    };
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.dcm4che3.data.Attributes;

import java.io.IOException;
import java.util.List;

/**
 * 匿名化の入力元。standalone はローカルファイル、web は PACS（WADO-RS）。
 * 匿名化の本体（{@link AnonymizeService}）は読み元に依らず、この interface だけを見る。
 */
public interface AnonymizeSource {

    /** 匿名化の対象 1 枚。{@code patientId} は元の PatientID（患者ごとの新 ID の割り当てに使う）。 */
    record Item(String studyUid, String seriesUid, String sopUid, String patientId) {
    }

    /**
     * 開いた 1 枚。{@code dataset} の PixelData は元ファイルを指す BulkData 参照（URI）なので、
     * <b>{@link #close()} までは読み元のファイルが残っている</b>。
     */
    record Opened(Attributes dataset, String transferSyntax, AutoCloseable closer) implements AutoCloseable {

        @Override
        public void close() {
            if (closer == null) {
                return;
            }
            try {
                closer.close();
            } catch (Exception ignored) {
                // 後始末の失敗で匿名化の結果を変えない（一時ファイルは OS の一時領域にあり、次回起動でも消える）
            }
        }
    }

    /** 対象がそもそも取り出せない（ファイルが無い等）。{@code errors} に載せる文言は呼び出し側が決める。 */
    class Missing extends IOException {
        public Missing(String message) {
            super(message);
        }
    }

    List<Item> list();

    Opened open(Item item) throws IOException;
}

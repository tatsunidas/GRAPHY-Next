/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import java.util.List;

/**
 * 施設が配る「資料パネル」の内容（検証を通したあとの構造）。リンク集とカード（参照の本文）をグループに入れ子にしたもの。
 * <b>患者情報を持たない</b>（施設の固定の文字列だけ）。{@code notices}（時刻指定の掲示）は別の段で足す。
 */
public record FacilityConfig(String title, String updatedAt, String contact, List<Group> groups) {

    /** グループ。{@code items} と下位の {@code groups} は空でもよい（null にはしない）。 */
    public record Group(String id, String title, List<Item> items, List<Group> groups) {
    }

    /**
     * 項目。{@code type} は {@code link}（{@code url} が必須）か {@code card}（{@code body} が必須）。
     * {@code id} は設定にあればそれ、無ければ「グループ id.番号」（画面の識別用）。
     */
    public record Item(String id, String type, String title, String url, String note, String body) {
    }
}

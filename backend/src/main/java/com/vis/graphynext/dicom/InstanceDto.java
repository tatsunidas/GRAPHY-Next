/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

/**
 * インスタンス一覧の 1 行（standalone=H2 / web=QIDO 共通）。
 *
 * <p>{@code transferSyntaxUid} は「Cornerstone で復号できない包み方か」をフロントが判断するために出す。
 * SOP クラスだけでは足りない——**US Multi-frame は SOP クラス上ふつうの画像だが、転送構文が
 * H.264 だと画素を持たず、2D ビューアで開くと黙って真っ黒になる**（{@code seriesRenderable.ts}）。
 * standalone は索引が持っている値をそのまま返す。web(QIDO) は AvailableTransferSyntaxUID が
 * 返ってこないことが普通なので **null 可**。
 */
public record InstanceDto(String sopInstanceUid, Integer instanceNumber, String sopClassUid,
                          String transferSyntaxUid) {
}

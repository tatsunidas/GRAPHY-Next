/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * プラグインが書く XA GSPS の要求（host API の H38 ／ {@code fw/angio-design.md} §22.3 の G4）。
 *
 * <p>{@link AngioPluginSrRequest} と同じ作り——中身も書き手も本体の経路と<b>同一</b>で、
 * 違うのは<b>出所の記録が必須</b>なことだけ。経路を分けたのも同じ理由で、既存の record に
 * {@code producer} を足すと本体経路では常に null になり、<b>「付け忘れ」と「本体が書いた」の
 * 区別が型から消える</b>。
 *
 * @param producer     出所（プラグイン id・表示名・版）。<b>必須</b>
 * @param presentation 表示状態そのもの。{@code studyInstanceUid} は本体（フロント）が入れる
 */
public record AngioPluginPresentationRequest(
        AngioPluginSrRequest.Producer producer,
        AngioPresentationRequest presentation) {
}

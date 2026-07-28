/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import java.time.Instant;

/**
 * 「どの製品のどのバージョンの更新通知を、いつ・何通送ったか」の記録。
 *
 * <p>{@code (product, version)} を主キーにすることで、同じリリースの通知を二度送らないことを
 * DBの一意制約として保証する。配信のトリガーは cron（{@code auto-deploy.sh}）で、リトライや
 * 手動再実行が普通に起こりうるため、「送ったかどうか」をアプリのメモリやログに頼ると
 * 同じ人に何通も届く事故になる。
 *
 * @param product        購読対象トークン（{@link SubscriptionProduct#token()}）
 * @param version        リリースのバージョン（タグ名から {@code v} を除いたもの）
 * @param startedAt      配信を開始した時刻（＝この行を確保した時刻）
 * @param finishedAt     配信が終わった時刻。処理中・異常終了時は null
 * @param recipientCount 送信を試みた宛先数
 * @param failedCount    送信に失敗した宛先数
 */
public record AnnouncementDelivery(
        String product,
        String version,
        Instant startedAt,
        Instant finishedAt,
        int recipientCount,
        int failedCount) {
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import org.junit.jupiter.api.Test;

import java.util.EnumSet;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 購読対象トークンの解釈。ここに入る値はサイト側の登録フォーム（別リポジトリ vis-ionary-web）から
 * 渡ってくるため、想定外の値が来ても「誰にも届かない」状態にならないことを確認する。
 */
class SubscriptionProductTest {

    @Test
    void parse_readsCommaSeparatedTokens() {
        assertEquals(EnumSet.of(SubscriptionProduct.GRAPHY), SubscriptionProduct.parse("graphy"));
        assertEquals(EnumSet.of(SubscriptionProduct.GRAPHY_NEXT),
                SubscriptionProduct.parse("graphy-next"));
        assertEquals(SubscriptionProduct.all(), SubscriptionProduct.parse("graphy,graphy-next"));
        assertEquals(SubscriptionProduct.all(), SubscriptionProduct.parse(" graphy , graphy-next "));
    }

    @Test
    void parse_fallsBackToAllWhenNothingUsableIsGiven() {
        // 未指定・空・未知トークンのみ、のいずれも「全製品」に倒す。絞り込みに失敗した結果として
        // 通知が誰にも届かなくなると、登録者からは無反応にしか見えず不具合に気づけない。
        assertEquals(SubscriptionProduct.all(), SubscriptionProduct.parse(null));
        assertEquals(SubscriptionProduct.all(), SubscriptionProduct.parse(""));
        assertEquals(SubscriptionProduct.all(), SubscriptionProduct.parse("   "));
        assertEquals(SubscriptionProduct.all(), SubscriptionProduct.parse("nonexistent-product"));
    }

    @Test
    void parse_ignoresUnknownTokensMixedWithKnownOnes() {
        assertEquals(EnumSet.of(SubscriptionProduct.GRAPHY),
                SubscriptionProduct.parse("graphy,something-else"));
    }

    @Test
    void join_isStableAndRoundTrips() {
        assertEquals("graphy,graphy-next", SubscriptionProduct.join(SubscriptionProduct.all()));
        assertEquals("graphy,graphy-next", SubscriptionProduct.allTokens());
        assertEquals(SubscriptionProduct.all(),
                SubscriptionProduct.parse(SubscriptionProduct.allTokens()));
    }
}

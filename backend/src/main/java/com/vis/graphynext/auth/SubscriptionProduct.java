/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 更新通知を受け取る対象の製品。
 *
 * <p>GRAPHY（Java Swing 版）と GRAPHY-Next（Web 版）はリリースが独立しているため、
 * 片方にしか興味のない登録者へもう片方の通知を送らないよう、購読対象を持たせている。
 *
 * <p>トークン文字列（{@code graphy} / {@code graphy-next}）は、
 * graphy.vis-ionary.com の登録フォーム → {@code subscribe.php} → {@code POST /subscribe} と
 * リポジトリ間で受け渡され、DBにもこの形で保存される。<b>変更すると既存データと登録フォームの
 * 両方が壊れる</b>ので、増やすことはあっても既存の値は変えないこと。
 */
public enum SubscriptionProduct {

    /** GRAPHY（Java Swing 版・リポジトリ tatsunidas/GRAPHY）。 */
    GRAPHY("graphy"),

    /** GRAPHY-Next（Web / Electron 版・リポジトリ tatsunidas/GRAPHY-Next）。 */
    GRAPHY_NEXT("graphy-next");

    private final String token;

    SubscriptionProduct(String token) {
        this.token = token;
    }

    public String token() {
        return token;
    }

    public static Optional<SubscriptionProduct> fromToken(String token) {
        return Arrays.stream(values())
                .filter(p -> p.token.equals(token))
                .findFirst();
    }

    /** 全製品。購読対象が特定できない登録（既存データ・製品指定なしの登録）に使う。 */
    public static Set<SubscriptionProduct> all() {
        return EnumSet.allOf(SubscriptionProduct.class);
    }

    /**
     * {@code "graphy,graphy-next"} 形式を解釈する。
     * 未知のトークンは無視し、結果が空になる場合は {@link #all()} を返す
     * （購読対象が分からないまま「どれにも送らない」状態にしてしまうと、
     * 登録した本人には通知が来ない理由が分からず、事故に気づけないため）。
     */
    public static Set<SubscriptionProduct> parse(String csv) {
        if (csv == null || csv.isBlank()) {
            return all();
        }
        Set<SubscriptionProduct> parsed = Arrays.stream(csv.split(","))
                .map(String::trim)
                .map(SubscriptionProduct::fromToken)
                .flatMap(Optional::stream)
                .collect(Collectors.toCollection(() -> EnumSet.noneOf(SubscriptionProduct.class)));
        return parsed.isEmpty() ? all() : parsed;
    }

    /** DBに保存する形（列挙順で安定させ、比較・目視確認をしやすくする）。 */
    public static String join(Set<SubscriptionProduct> products) {
        return products.stream()
                .sorted()
                .map(SubscriptionProduct::token)
                .collect(Collectors.joining(","));
    }

    /** {@link #join(Set)} が既定値として使う全製品の文字列（DDLのDEFAULTと揃える）。 */
    public static String allTokens() {
        return join(Collections.unmodifiableSet(all()));
    }
}

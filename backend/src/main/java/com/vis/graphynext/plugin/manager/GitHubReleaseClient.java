/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import java.util.List;

/**
 * GitHub Releases 取得の継ぎ目（テストでモック可能にするためのインターフェース）。
 * 実装は {@link HttpGitHubReleaseClient}（JDK の {@code java.net.http.HttpClient}）。
 */
public interface GitHubReleaseClient {

    /**
     * {@code owner/repo} のリリース一覧（新しい順は保証しない）。
     *
     * @param token private リポジトリ用のトークン（null なら未認証＝公開のみ）
     */
    List<Release> listReleases(String repo, String token);

    /** 資産バイナリを取得する。 */
    byte[] download(String url, String token);

    /** リリース。 */
    record Release(String tagName, String name, String body, String publishedAt,
                   boolean prerelease, List<Asset> assets) {}

    /**
     * リリース資産。
     *
     * @param apiUrl            API 経由 URL（private の取得は Accept: application/octet-stream ＋トークン）
     * @param browserUrl        公開ダウンロード URL
     */
    record Asset(String name, String apiUrl, String browserUrl, long size) {}
}

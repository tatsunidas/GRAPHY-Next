/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 共有の閲覧者に許す経路（許可リスト）と、そこから取り出す検査の手がかり。
 *
 * <p>許すのは <b>GET の 3 系統だけ</b>: スタディ配下のシリーズ・インスタンスの読み出し、SOP 指定の画像、
 * 共有の概要。ここに無い経路（一覧・設定・送信・書き込み・タグ表示を含む）は、存在しないものとして扱う。
 * 将来経路を足すときは、ここに 1 行足し、<b>検査 UID を必ず取り出せる形</b>にすること（取り出せない経路は認可できない）。
 *
 * <p>パスは<b>生の URI</b>で判定し、UID と数字以外の文字・{@code %}・{@code ..}・{@code //}・末尾の {@code /} は
 * 正規化の食い違い（二重エンコードなど）を避けるため一律で拒否する。
 */
final class ShareRoutes {

    enum Kind {
        /** パスに検査 UID がある。 */
        STUDY,
        /** パスに SOP UID がある（検査は台帳から引く）。 */
        INSTANCE,
        /** 共有の概要（認可は Cookie の許可範囲そのもの）。 */
        SHARE_INFO
    }

    record Route(Kind kind, String studyUid, String sopUid) {
    }

    private static final String UID = "([0-9.]{1,64})";
    private static final String NUM = "[0-9]{1,6}";
    private static final Pattern SAFE_PATH = Pattern.compile("/[A-Za-z0-9._/-]*");

    private static final Pattern STUDY_ROUTE = Pattern.compile(
            "/api/studies/" + UID + "/series"
                    + "(?:/" + UID + "/(?:layout|blank/file|instances"
                    + "|instances/" + UID + "/file"
                    + "|instances/" + UID + "/frames/" + NUM + "/file))?");
    private static final Pattern INSTANCE_ROUTE = Pattern.compile(
            "/api/instances/" + UID + "/(?:file|frames/" + NUM + "/file)");

    static final String SHARE_INFO_PATH = "/api/share/study";

    private ShareRoutes() {
    }

    static Optional<Route> parse(String method, String uri) {
        if (!"GET".equals(method) || uri == null || uri.length() > 512
                || !SAFE_PATH.matcher(uri).matches()
                || uri.contains("..") || uri.contains("//") || uri.endsWith("/")) {
            return Optional.empty();
        }
        if (uri.equals(SHARE_INFO_PATH)) {
            return Optional.of(new Route(Kind.SHARE_INFO, null, null));
        }
        Matcher m = STUDY_ROUTE.matcher(uri);
        if (m.matches()) {
            return Optional.of(new Route(Kind.STUDY, m.group(1), null));
        }
        m = INSTANCE_ROUTE.matcher(uri);
        if (m.matches()) {
            return Optional.of(new Route(Kind.INSTANCE, null, m.group(1)));
        }
        return Optional.empty();
    }
}

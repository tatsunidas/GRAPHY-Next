/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * findscu の引数を組み立てる（純関数）。{@link FindProfile#DEFAULT} のとき、従来の引数と
 * <b>完全に同じ並び</b>になる（回帰テストで固定）。
 */
public final class FindArgs {

    private FindArgs() {
    }

    /**
     * 解放（A-RELEASE）の応答を待つ上限（ミリ秒）。dcm4che のツールは既定で無期限に待つので、解放に応じない相手
     * （応答は返すのに A-RELEASE-RQ を無視する中継サーバーなど）では、結果を受け取ったあとも終わらない。
     * 3 秒は PSP 実機の実測（3 秒で A-ABORT して終了、終了コード 0）。解放の応答は、通常は即座に返る。
     */
    public static final String RELEASE_TIMEOUT_MS = "3000";

    /** findscu・getscu・movescu に既定で付ける引数。 */
    public static List<String> releaseTimeoutArgs() {
        return List.of("--release-timeout", RELEASE_TIMEOUT_MS);
    }

    /**
     * @param level        {@code PATIENT} / {@code STUDY} / {@code SERIES}
     * @param leadingMatch 返却キーより前に置く照合キー（SERIES 段の StudyInstanceUID など）。null 可
     * @param returnKeys   返却キー（プロファイルの指定があれば呼び出し側で解決済みのもの）
     * @param matchKeys    呼び出し側が与える照合キー（順序を保つ）
     */
    public static List<String> build(String tool, String localAet, String calledAet, String host, int port,
                                     String level, FindProfile profile, Map<String, String> leadingMatch,
                                     List<String> returnKeys, Map<String, String> matchKeys,
                                     String outDir, List<String> tlsArgs) {
        FindProfile p = FindProfile.orDefault(profile);
        List<String> cmd = new ArrayList<>(List.of(
                tool,
                "-b", localAet,
                "-c", calledAet + "@" + host + ":" + port,
                "-L", level));
        cmd.addAll(releaseTimeoutArgs());
        if (p.patientRoot()) {
            cmd.add("-M");
            cmd.add("PatientRoot");
        }
        if ("implicit".equalsIgnoreCase(p.transferSyntax())) {
            cmd.add("--implicit-vr");
        } else if ("explicit".equalsIgnoreCase(p.transferSyntax())) {
            cmd.add("--explicit-vr");
        }
        if (p.responseTimeoutMs() != null && p.responseTimeoutMs() > 0) {
            cmd.add("--response-timeout");
            cmd.add(String.valueOf(p.responseTimeoutMs()));
        }
        if (leadingMatch != null) {
            leadingMatch.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        for (String key : returnKeys) {
            cmd.add("-r");
            cmd.add(key);
        }
        if (matchKeys != null) {
            matchKeys.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        if (p.charset() != null && !p.charset().isBlank()) {
            cmd.add("-m");
            cmd.add("SpecificCharacterSet=" + p.charset());
        }
        cmd.add("--out-dir");
        cmd.add(outDir);
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tlsArgs);
        return cmd;
    }
}

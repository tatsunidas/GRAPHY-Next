/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * プラグインのジョブが作ったファイル（成果物）を、利用者へ渡せるように預かる（host API の H53）。
 *
 * <h3>なぜ要るのか</h3>
 * SPI の {@code GraphyPlugin.run} は JSON にできる値しか返せない。要約した動画（MP4・AVI・DICOM）のような
 * 大きなファイルを base64 で返すのは重すぎる。そこで JAR は<b>一時フォルダにファイルを書き、そのパスを
 * 結果の {@value #ARTIFACT_KEY} に入れて返す</b>。本体はそれをここへ移し、
 * {@code GET /api/plugin-jobs/{jobId}/artifact} で配る。
 *
 * <h3>🔴 受け取るのは OS の一時フォルダの下のファイルだけ</h3>
 * パスはプラグインが決めるので、任意のファイル（患者データ・設定・鍵）を持ち出させないよう、
 * {@code java.io.tmpdir} の下にある<b>普通のファイル</b>（シンボリックリンクでない）に限る。
 * 受け取ったら<b>移動</b>する（元の場所には残らない）。24 時間で消す。
 */
@Component
public class PluginArtifacts {

    private static final Logger log = LoggerFactory.getLogger(PluginArtifacts.class);

    /** 結果の中の成果物のキー（プラグインが返すときはファイルの絶対パス）。 */
    public static final String ARTIFACT_KEY = "__artifact";
    /** 利用者に見せるファイル名の候補（任意）。 */
    public static final String ARTIFACT_NAME_KEY = "__artifactName";

    private static final long TTL_MS = 24L * 60 * 60 * 1000;
    private static final Pattern SAFE_NAME = Pattern.compile("[^A-Za-z0-9._\\-]");

    private final Path root;
    private final Path tmp;

    public PluginArtifacts() {
        this(Path.of(System.getProperty("java.io.tmpdir")));
    }

    PluginArtifacts(Path tmpDir) {
        this.tmp = realOrSelf(tmpDir);
        this.root = this.tmp.resolve("graphy-plugin-artifacts");
    }

    /** 成果物の外向きの姿（結果の {@value #ARTIFACT_KEY} をこれに差し替える）。 */
    public record Artifact(String jobId, String name, long size) {
    }

    /**
     * ジョブの結果に成果物のパスがあれば預かり、結果の {@value #ARTIFACT_KEY} を {@link Artifact} に差し替える。
     * 無ければ結果をそのまま返す。受け取れないパスなら例外（ジョブは失敗になる）。
     */
    public Object adopt(String jobId, Object result) throws IOException {
        if (!(result instanceof Map<?, ?> m) || !(m.get(ARTIFACT_KEY) instanceof String pathText)) return result;
        Path src = Path.of(pathText).toAbsolutePath().normalize();
        if (!Files.isRegularFile(src, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("成果物が見つかりません: " + src.getFileName());
        }
        Path real = src.toRealPath();
        if (!real.startsWith(tmp) || real.startsWith(root)) {
            throw new IOException("成果物は一時フォルダの下のファイルに限ります");
        }
        String name = m.get(ARTIFACT_NAME_KEY) instanceof String n && !n.isBlank() ? n : real.getFileName().toString();
        Path dst = place(jobId, name);
        Files.move(real, dst, StandardCopyOption.REPLACE_EXISTING);
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : m.entrySet()) {
            String k = String.valueOf(e.getKey());
            if (!ARTIFACT_NAME_KEY.equals(k)) out.put(k, e.getValue());
        }
        out.put(ARTIFACT_KEY, new Artifact(jobId, dst.getFileName().toString(), Files.size(dst)));
        log.info("[plugins] artifact of job {}: {} ({} bytes)", jobId, dst.getFileName(), Files.size(dst));
        return out;
    }

    /** 本体が作る成果物の置き場（例: H54 の DICOM ファイル）。既にあれば置き換える。 */
    public Path place(String jobId, String name) throws IOException {
        sweep();
        Path dir = root.resolve(safe(jobId));
        Files.createDirectories(dir);
        return dir.resolve(safe(name));
    }

    /** 預かっている成果物（ジョブにつき 1 つ）。 */
    public Optional<Path> find(String jobId) {
        Path dir = root.resolve(safe(jobId));
        if (!Files.isDirectory(dir)) return Optional.empty();
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(Files::isRegularFile).findFirst();
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    /** 24 時間より古い成果物を消す。 */
    void sweep() {
        if (!Files.isDirectory(root)) return;
        long now = System.currentTimeMillis();
        try (DirectoryStream<Path> dirs = Files.newDirectoryStream(root)) {
            for (Path d : dirs) {
                try {
                    if (now - Files.getLastModifiedTime(d).toMillis() > TTL_MS) deleteTree(d);
                } catch (IOException e) {
                    log.debug("[plugins] artifact sweep skipped {}: {}", d, e.toString());
                }
            }
        } catch (IOException e) {
            log.debug("[plugins] artifact sweep failed: {}", e.toString());
        }
    }

    private static void deleteTree(Path d) throws IOException {
        try (Stream<Path> w = Files.walk(d)) {
            for (Path p : w.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
        }
    }

    private static String safe(String s) {
        String t = SAFE_NAME.matcher(s == null ? "" : s).replaceAll("_");
        if (t.isBlank() || t.equals(".") || t.equals("..")) return "artifact";
        return t.length() > 120 ? t.substring(t.length() - 120) : t;
    }

    private static Path realOrSelf(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }
}

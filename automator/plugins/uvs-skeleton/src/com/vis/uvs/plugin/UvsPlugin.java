package com.vis.uvs.plugin;

import com.vis.graphynext.plugin.spi.GraphyPlugin;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.CodeSource;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * UVS（胎児心エコー動画要約）の骨組み — {@code fw/uvs-plugin-design.md} の段 2。
 *
 * <p>🔴 <b>解析はまだしない。</b> ここで答えるのは「<b>この先の段で必要なものが、
 * プラグインの JAR から実際に手が届くか</b>」だけである。
 *
 * <p><b>なぜ先にこれを確かめるのか</b>: 本体側に JAR 面のプラグインの実例が無く
 * （社外のデモ 1 本だけ）、設計は「親クラスローダから本体の依存が見える」という前提の上に
 * 立っている。**前提が外れていたら設計をやり直す**ので、解析を書く前に確定させる。
 *
 * <p>⚠️ <b>答えを推測で埋めない。</b> 「たぶん見える」ではなく、実際に
 * {@code Class.forName} して<b>版数の文字列</b>を返す。見えなければ理由をそのまま返す。
 */
public class UvsPlugin implements GraphyPlugin {

    @Override
    public Object run(Map<String, Object> args) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("note", "これは疎通確認であって解析ではない（fw/uvs-plugin-design.md 段 2）");
        out.put("args", args == null ? Map.of() : args);
        out.put("java", System.getProperty("java.version"));

        // ── 1. 親クラスローダから本体の依存が見えるか ────────────────
        //     🔴 設計 §2.2 の前提そのもの。RadiomicsJ の**版**が要点。
        out.put("radiomicsj", probeClass("io.github.tatsunidas.radiomics.main.RadiomicsJ"));
        out.put("imagej", probeClass("ij.process.ByteProcessor"));
        out.put("dcm4che", probeClass("org.dcm4che3.data.Attributes"));

        // ── 2. 自分のフォルダのファイルを読めるか ────────────────────
        //     🔑 読めるなら、モデルのパラメータは ui.js に埋めずここから読める（設計の判断）。
        out.put("pluginDir", probePluginDir());

        // ── 3. ffmpeg の実体を解決できるか ──────────────────────────
        //     フレーム供給の土台。本体が同梱している（fw/nondicom-ffmpeg.md）。
        out.put("ffmpeg", probeFfmpeg());

        // ── 4. 自分の backend の /rendered から MP4 を取れるか ───────
        //     段 3 のフレーム供給の経路。⚠️ ポートは呼び出し側から渡してもらう。
        out.put("rendered", probeRendered(args));

        return out;
    }

    /** クラスが見えるか＋どこから来たか＋版。見えなければ理由を返す。 */
    private Map<String, Object> probeClass(String fqcn) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("class", fqcn);
        try {
            Class<?> c = Class.forName(fqcn, false, getClass().getClassLoader());
            r.put("visible", true);
            Package p = c.getPackage();
            r.put("implementationVersion", p == null ? null : p.getImplementationVersion());
            r.put("specificationVersion", p == null ? null : p.getSpecificationVersion());
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            // 🔑 **どの jar から来たかが分かれば、版が package に無くてもファイル名で判る。**
            r.put("codeSource", cs == null || cs.getLocation() == null ? null : cs.getLocation().toString());
            r.put("classLoader", String.valueOf(c.getClassLoader()));
        } catch (Throwable t) {
            r.put("visible", false);
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    /** 自分（この JAR）が置かれているフォルダと、その中身。 */
    private Map<String, Object> probePluginDir() {
        Map<String, Object> r = new LinkedHashMap<>();
        try {
            CodeSource cs = getClass().getProtectionDomain().getCodeSource();
            if (cs == null || cs.getLocation() == null) {
                r.put("resolved", false);
                r.put("error", "CodeSource が取れない");
                return r;
            }
            Path jar = Path.of(cs.getLocation().toURI());
            Path dir = jar.getParent();
            r.put("resolved", true);
            r.put("jar", jar.toString());
            r.put("dir", dir == null ? null : dir.toString());
            List<String> names = new ArrayList<>();
            if (dir != null && Files.isDirectory(dir)) {
                try (var s = Files.list(dir)) {
                    s.forEach(p -> names.add(p.getFileName().toString()));
                }
            }
            r.put("entries", names);
            // 🔑 モデルのパラメータをここから読めるか（段 5 で本当に読む）。
            Path params = dir == null ? null : dir.resolve("reference-params.json");
            if (params != null && Files.isReadable(params)) {
                String body = Files.readString(params);
                r.put("referenceParamsBytes", body.length());
                r.put("referenceParamsHead", body.substring(0, Math.min(60, body.length())));
            } else {
                r.put("referenceParamsBytes", 0);
            }
        } catch (Throwable t) {
            r.put("resolved", false);
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    /**
     * ffmpeg を解決して版を得る。
     *
     * <p>⚠️ 本体の解決順（設定 → 環境変数 → 同梱 → PATH）を**そのまま呼べるとは限らない**ので、
     * ここでは「同梱の場所を探す」「PATH にあるか」を**素朴に**見る。
     * 本番では本体の口を使うべきで、それが無ければ**それ自体が段 2 の成果**（穴の発見）。
     */
    private Map<String, Object> probeFfmpeg() {
        Map<String, Object> r = new LinkedHashMap<>();
        List<String> tried = new ArrayList<>();
        for (String cand : new String[]{
                System.getProperty("graphy.ffmpeg", ""),
                System.getenv("GRAPHY_FFMPEG") == null ? "" : System.getenv("GRAPHY_FFMPEG"),
                "ffmpeg",
        }) {
            if (cand == null || cand.isBlank()) continue;
            tried.add(cand);
            try {
                Process p = new ProcessBuilder(cand, "-version").redirectErrorStream(true).start();
                String first;
                try (InputStream in = p.getInputStream()) {
                    first = new String(in.readAllBytes()).lines().findFirst().orElse("");
                }
                p.waitFor();
                if (p.exitValue() == 0) {
                    r.put("resolved", true);
                    r.put("path", cand);
                    r.put("version", first);
                    r.put("tried", tried);
                    return r;
                }
            } catch (Throwable ignored) {
                /* 次の候補へ */
            }
        }
        r.put("resolved", false);
        r.put("tried", tried);
        r.put("note", "本体の解決順（fw/nondicom-ffmpeg.md）を JAR から呼ぶ口が要るかもしれない");
        return r;
    }

    /** `/rendered` から MP4 を取れるか（先頭バイトだけ見る）。 */
    private Map<String, Object> probeRendered(Map<String, Object> args) {
        Map<String, Object> r = new LinkedHashMap<>();
        Object sop = args == null ? null : args.get("sopInstanceUid");
        Object port = args == null ? null : args.get("httpPort");
        if (sop == null) {
            r.put("attempted", false);
            r.put("reason", "sopInstanceUid が渡されていない");
            return r;
        }
        int p = 8080;
        if (port instanceof Number n) p = n.intValue();
        String url = "http://127.0.0.1:" + p + "/api/instances/" + sop + "/rendered";
        r.put("attempted", true);
        r.put("url", url);
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
            HttpResponse<byte[]> res = http.send(
                    HttpRequest.newBuilder(URI.create(url))
                            .header("Range", "bytes=0-15")
                            .timeout(Duration.ofSeconds(30))
                            .GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            r.put("status", res.statusCode());
            r.put("contentType", res.headers().firstValue("content-type").orElse(null));
            byte[] b = res.body();
            r.put("bytes", b.length);
            // MP4 は先頭 4 バイトのサイズ後に "ftyp"。
            boolean ftyp = b.length >= 8
                    && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p';
            r.put("looksLikeMp4", ftyp);
        } catch (Throwable t) {
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }
}

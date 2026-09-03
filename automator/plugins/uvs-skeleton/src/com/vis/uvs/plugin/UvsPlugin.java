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

        // ── 5. [A] 色判定 / [B] 静止判定（段 3）─────────────────────
        //     `analyze: true` のときだけ走らせる。疎通確認と解析を混ぜない。
        if (Boolean.TRUE.equals(args == null ? null : args.get("analyze"))) {
            out.put("analysis", analyze(args, out));
        }

        return out;
    }

    /**
     * [A] 色判定 / [B] 静止判定を 1 パスで行う（段 3）。
     *
     * <p>🔴 <b>しきい値の判定はここでしない。</b> 生の CPR / MAD を返し、
     * 「カラーか」「静止か」は呼び出し側が決める——**静止のしきい値は動画の由来に依存する**
     * （H.264 化で MAD が系統的に下がる・設計 §7）ので、ここで焼き込むと嘘になる。
     */
    private Map<String, Object> analyze(Map<String, Object> args, Map<String, Object> probes) {
        Map<String, Object> r = new LinkedHashMap<>();
        long t0 = System.currentTimeMillis();
        try {
            String apiBase = String.valueOf(args.get("apiBase"));
            String sop = String.valueOf(args.get("sopInstanceUid"));
            int width = intArg(args, "width", 0);
            int height = intArg(args, "height", 0);
            int limit = intArg(args, "limit", 0);
            if (width <= 0 || height <= 0) {
                r.put("ok", false);
                r.put("error", "width/height が渡されていない（/video-metadata の値を渡すこと）");
                return r;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> ff = (Map<String, Object>) probes.get("ffmpeg");
            String ffmpeg = ff == null ? "ffmpeg" : String.valueOf(ff.get("path"));

            FrameScoring.Points points = new FrameScoring.Points(
                    width, height, FrameScoring.SAMPLING_POINTS, FrameScoring.RANDOM_SEED);

            List<Double> cpr = new ArrayList<>();
            List<Double> mad = new ArrayList<>();
            FrameSource src = FrameSource.fromRendered(apiBase, sop, ffmpeg, width, height);
            try {
                src.forEachPair(limit, (i, pair) -> {
                    cpr.add(FrameScoring.colorPixelRatio(pair[0], points, FrameScoring.COLOR_THRESHOLD));
                    mad.add(FrameScoring.meanAbsDiff(pair[0], pair[1], points, width));
                });
                // 最後のフレームは相手が無い。CPR は自分だけで出せるが、MAD は出せないので
                // 🔴 **元アプリと同じく直前の値を複製する**（逆順比較のバグ B3 を避けた形）。
                if (!mad.isEmpty()) mad.add(mad.get(mad.size() - 1));
            } finally {
                src.close();
            }

            r.put("ok", true);
            r.put("frames", cpr.size());
            r.put("cpr", cpr);
            r.put("mad", mad);
            r.put("samplingPoints", points.count);
            r.put("seed", FrameScoring.RANDOM_SEED);
            r.put("colorThreshold", FrameScoring.COLOR_THRESHOLD);
            r.put("elapsedMs", System.currentTimeMillis() - t0);
        } catch (Throwable t) {
            r.put("ok", false);
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    private static int intArg(Map<String, Object> args, String key, int dflt) {
        Object v = args == null ? null : args.get(key);
        return v instanceof Number n ? n.intValue() : dflt;
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
     * <h3>🔑 本体の解決順を使う（段 2 の反省）</h3>
     * 最初は「設定 → 環境変数 → PATH」を**素朴に**探索していたが、それでは
     * <b>PATH にたまたま入っていた ffmpeg</b> を拾うだけで、**配布物では見つからない**
     * （本体は ffmpeg を同梱していて PATH には置かない・{@code fw/nondicom-ffmpeg.md}）。
     *
     * <p>→ 本体の {@code FfmpegLocator} を**反射で呼ぶ**。親クラスローダから見えるので
     * 素の 2 引数コンストラクタで作れる（Spring の文脈は要らない）。
     *
     * <p>🔴 <b>限界</b>: 管理者が {@code nondicom.ffmpeg} / {@code nondicom.ffmpeg-dir} を
     * <b>設定ファイルで指定していた場合、それはこの経路からは見えない</b>
     * （{@code @Value} の注入は Spring がやる）。同梱探索・環境変数・PATH は同じ順で効く。
     * **設定を尊重するには host API 側に口が要る**——それは別途の課題として記録する。
     */
    private Map<String, Object> probeFfmpeg() {
        Map<String, Object> r = new LinkedHashMap<>();
        String path = null;
        try {
            Class<?> loc = Class.forName(
                    "com.vis.graphynext.nondicom.FfmpegLocator", true, getClass().getClassLoader());
            Object inst = loc.getDeclaredConstructor(String.class, String.class).newInstance("", "");
            path = String.valueOf(loc.getMethod("resolve").invoke(inst));
            r.put("via", "FfmpegLocator（本体の解決順）");
            r.put("configVisible", false); // 上記の限界
        } catch (Throwable t) {
            r.put("via", "fallback");
            r.put("locatorError", t.getClass().getSimpleName() + ": " + t.getMessage());
            path = "ffmpeg";
        }
        r.put("path", path);
        try {
            Process p = new ProcessBuilder(path, "-version").redirectErrorStream(true).start();
            String first;
            try (InputStream in = p.getInputStream()) {
                first = new String(in.readAllBytes()).lines().findFirst().orElse("");
            }
            p.waitFor();
            r.put("resolved", p.exitValue() == 0);
            r.put("version", first);
        } catch (Throwable t) {
            r.put("resolved", false);
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    /** `/rendered` から MP4 を取れるか（先頭バイトだけ見る）。 */
    private Map<String, Object> probeRendered(Map<String, Object> args) {
        Map<String, Object> r = new LinkedHashMap<>();
        Object sop = args == null ? null : args.get("sopInstanceUid");
        Object base = args == null ? null : args.get("apiBase");
        if (sop == null || base == null || String.valueOf(base).isBlank()) {
            r.put("attempted", false);
            // 🔑 **どちらが欠けたのかを出す。** 段 2 では「渡していない」ことに気づくのが遅れた。
            r.put("reason", "sopInstanceUid=" + sop + " apiBase=" + base);
            return r;
        }
        String url = String.valueOf(base) + "/api/instances/" + sop + "/rendered";
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

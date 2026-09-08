package com.vis.uvs.plugin;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

import com.vis.uvs.analysis.AnalysisSettings;

/**
 * 1 本の動画に対する解析セッション — {@code fw/uvs-plugin-design.md} 段 6。
 *
 * <h3>なぜセッションが要るのか</h3>
 * 4,958 フレームの予測は約 16 分かかる。{@code runBackend()} は<b>同期 1 往復</b>で進捗を返せない
 * （SSE が無い）ので、<b>区間に分けて何度も呼ぶ</b>しかない。ところが今までの経路は
 * {@link FrameSource#fromRendered} を呼ぶたびに<b>MP4 を丸ごと落とし直していた</b>——
 * 段 5 は 4 フレームだったので成立していただけで、40 回以上呼ぶ段 6 ではそのままでは使えない。
 *
 * <p>→ <b>MP4 のダウンロードと復号はセッションで 1 回だけ</b>にし、以後の呼び出しは
 * {@code sessionId} だけを持ち回る。呼び出し側（{@code ui.js}）が {@code apiBase} や
 * 寸法を毎回組み立て直さなくて済むので、段 2 で踏んだ「鍵を渡し忘れて黙って空が返る」型の
 * 事故も減る。
 *
 * <h3>🔴 後始末は 3 経路</h3>
 * ① {@code op:"release"} ② 窓を閉じたとき（{@code ui.js} が release を投げる）
 * ③ {@link #sweepOld} ＝ 次に誰かが {@code run()} を呼んだときに、古い残骸を掃除する。
 * ③ があるので<b>プロセスが落ちても残骸は消える</b>。
 */
public final class UvsSession {

    /** セッションの一時フォルダの接頭辞。{@link #sweepOld} がこの名前で掃除する。 */
    private static final String DIR_PREFIX = "uvs-session-";

    /** 掃除の対象になる古さ（24 時間）。 */
    private static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;

    /**
     * 🚨 <b>H.264 の動画に対する静止判定のしきい値</b>（設計 §7）。
     *
     * <p>Swing 版の既定 {@code 0.5} は <b>AVI（無圧縮系）</b>の値である。H.264 に通すと
     * 隣接フレームの差分が系統的に小さくなり、同じ動画で静止判定が <b>105 → 1,060（10.4 倍）</b>
     * に増えた。{@code /rendered} が返すのは常に MP4 なので、<b>ここでの既定は 0.19</b> にする。
     * 🔴 画面には「圧縮動画向けの値」と明記すること——数字だけ見せると AVI 版と比較されて混乱する。
     */
    public static final float H264_MEAN_ABS_DIFF = 0.19f;

    /** 上の 0.19 が「どの値に相当するか」。画面の説明に使う。 */
    public static final float AVI_EQUIVALENT_MEAN_ABS_DIFF = AnalysisSettings.DEFAULT_MEAN_ABS_DIFF;

    private static final Map<String, UvsSession> SESSIONS = new ConcurrentHashMap<>();
    private static final AtomicLong SEQ = new AtomicLong();

    /**
     * ffmpeg の実体。<b>解決は 1 度だけ</b>——段 2 の {@code probeFfmpeg} は毎回
     * {@code ffmpeg -version} で子プロセスを起こしていたが、段 6 は 1 回の解析で 40 回以上
     * {@code run()} を呼ぶので、そのたびに起こしていられない。
     */
    private static volatile String ffmpegPath;

    public final String id;
    public final String apiBase;
    public final String sopInstanceUid;
    public final String ffmpeg;

    /** {@code /video-metadata} が返した値（推測しない）。 */
    public final int width;
    public final int height;
    public final int numberOfFrames;
    public final double fps;
    public final String transferSyntaxUid;
    public final boolean transcodeRequired;
    public final boolean transcodeAvailable;

    private volatile Path dir;
    private volatile Path mp4;
    private volatile long lastUsedMs = System.currentTimeMillis();

    private UvsSession(String id, String apiBase, String sop, String ffmpeg, VideoMeta meta) {
        this.id = id;
        this.apiBase = apiBase;
        this.sopInstanceUid = sop;
        this.ffmpeg = ffmpeg;
        this.width = meta.columns;
        this.height = meta.rows;
        this.numberOfFrames = meta.numberOfFrames;
        this.fps = meta.fps;
        this.transferSyntaxUid = meta.transferSyntaxUid;
        this.transcodeRequired = meta.transcodeRequired;
        this.transcodeAvailable = meta.transcodeAvailable;
    }

    // ── 生成・取得・破棄 ────────────────────────────────────────────

    /**
     * セッションを開く。{@code /video-metadata} を<b>この JAR が引く</b>——寸法を
     * {@code ui.js} から渡してもらう形は、渡し忘れると「width/height が無い」で落ちるだけで、
     * 段 3 で実際に一度そうなった。取れるものは自分で取る。
     */
    public static UvsSession open(String apiBase, String sop, ClassLoader loader) throws Exception {
        if (apiBase == null || apiBase.isBlank()) throw new IllegalArgumentException("apiBase が空です");
        if (sop == null || sop.isBlank()) throw new IllegalArgumentException("sopInstanceUid が空です");
        sweepOld();
        VideoMeta meta = fetchVideoMetadata(apiBase, sop);
        if (meta.columns <= 0 || meta.rows <= 0) {
            throw new IllegalStateException(
                    "/video-metadata が寸法を返しませんでした（columns=" + meta.columns + " rows=" + meta.rows + "）");
        }
        String id = "uvs-" + Long.toHexString(System.currentTimeMillis()) + "-" + SEQ.incrementAndGet();
        UvsSession s = new UvsSession(id, apiBase, sop, ffmpeg(loader), meta);
        SESSIONS.put(id, s);
        return s;
    }

    /** 既存のセッション。無ければ null（呼び出し側が「開き直してください」と言う）。 */
    public static UvsSession get(String id) {
        UvsSession s = id == null ? null : SESSIONS.get(id);
        if (s != null) s.lastUsedMs = System.currentTimeMillis();
        return s;
    }

    /** 一時ファイルを消してセッションを閉じる。戻りは解放したバイト数。 */
    public long close() {
        SESSIONS.remove(id);
        Path d = dir;
        dir = null;
        mp4 = null;
        return d == null ? 0L : deleteRecursively(d);
    }

    /**
     * 古いセッションフォルダを掃除する（プロセスが落ちて {@code close()} が呼ばれなかったぶん）。
     *
     * <p>⚠️ <b>生きているセッションのフォルダは消さない。</b> 判定は「24 時間より古い」だけでなく
     * 「この JVM の登録簿に無い」も見る——同じ機械で 2 つの GRAPHY が動いている可能性があるので、
     * 他人のフォルダを消さないよう<b>更新時刻</b>で保守的に判断する。
     */
    public static long sweepOld() {
        Path tmp = Path.of(System.getProperty("java.io.tmpdir", "/tmp"));
        long freed = 0;
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        try (Stream<Path> children = Files.list(tmp)) {
            for (Path p : children.filter(Files::isDirectory)
                    .filter(p -> p.getFileName().toString().startsWith(DIR_PREFIX)).toList()) {
                boolean alive = SESSIONS.values().stream().anyMatch(s -> p.equals(s.dir));
                if (alive) continue;
                if (Files.getLastModifiedTime(p).toMillis() > cutoff) continue;
                freed += deleteRecursively(p);
            }
        } catch (IOException ignored) {
            /* 掃除に失敗しても解析は続けられる */
        }
        return freed;
    }

    // ── 資源 ────────────────────────────────────────────────────────

    /** このセッションの一時フォルダ（MP4 とフレームキャッシュを置く）。 */
    public synchronized Path dir() throws IOException {
        if (dir == null) dir = Files.createTempDirectory(DIR_PREFIX + id + "-");
        return dir;
    }

    /**
     * {@code /rendered} の MP4。<b>セッションで 1 回だけ</b>落とす。
     */
    public synchronized Path mp4() throws Exception {
        if (mp4 != null && Files.exists(mp4)) return mp4;
        Path out = dir().resolve("source.mp4");
        String url = apiBase + "/api/instances/" + sopInstanceUid + "/rendered";
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            HttpResponse<Path> res = http.send(
                    HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMinutes(10)).GET().build(),
                    HttpResponse.BodyHandlers.ofFile(out));
            if (res.statusCode() / 100 != 2) {
                throw new IOException("/rendered が " + res.statusCode() + " を返しました: " + url);
            }
        }
        mp4 = out;
        return out;
    }

    /**
     * ffmpeg の実体を解決する（本体の {@code FfmpegLocator} を反射で呼ぶ）。
     *
     * <p>🔑 解決順は本体に任せる。素朴に PATH を探すと<b>配布物で見つからない</b>
     * （本体は ffmpeg を同梱して PATH には置かない・{@code fw/nondicom-ffmpeg.md}）。
     * 🔴 限界は段 2 と同じ——設定ファイルの {@code nondicom.ffmpeg} はこの経路からは見えない。
     */
    public static String ffmpeg(ClassLoader loader) {
        String cached = ffmpegPath;
        if (cached != null) return cached;
        String path;
        try {
            Class<?> loc = Class.forName("com.vis.graphynext.nondicom.FfmpegLocator", true, loader);
            Object inst = loc.getDeclaredConstructor(String.class, String.class).newInstance("", "");
            path = String.valueOf(loc.getMethod("resolve").invoke(inst));
        } catch (Throwable t) {
            path = "ffmpeg";
        }
        ffmpegPath = path;
        return path;
    }

    // ── 画面へ返す情報 ──────────────────────────────────────────────

    /**
     * 動画の諸元と、そこから導いた既定値。
     *
     * <p>🔴 既定値は<b>ここで導いて画面へ渡す</b>——`ui.js` に散らすと、Java 側の解析と
     * 画面の表示で別の既定が使われる事故になる（設計 §5 の「合成規則は 1 か所」と同じ理由）。
     */
    public Map<String, Object> info() {
        AnalysisSettings d = AnalysisSettings.defaults(fps);
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("sessionId", id);
        r.put("sopInstanceUid", sopInstanceUid);
        r.put("width", width);
        r.put("height", height);
        r.put("numberOfFrames", numberOfFrames);
        r.put("fps", fps);
        r.put("durationSec", fps > 0 ? numberOfFrames / fps : null);
        r.put("transferSyntaxUid", transferSyntaxUid);
        r.put("transcodeRequired", transcodeRequired);
        r.put("transcodeAvailable", transcodeAvailable);
        r.put("ffmpeg", ffmpeg);

        Map<String, Object> defaults = new LinkedHashMap<>();
        defaults.put("interval", d.predictionSamplingInterval());
        defaults.put("stride", strideFrames());
        defaults.put("colorThreshold", d.colorThreshold());
        defaults.put("colorPixelRatioThreshold", d.colorPixelRatioThreshold());
        // 🚨 0.5 ではなく 0.19（設計 §7）。画面はこの値と「圧縮動画向け」の注記をそのまま出す。
        defaults.put("staticMeanAbsDiffThreshold", H264_MEAN_ABS_DIFF);
        defaults.put("staticMeanAbsDiffNote", "compressed"); // ui.js が i18n の鍵に使う
        defaults.put("aviEquivalentMeanAbsDiff", AVI_EQUIVALENT_MEAN_ABS_DIFF);
        defaults.put("predictionThreshold", d.predictionThreshold());
        defaults.put("extractor", d.extractor().name());
        defaults.put("samplingPoints", d.samplingPoints());
        defaults.put("randomSeed", d.randomSeed());
        r.put("defaults", defaults);
        return r;
    }

    /**
     * 差分の相手までの距離（フレーム数）。{@code frameStrideInSeconds} を fps で換算する。
     * 🔴 <b>0 にしない</b>——自分自身との差分は常に 0 になり、全フレームが静止と判定される。
     */
    public int strideFrames() {
        AnalysisSettings d = AnalysisSettings.defaults(fps);
        double f = fps > 0 ? fps : 30.0;
        return Math.max(1, (int) Math.round(f * d.frameStrideInSeconds()));
    }

    // ── /video-metadata ─────────────────────────────────────────────

    /** {@code /video-metadata} の応答（必要な項目だけ）。 */
    public record VideoMeta(int rows, int columns, int numberOfFrames, double fps,
                            String transferSyntaxUid, boolean transcodeRequired,
                            boolean transcodeAvailable) {
    }

    static VideoMeta fetchVideoMetadata(String apiBase, String sop) throws Exception {
        String url = apiBase + "/api/instances/" + sop + "/video-metadata";
        String body;
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            HttpResponse<String> res = http.send(
                    HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(30)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) {
                throw new IOException("/video-metadata が " + res.statusCode() + " を返しました: " + url);
            }
            body = res.body();
        }
        return new VideoMeta(
                (int) num(body, "rows", 0),
                (int) num(body, "columns", 0),
                (int) num(body, "numberOfFrames", 0),
                num(body, "fps", 0),
                str(body, "transferSyntaxUid"),
                bool(body, "transcodeRequired", false),
                bool(body, "transcodeAvailable", false));
    }

    // ── 素朴な JSON 取り出し ────────────────────────────────────────
    // 応答は平らな 1 階層なので、依存を増やさず正規表現で足りる（`readPaddings` と同じ流儀）。

    private static double num(String json, String key, double dflt) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + key + "\"\\s*:\\s*(-?[0-9.eE+]+)").matcher(json);
        return m.find() ? Double.parseDouble(m.group(1)) : dflt;
    }

    private static String str(String json, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }

    private static boolean bool(String json, String key, boolean dflt) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + key + "\"\\s*:\\s*(true|false)").matcher(json);
        return m.find() ? Boolean.parseBoolean(m.group(1)) : dflt;
    }

    // ── 後始末 ──────────────────────────────────────────────────────

    private static long deleteRecursively(Path root) {
        long freed = 0;
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                try {
                    long size = Files.isRegularFile(p) ? Files.size(p) : 0;
                    if (Files.deleteIfExists(p)) freed += size;
                } catch (IOException ignored) {
                    /* 消せないものは残す（次の sweepOld が拾う） */
                }
            }
        } catch (IOException ignored) {
            /* 既に無い */
        }
        return freed;
    }
}

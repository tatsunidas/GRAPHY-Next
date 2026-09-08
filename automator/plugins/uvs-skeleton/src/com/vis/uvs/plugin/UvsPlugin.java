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
        // ── 段 6: `op` があれば新経路。プローブは走らせない ──────────
        //   🔑 **`op` が無ければ従来どおり**。段 2〜5 の 40 検査は旧フラグ（analyze/roi/predict）で
        //      動き続ける必要がある——あれが段 6 の回帰テストそのものだから。
        Object op = args == null ? null : args.get("op");
        if (op != null && !String.valueOf(op).isBlank()) {
            return dispatch(String.valueOf(op), args);
        }

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
        // ── 6. [C-1] 候補 ROI の抽出（段 4）─────────────────────────
        if (Boolean.TRUE.equals(args == null ? null : args.get("roi"))) {
            out.put("roiResult", extractRoi(args, out));
        }

        // 段 5: 特徴抽出（RadiomicsJ）＋ LR 推論。`predict: true` のときだけ。
        if (Boolean.TRUE.equals(args == null ? null : args.get("predict"))) {
            out.put("prediction", predict(args, out));
        }

        return out;
    }

    // ══════════════════════════════════════════════════════════════
    //  段 6: op 方式
    //
    //  画面は 1 回の解析で 40 回以上ここを呼ぶ。そのたびに MP4 を落とし直したり
    //  `ffmpeg -version` を起こしたりしないよう、状態は {@link UvsSession} が持つ。
    //  戻りは必ず {"ok":..., "op":...}（失敗時は "error" も）。
    //  🔴 **args のエコーバックはしない**——40 往復ぶんの無駄が乗る。
    // ══════════════════════════════════════════════════════════════

    private Map<String, Object> dispatch(String op, Map<String, Object> args) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ok", false);
        r.put("op", op);
        try {
            switch (op) {
                case "info" -> {
                    UvsSession s = UvsSession.open(
                            strArg(args, "apiBase"), strArg(args, "sopInstanceUid"), getClass().getClassLoader());
                    r.putAll(s.info());
                    r.put("ok", true);
                }
                case "prepare" -> r.putAll(prepare(args));
                case "predict" -> r.putAll(predictChunk(args));
                case "checkCache" -> r.putAll(checkCache(args));
                case "release" -> {
                    UvsSession s = UvsSession.get(strArg(args, "sessionId"));
                    // 🔑 既に無いセッションの release は**成功**にする。窓を閉じたときと
                    //    明示解放が二重に飛ぶのはふつうに起きるので、そこで赤くしない。
                    r.put("freedBytes", s == null ? 0L : s.close());
                    r.put("existed", s != null);
                    r.put("ok", true);
                }
                default -> r.put("error", "未知の op: " + op);
            }
        } catch (Throwable t) {
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    private static String strArg(Map<String, Object> args, String key) {
        Object v = args == null ? null : args.get(key);
        return v == null ? null : String.valueOf(v);
    }

    /**
     * 走査（段 6 の {@code op:"prepare"}）— <b>復号 1 回</b>で
     * ① 色判定の CPR 列 ② 静止判定の MAD 列 ③ 予測に要るフレームのキャッシュ、を同時に作る。
     *
     * <h3>🔴 なぜ 1 パスに載せるのか</h3>
     * {@link FrameSource#readPair} は毎回<b>先頭から復号し直す</b>。4,958 フレームの動画で
     * 331 サンプル × 2 枚を取りに行くと、平均で動画の半分を毎回復号することになる。
     * 段 5 が 4 フレームだったから成立していただけで、そのままでは段 6 は動かない。
     *
     * <h3>🔴 なぜ生の rgb24 を置くのか</h3>
     * {@link FrameCache} の説明のとおり。<b>sink が見た byte[] をそのまま書く</b>ので、
     * 「キャッシュ ＝ 復号結果」はコードの構造から従う（{@code op:"checkCache"} で数字でも確かめる）。
     *
     * <h3>間引きの格子は動画全体で固定する</h3>
     * 🔑 予測するフレームは <b>{@code index % interval == 0}</b> で決める。区間の先頭を起点に
     * すると、<b>同じ動画でも区切り方で別の要約が出る</b>——チャンクに分けて呼ぶ設計と噛み合わない。
     */
    private Map<String, Object> prepare(Map<String, Object> args) throws Exception {
        Map<String, Object> r = new LinkedHashMap<>();
        UvsSession s = UvsSession.get(strArg(args, "sessionId"));
        if (s == null) {
            r.put("error", "セッションがありません（op:\"info\" で開き直してください）");
            return r;
        }
        int lastFrame = Math.max(0, s.numberOfFrames - 1);
        int from = Math.max(0, intArg(args, "from", 0));
        int count = intArg(args, "count", 0); // 0 以下＝末尾まで
        int interval = Math.max(1, intArg(args, "interval", s.intervalFrames()));
        int stride = Math.max(1, intArg(args, "stride", s.strideFrames()));
        boolean cacheForPredict = !Boolean.FALSE.equals(args.get("cacheForPredict"));

        // スコアを出す最後のフレーム（この番号の相手＝+1 まで読む必要がある）。
        int scoreLast = count > 0 ? Math.min(lastFrame, from + count - 1) : lastFrame;

        // 予測を走らせる番号（動画全体で固定の格子）と、その差分の相手。
        List<Integer> samples = new ArrayList<>();
        java.util.TreeSet<Integer> needed = new java.util.TreeSet<>();
        if (cacheForPredict) {
            for (int i = ((from + interval - 1) / interval) * interval; i <= scoreLast; i += interval) {
                samples.add(i);
                needed.add(i);
                // ⚠️ **範囲外の相手は丸めない。** 元アプリは最終フレームで相手を空画像にする。
                //    段 4 の検査は「相手が無ければ null」で移植元と一致しているので、
                //    ここで min(i+stride, last) に丸めると**別の ROI が出る**。
                if (i + stride <= lastFrame) needed.add(i + stride);
            }
        }

        FrameCache cache = s.cache();
        // 🔴 始める前に空きを確かめる。足りないまま走らせると、16 分かけてディスクを埋めて落ちる。
        long need = (long) needed.size() * cache.frameBytes();
        long usable = Files.getFileStore(cache.dir()).getUsableSpace();
        long margin = 64L * 1024 * 1024;
        if (need + margin > usable) {
            r.put("error", "空き容量が足りません: 必要 " + need + " バイト＋余裕 " + margin
                    + " に対し空き " + usable + " バイト。区間を短くするか間引きを粗くしてください");
            r.put("requiredBytes", need);
            r.put("usableBytes", usable);
            return r;
        }

        int readUntil = Math.max(needed.isEmpty() ? -1 : needed.last(), scoreLast + 1);
        FrameScoring.Points points = new FrameScoring.Points(
                s.width, s.height, FrameScoring.SAMPLING_POINTS, FrameScoring.RANDOM_SEED);
        List<Double> cpr = new ArrayList<>();
        List<Double> mad = new ArrayList<>();
        long t0 = System.currentTimeMillis();
        int seen;
        FrameSource src = s.open();
        try {
            // ⚠️ 渡される配列は使い回されるので、直前フレームは必ず複製して持つ。
            byte[][] holder = new byte[][]{null};
            int[] prevIdx = new int[]{-1};
            List<Double> cprRef = cpr;
            List<Double> madRef = mad;
            seen = src.forEachFrame(readUntil, (i, frame) -> {
                if (needed.contains(i)) cache.write(i, frame);
                byte[] p = holder[0];
                if (p != null && prevIdx[0] >= from && prevIdx[0] <= scoreLast) {
                    cprRef.add(FrameScoring.colorPixelRatio(p, points, FrameScoring.COLOR_THRESHOLD));
                    madRef.add(FrameScoring.meanAbsDiff(p, frame, points, s.width));
                }
                holder[0] = frame.clone();
                prevIdx[0] = i;
            });
        } finally {
            src.close();
        }
        // 最後のフレームは相手が無い。CPR は自分だけで出せるが MAD は出せないので、
        // 🔴 **元アプリと同じく直前の値を複製する**（逆順比較のバグ B3 を避けた形）。
        if (!mad.isEmpty()) mad.add(mad.get(mad.size() - 1));

        UvsSession.Scan scanned = new UvsSession.Scan(
                from, cpr.size(), interval, stride,
                cpr.stream().mapToDouble(Double::doubleValue).toArray(),
                mad.stream().mapToDouble(Double::doubleValue).toArray(),
                samples.stream().mapToInt(Integer::intValue).toArray());
        s.setScan(scanned);

        r.put("ok", true);
        r.put("sessionId", s.id);
        r.put("from", from);
        r.put("frames", cpr.size());
        r.put("cpr", cpr);
        r.put("mad", mad);
        r.put("sampleIndices", samples);
        r.put("interval", interval);
        r.put("stride", stride);
        r.put("cachedFrames", cache.count());
        r.put("cacheBytes", cache.bytes());
        r.put("framesDecoded", seen);
        r.put("ffmpegRuns", 1); // 🔑 1 パス。ここが 1 でなくなったら設計が壊れている
        r.put("decodeMs", System.currentTimeMillis() - t0);
        r.put("samplingPoints", points.count);
        r.put("seed", FrameScoring.RANDOM_SEED);
        r.put("colorThreshold", FrameScoring.COLOR_THRESHOLD);
        return r;
    }

    /**
     * 予測を<b>区間に分けて</b>走らせる（段 6 の {@code op:"predict"}）。
     *
     * <h3>なぜ分けるのか</h3>
     * 1 予測あたり 2.2〜2.9 秒。4,958 フレーム・間引き 15 なら 331 サンプル ≒ <b>16 分</b>。
     * {@code runBackend()} は同期 1 往復で進捗を返せないので、<b>数サンプルずつ返して
     * 呼び直してもらう</b>。進捗はフロントが持つ（「押したら 11 分無反応」を作らない）。
     *
     * <h3>中止は実装しない</h3>
     * 🔑 <b>フロントが次のチャンクを投げなければ止まる。</b> 分割方式の副産物として
     * 中止が無料で手に入るので、止める仕掛けを別に作らない（止め忘れの経路も増えない）。
     *
     * <h3>フレームはキャッシュから読む</h3>
     * {@code prepare} が置いた生 rgb24 をそのまま使う。⚠️ <b>差分の相手が範囲外なら null</b>
     * ——元アプリは最終フレームで空画像を相手にする。丸めて実フレームを渡すと別の ROI が出る。
     */
    private Map<String, Object> predictChunk(Map<String, Object> args) throws Exception {
        Map<String, Object> r = new LinkedHashMap<>();
        UvsSession s = UvsSession.get(strArg(args, "sessionId"));
        if (s == null) {
            r.put("error", "セッションがありません（op:\"info\" で開き直してください）");
            return r;
        }
        UvsSession.Scan sc = s.scan();
        if (sc == null) {
            r.put("error", "先に op:\"prepare\" を走らせてください");
            return r;
        }
        int[] samples = sc.samples();
        int sampleFrom = Math.max(0, intArg(args, "sampleFrom", 0));
        int sampleCount = Math.max(1, intArg(args, "sampleCount", 4));
        boolean includeFeatures = Boolean.TRUE.equals(args.get("includeFeatures"));
        int end = Math.min(samples.length, sampleFrom + sampleCount);
        int lastFrame = Math.max(0, s.numberOfFrames - 1);

        // 🔴 モデルは**自分のフォルダ**から読む。読めなければ既定値へ落ちずに失敗させる。
        java.nio.file.Path dir = pluginDir();
        com.vis.uvs.ml.LrModel model = com.vis.uvs.ml.LrModel.fromJson(
                java.nio.file.Files.readString(dir.resolve("reference-params.json")));
        String[] names = model.featureNames();
        double[] paddings = readPaddings(dir.resolve("model-manifest.json"), names);

        com.vis.uvs.analysis.AnalysisSettings.Extractor ex =
                com.vis.uvs.analysis.AnalysisSettings.Extractor.EXTRACTOR_COMPOSITE;
        com.vis.uvs.radiomics.RadiomicsFeatureService svc =
                new com.vis.uvs.radiomics.RadiomicsFeatureService();
        com.vis.uvs.radiomics.RadiomicsFeatureService.Spec spec =
                com.vis.uvs.radiomics.RadiomicsFeatureService.Spec.swingDefaults(names, paddings);
        FrameCache cache = s.cache();

        List<Map<String, Object>> scores = new ArrayList<>();
        boolean anyPadded = false;
        for (int k = sampleFrom; k < end; k++) {
            int index = samples[k];
            long t0 = System.currentTimeMillis();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("sample", k);
            row.put("frameIndex", index);

            byte[] a = cache.read(index);
            if (a == null) {
                row.put("ok", false);
                row.put("error", "フレーム " + index + " がキャッシュにありません（prepare をやり直してください）");
                scores.add(row);
                continue;
            }
            int partner = index + sc.stride();
            byte[] b = partner <= lastFrame ? cache.read(partner) : null;

            com.vis.uvs.video.Frame f0 = new com.vis.uvs.video.Frame(index + 1, s.width, s.height, a);
            com.vis.uvs.video.Frame f1 = b == null ? null
                    : new com.vis.uvs.video.Frame(partner + 1, s.width, s.height, b);

            Map<Integer, ij.gui.Roi> rois = com.vis.uvs.analysis.candidate.CandidateExtractor.extract(
                    f0, f1, ex, 1,
                    com.vis.uvs.analysis.roi.RoiSettings.forExtractor(ex),
                    com.vis.uvs.analysis.flow.FlowSettings.swingDefaults());

            List<Map<String, Object>> perRoi = new ArrayList<>();
            double sum = 0;
            boolean framePadded = false;
            for (Map.Entry<Integer, ij.gui.Roi> e : rois.entrySet()) {
                com.vis.uvs.radiomics.RoiCropper.Cropped c =
                        com.vis.uvs.radiomics.RoiCropper.crop(f0, e.getValue());
                if (c == null) continue;
                com.vis.uvs.radiomics.RadiomicsFeatureService.Extracted ext =
                        svc.extractDetailed(c.image(), c.mask(), spec);
                double p = model.score(ext.values());
                sum += p;
                Map<String, Object> one = new LinkedHashMap<>();
                one.put("cluster", e.getKey());
                one.put("x", c.bounds().x);
                one.put("y", c.bounds().y);
                one.put("w", c.bounds().width);
                one.put("h", c.bounds().height);
                one.put("pixels", c.bounds().width * c.bounds().height);
                one.put("probability", p);
                // ⚠️ 未検証の経路。**通ったら、どの特徴が埋まったかを名前で残す**（§8.10）。
                List<String> paddedNames = new ArrayList<>();
                for (int i = 0; i < names.length; i++) if (ext.padded()[i]) paddedNames.add(names[i]);
                one.put("padded", !paddedNames.isEmpty());
                if (!paddedNames.isEmpty()) {
                    one.put("paddedFeatures", paddedNames);
                    framePadded = true;
                }
                if (includeFeatures) {
                    Map<String, Object> feats = new LinkedHashMap<>();
                    for (int i = 0; i < names.length; i++) feats.put(names[i], ext.values()[i]);
                    one.put("features", feats);
                }
                perRoi.add(one);
            }
            anyPadded |= framePadded;
            row.put("ok", true);
            row.put("rois", perRoi);
            // フレームの確率は **ROI ごとの確率の平均**（移植元と同じ）。
            row.put("probability", perRoi.isEmpty() ? 0.0 : sum / perRoi.size());
            row.put("padded", framePadded);
            row.put("elapsedMs", System.currentTimeMillis() - t0);
            scores.add(row);
        }

        r.put("ok", true);
        r.put("sessionId", s.id);
        r.put("scores", scores);
        r.put("sampleFrom", sampleFrom);
        r.put("nextFrom", end);
        r.put("total", samples.length);
        r.put("done", end >= samples.length);
        r.put("anyPadded", anyPadded);
        r.put("stride", sc.stride());
        r.put("radiomicsJVersion", com.vis.uvs.radiomics.RadiomicsFeatureService.radiomicsJVersion());
        return r;
    }

    /**
     * 🔴 <b>「キャッシュしたフレームは、復号したフレームと本当に同じか」を数字で確かめる</b>
     * （段 6 の最重要検査）。
     *
     * <p>相手は {@link FrameSource#readPair}——<b>段 4 / 段 5 が実際に使い、移植元と完全一致すると
     * 確かめられた経路</b>である。ここが崩れていると ROI が静かにずれ、
     * 「確率だけが違う」という気づきにくい壊れ方に戻る。
     */
    private Map<String, Object> checkCache(Map<String, Object> args) throws Exception {
        Map<String, Object> r = new LinkedHashMap<>();
        UvsSession s = UvsSession.get(strArg(args, "sessionId"));
        if (s == null) {
            r.put("error", "セッションがありません（op:\"info\" で開き直してください）");
            return r;
        }
        Object raw = args.get("indices");
        List<Integer> indices = new ArrayList<>();
        if (raw instanceof List<?> l) {
            for (Object o : l) if (o instanceof Number n) indices.add(n.intValue());
        }
        if (indices.isEmpty()) {
            UvsSession.Scan sc = s.scan();
            if (sc == null) {
                r.put("error", "先に op:\"prepare\" を走らせてください");
                return r;
            }
            // 既定は先頭・中央・末尾のサンプル（全部照合すると 1 枚ごとに復号し直すので遅い）。
            int[] sm = sc.samples();
            if (sm.length > 0) {
                indices.add(sm[0]);
                indices.add(sm[sm.length / 2]);
                indices.add(sm[sm.length - 1]);
            }
        }
        FrameCache cache = s.cache();
        List<Map<String, Object>> rows = new ArrayList<>();
        boolean allMatch = true;
        FrameSource src = s.open();
        try {
            for (int i : indices) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("index", i);
                String cached = cache.digest(i);
                byte[][] pair = src.readPair(i, i);
                String decoded = pair[0] == null ? null : FrameCache.md5(pair[0]);
                row.put("cachedMd5", cached);
                row.put("decodedMd5", decoded);
                boolean same = cached != null && cached.equals(decoded);
                row.put("same", same);
                if (!same) allMatch = false;
                rows.add(row);
            }
        } finally {
            src.close();
        }
        r.put("ok", true);
        r.put("allMatch", allMatch);
        r.put("checked", rows);
        return r;
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

    /**
     * 候補 ROI の抽出（段 4）。**移植したコアをそのまま呼ぶ。**
     *
     * <p>🔑 ここでやっているのは<b>配線</b>だけ——フレームを 2 枚取って
     * {@code CandidateExtractor.extract} に渡す。アルゴリズムは移植元のまま
     * （書き直すと乱数・丸め・パラメータのどれかがずれて、学習済みモデルが不整合になる）。
     *
     * <p>⚠️ 差分の相手は {@code min(i + stride, N-1)}。元アプリは最終フレームで
     * <b>相手を空画像</b>にするが、ここでは範囲内に丸めた実フレームを渡す実装にはしていない
     * ——**同じ挙動にするため null を渡す**。
     */
    private Map<String, Object> extractRoi(Map<String, Object> args, Map<String, Object> probes) {
        Map<String, Object> r = new LinkedHashMap<>();
        try {
            String apiBase = String.valueOf(args.get("apiBase"));
            String sop = String.valueOf(args.get("sopInstanceUid"));
            int width = intArg(args, "width", 0);
            int height = intArg(args, "height", 0);
            int stride = intArg(args, "stride", 6);
            int index = intArg(args, "frameIndex", 0);
            @SuppressWarnings("unchecked")
            Map<String, Object> ff = (Map<String, Object>) probes.get("ffmpeg");
            String ffmpeg = ff == null ? "ffmpeg" : String.valueOf(ff.get("path"));

            FrameSource src = FrameSource.fromRendered(apiBase, sop, ffmpeg, width, height);
            byte[][] pair;
            try {
                pair = src.readPair(index, index + stride);
            } finally {
                src.close();
            }
            if (pair[0] == null) {
                r.put("ok", false);
                r.put("error", "フレーム " + index + " を読めなかった");
                return r;
            }

            com.vis.uvs.video.Frame f0 =
                    new com.vis.uvs.video.Frame(index + 1, width, height, pair[0]);
            com.vis.uvs.video.Frame f1 = pair[1] == null ? null
                    : new com.vis.uvs.video.Frame(index + stride + 1, width, height, pair[1]);

            com.vis.uvs.analysis.AnalysisSettings.Extractor ex =
                    com.vis.uvs.analysis.AnalysisSettings.Extractor.EXTRACTOR_COMPOSITE;
            com.vis.uvs.analysis.roi.RoiSettings roiSet =
                    com.vis.uvs.analysis.roi.RoiSettings.forExtractor(ex);
            com.vis.uvs.analysis.flow.FlowSettings flow =
                    com.vis.uvs.analysis.flow.FlowSettings.swingDefaults();

            long t0 = System.currentTimeMillis();
            Map<Integer, ij.gui.Roi> rois =
                    com.vis.uvs.analysis.candidate.CandidateExtractor.extract(f0, f1, ex, 1, roiSet, flow);
            r.put("elapsedMs", System.currentTimeMillis() - t0);

            List<Map<String, Object>> list = new ArrayList<>();
            for (Map.Entry<Integer, ij.gui.Roi> e : rois.entrySet()) {
                java.awt.Rectangle b = e.getValue().getBounds();
                Map<String, Object> one = new LinkedHashMap<>();
                one.put("cluster", e.getKey());
                one.put("x", b.x);
                one.put("y", b.y);
                one.put("w", b.width);
                one.put("h", b.height);
                list.add(one);
            }
            r.put("ok", true);
            r.put("frameIndex", index);
            r.put("stride", stride);
            r.put("rois", list);
            r.put("boxCount", roiSet.boxCount());
            r.put("boxSeed", roiSet.boxSeed());
        } catch (Throwable t) {
            r.put("ok", false);
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    /**
     * 1 フレームの「心臓確率」— 設計 §5 の [C]→特徴→LR。
     *
     * <p>ROI 抽出までは {@link #extractRoi} と同じ経路。その先で ROI ごとに
     * 8bit グレースケールへ落として RadiomicsJ に渡し、15 特徴を LR に通す。
     * フレームの確率は <b>ROI ごとの確率の平均</b>（移植元 {@code FramePredictor} と同じ）。
     *
     * <h3>🔴 RadiomicsJ は 2.4.0 のまま使う（版差の判断・§8.8）</h3>
     * 学習は 2.1.16 だが、15 特徴のうち版差に触れるのは
     * {@code Percentile90} と {@code Interquartile} の 2 つだけで、
     * <b>どちらも実測で完全一致した</b>。分位点の添字が 1 つずれても、
     * 25,000 画素が 155 段階のグレー値にしか散らばらないため<b>同値になる</b>。
     *
     * <h3>⚠️ padding は manifest 由来の値を使う</h3>
     * NaN / Inf のとき「0」で埋めると、学習時と違う量が入る。
     * {@code model-manifest.json} の {@code features[].padding} を渡す。
     */
    private Map<String, Object> predict(Map<String, Object> args, Map<String, Object> probes) {
        Map<String, Object> r = new LinkedHashMap<>();
        try {
            String apiBase = String.valueOf(args.get("apiBase"));
            String sop = String.valueOf(args.get("sopInstanceUid"));
            int width = intArg(args, "width", 0);
            int height = intArg(args, "height", 0);
            int stride = intArg(args, "stride", 6);
            int index = intArg(args, "frameIndex", 0);
            @SuppressWarnings("unchecked")
            Map<String, Object> ff = (Map<String, Object>) probes.get("ffmpeg");
            String ffmpeg = ff == null ? "ffmpeg" : String.valueOf(ff.get("path"));

            // 🔴 モデルは**自分のフォルダ**から読む（§8.5 で実測済み）。
            //    読めなければ既定値へ落ちずに失敗させる（黙って別のモデルで走るより良い）。
            java.nio.file.Path dir = pluginDir();
            com.vis.uvs.ml.LrModel model = com.vis.uvs.ml.LrModel.fromJson(
                    java.nio.file.Files.readString(dir.resolve("reference-params.json")));
            String[] names = model.featureNames();
            double[] paddings = readPaddings(dir.resolve("model-manifest.json"), names);

            FrameSource src = FrameSource.fromRendered(apiBase, sop, ffmpeg, width, height);
            byte[][] pair;
            try {
                pair = src.readPair(index, index + stride);
            } finally {
                src.close();
            }
            if (pair[0] == null) {
                r.put("ok", false);
                r.put("error", "フレーム " + index + " を読めなかった");
                return r;
            }

            com.vis.uvs.video.Frame f0 =
                    new com.vis.uvs.video.Frame(index + 1, width, height, pair[0]);
            com.vis.uvs.video.Frame f1 = pair[1] == null ? null
                    : new com.vis.uvs.video.Frame(index + stride + 1, width, height, pair[1]);

            com.vis.uvs.analysis.AnalysisSettings.Extractor ex =
                    com.vis.uvs.analysis.AnalysisSettings.Extractor.EXTRACTOR_COMPOSITE;
            long t0 = System.currentTimeMillis();
            Map<Integer, ij.gui.Roi> rois = com.vis.uvs.analysis.candidate.CandidateExtractor.extract(
                    f0, f1, ex, 1,
                    com.vis.uvs.analysis.roi.RoiSettings.forExtractor(ex),
                    com.vis.uvs.analysis.flow.FlowSettings.swingDefaults());

            com.vis.uvs.radiomics.RadiomicsFeatureService svc =
                    new com.vis.uvs.radiomics.RadiomicsFeatureService();
            com.vis.uvs.radiomics.RadiomicsFeatureService.Spec spec =
                    com.vis.uvs.radiomics.RadiomicsFeatureService.Spec.swingDefaults(names, paddings);

            List<Map<String, Object>> perRoi = new ArrayList<>();
            double sum = 0;
            for (Map.Entry<Integer, ij.gui.Roi> e : rois.entrySet()) {
                com.vis.uvs.radiomics.RoiCropper.Cropped c =
                        com.vis.uvs.radiomics.RoiCropper.crop(f0, e.getValue());
                if (c == null) continue;
                double[] v = svc.extract(c.image(), c.mask(), spec);
                double p = model.score(v);
                sum += p;
                Map<String, Object> one = new LinkedHashMap<>();
                one.put("cluster", e.getKey());
                one.put("x", c.bounds().x);
                one.put("y", c.bounds().y);
                one.put("w", c.bounds().width);
                one.put("h", c.bounds().height);
                one.put("pixels", c.bounds().width * c.bounds().height);
                one.put("probability", p);
                Map<String, Object> feats = new LinkedHashMap<>();
                for (int i = 0; i < names.length; i++) feats.put(names[i], v[i]);
                one.put("features", feats);
                perRoi.add(one);
            }

            r.put("elapsedMs", System.currentTimeMillis() - t0);
            r.put("ok", true);
            r.put("frameIndex", index);
            r.put("stride", stride);
            r.put("radiomicsJVersion",
                    com.vis.uvs.radiomics.RadiomicsFeatureService.radiomicsJVersion());
            r.put("rois", perRoi);
            r.put("probability", perRoi.isEmpty() ? 0.0 : sum / perRoi.size());
        } catch (Throwable t) {
            r.put("ok", false);
            r.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return r;
    }

    /**
     * manifest の `features[].padding` を `names` の順に並べ替えて返す。
     *
     * <p>⚠️ <b>順序は manifest ではなく `names`（＝推論入力の順序）で決める。</b>
     * manifest 側の並びに依存すると、片方だけ並べ替えたときに黙ってずれる。
     * 見つからない名前は 0（＝padding 無し）。
     */
    private static double[] readPaddings(java.nio.file.Path manifest, String[] names) throws Exception {
        String json = java.nio.file.Files.readString(manifest);
        Map<String, Double> byName = new LinkedHashMap<>();
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\\{\\s*\"name\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"padding\"\\s*:\\s*(-?[0-9.eE+]+)")
                .matcher(json);
        while (m.find()) byName.put(m.group(1), Double.parseDouble(m.group(2)));
        double[] out = new double[names.length];
        for (int i = 0; i < names.length; i++) out[i] = byName.getOrDefault(names[i], 0.0);
        return out;
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
    /**
     * 自分の JAR が置かれているフォルダ（＝`<pluginsDir>/<id>/`）。
     *
     * <p>🔑 HTTP で配信されるのは `ui.js` 1 本だけだが、<b>JAR は自分のフォルダを読める</b>
     * （`fw/plugin-explainer.md` §5）。モデルのパラメータはここから読む。
     */
    private java.nio.file.Path pluginDir() throws Exception {
        CodeSource cs = getClass().getProtectionDomain().getCodeSource();
        if (cs == null || cs.getLocation() == null) {
            throw new IllegalStateException("CodeSource が取れないのでプラグインのフォルダを決められない");
        }
        Path dir = Path.of(cs.getLocation().toURI()).getParent();
        if (dir == null) {
            throw new IllegalStateException("JAR の親フォルダが取れない");
        }
        return dir;
    }

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

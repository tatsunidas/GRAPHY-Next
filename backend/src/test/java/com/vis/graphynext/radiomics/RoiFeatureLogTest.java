/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.cache.CacheStore;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.measure.ResultsTable;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

import java.io.StringReader;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.*;

/** ROI 特徴量: LoG フィルタ（RadiomicsJ 2.5.x の設定を通す）。 */
class RoiFeatureLogTest {

    private static final int W = 28, H = 28, D = 14;

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    /** spacing は (xy, z) mm。ROI は中央寄りの箱（端から LoG の半径より離れている必要は無い。ミラー境界）。 */
    private static RadiomicsMapEngine.LoadedVolume volume(double xy, double z) {
        ImageStack is = new ImageStack(W, H);
        ImageStack ms = new ImageStack(W, H);
        long s = 4242L;
        for (int k = 0; k < D; k++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            ByteProcessor mp = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) {
                for (int x = 0; x < W; x++) {
                    s = s * 6364136223846793005L + 1442695040888963407L;
                    ip.setf(x, y, (int) Math.floorMod(s >> 33, 400) + 5 * k);
                    mp.set(x, y, (x >= 8 && x < 20 && y >= 8 && y < 20 && k >= 3 && k < 11) ? 1 : 0);
                }
            }
            is.addSlice(ip);
            ms.addSlice(mp);
        }
        ImagePlus img = new ImagePlus("i", is);
        Calibration c = img.getCalibration();
        c.pixelWidth = xy;
        c.pixelHeight = xy;
        c.pixelDepth = z;
        ImagePlus mask = new ImagePlus("m", ms);
        mask.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, "1");
        Map<Integer, double[]> ipp = new HashMap<>();
        String[] sops = new String[D];
        for (int k = 0; k < D; k++) {
            ipp.put(k, new double[] {0, 0, k * z});
            sops[k] = "1.2.3." + k;
        }
        return new RadiomicsMapEngine.LoadedVolume(img, mask, W, H, D, 1, true, c,
                new double[] {1, 0, 0, 0, 1, 0}, xy, xy, ipp, sops, null, null, false);
    }

    private static final class FixedEngine extends RadiomicsMapEngine {
        final LoadedVolume vol;

        FixedEngine(LoadedVolume vol) {
            super(null, new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null), null);
            this.vol = vol;
        }

        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings) {
            return vol;
        }
    }

    private static RoiFeatureService service(RadiomicsMapEngine.LoadedVolume vol, Path dir) {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        return new RoiFeatureService(new FixedEngine(vol), new MapCheckpointStore(new CacheStore(dir, 0), "t"),
                new RadiomicsMode(env), new ObjectMapper().findAndRegisterModules(),
                (rj, img, mask, label) -> rj.extractAll(img, mask, label), "9.9.9-test", () -> null, () -> null);
    }

    private static RoiFeatureRequest req(Map<String, String> settings,
                                         EnumSet<RoiFeatureRequest.RoiMode> modes) {
        return new RoiFeatureRequest("1.2", "1.2.9", "1.2.8", 0, 0, 0, settings, false, modes);
    }

    private static Map<String, String> s(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private static Map<String, Double> values(List<RoiFeatureResult.Row> rows) {
        Map<String, Double> m = new LinkedHashMap<>();
        for (RoiFeatureResult.Row r : rows) m.put(r.column(), r.value());
        return m;
    }

    private static final String LOG15 = "log_sigma1.5mm_";
    private static final String MEAN = "IntensityBasedStatistical_Mean";

    @Test
    void logColumnsAreAddedAndTheOriginalColumnsDoNotChange(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = service(volume(1.0, 1.0), dir);
        RoiFeatureResult plain = svc.compute(req(s(), null), p -> { });
        RoiFeatureResult log = svc.compute(req(s("DOUBLEARRAY_logSigmaMm", "1.5,2.5"), null), p -> { });
        Map<String, Double> a = values(plain.rows());
        Map<String, Double> b = values(log.rows());
        assertTrue(b.containsKey(LOG15 + MEAN), "σ 1.5 の列がある");
        assertTrue(b.containsKey("log_sigma2.5mm_" + MEAN), "σ 2.5 の列がある");
        for (Map.Entry<String, Double> e : a.entrySet()) {
            assertEquals(e.getValue(), b.get(e.getKey()), "フィルタを足しても元の列は同じ: " + e.getKey());
        }
        assertNotEquals(a.get(MEAN), b.get(LOG15 + MEAN), "フィルタ後の値は元と違う");
        assertTrue(b.keySet().stream().noneMatch(c -> c.startsWith(LOG15 + "Morphology_")
                || c.startsWith(LOG15 + "Diagnostics")), "形態・Diagnostics は元の画像のまま繰り返さない");

        RoiFeatureResult.Row row = log.rows().stream().filter(r -> r.column().equals(LOG15 + MEAN)).findFirst().get();
        assertEquals("log_sigma1.5mm_IntensityBasedStatistical", row.family());
        assertEquals(MEAN.substring(MEAN.indexOf('_') + 1), row.feature());
        assertNull(row.ibsi(), "フィルタ後の値に IBSI の識別子は付けない");
        assertEquals(List.of(RoiFeatureDefinitions.NOTE_LOG_FILTERED), row.notes());
        assertTrue(log.settingsProperties().contains("DOUBLEARRAY_logSigmaMm=1.5,2.5\n"), log.settingsProperties());
        assertTrue(log.settingsProperties().contains("DOUBLE_logTruncate=4.0\n"));
        assertTrue(log.settingsProperties().contains("STRING_logPadding=MIRROR\n"));
        assertFalse(plain.settingsProperties().equals(log.settingsProperties()));
    }

    @Test
    void writtenSettingsFileReproducesTheExtractionBitForBit(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine.LoadedVolume vol = volume(1.0, 1.0);
        RoiFeatureResult r = service(vol, dir).compute(
                req(s("DOUBLEARRAY_logSigmaMm", "2.0", "STRING_logPadding", "NEAREST"), null), p -> { });
        Properties props = new Properties();
        props.load(new StringReader(r.settingsProperties()));
        ImagePlus mask = vol.mask();
        mask.setCalibration(vol.calibration().copy());
        ResultsTable direct = RadiomicsLock.call(() -> {
            try {
                RadiomicsJ rj = new RadiomicsJ();
                rj.loadSettings(props);
                return rj.extractAll(vol.image(), mask, 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
        Map<String, Double> mine = values(r.rows());
        int last = direct.size() - 1;
        int compared = 0;
        for (String h : direct.getHeadings()) {
            if (!direct.columnExists(h)) continue;
            double d = direct.getValue(h, last);
            Double m = mine.get(h);
            if (Double.isNaN(d)) assertNull(m, h);
            else assertEquals(Double.doubleToLongBits(d), Double.doubleToLongBits(m), h);
            compared++;
        }
        assertEquals(mine.size(), compared, "列の集合が同じ");
        assertTrue(mine.keySet().stream().anyMatch(c -> c.startsWith("log_sigma2.0mm_")));

        // 負例: σ だけ変えた設定ファイルでは LoG の列が一致しない
        Properties other = new Properties();
        other.putAll(props);
        other.setProperty("DOUBLEARRAY_logSigmaMm", "2.2");
        ResultsTable shifted = RadiomicsLock.call(() -> {
            try {
                RadiomicsJ rj = new RadiomicsJ();
                rj.loadSettings(other);
                return rj.extractAll(vol.image(), mask, 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
        double want = mine.get("log_sigma2.0mm_" + MEAN);
        double got = shifted.getValue("log_sigma2.2mm_" + MEAN, shifted.size() - 1);
        assertNotEquals(Double.doubleToLongBits(want), Double.doubleToLongBits(got), "σ が違えば値が違う");
    }

    @Test
    void anisotropicGridWithoutResamplingIsRefusedInJapanese(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = service(volume(0.8, 2.0), dir);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> svc.compute(req(s("DOUBLEARRAY_logSigmaMm", "1.5"), null), p -> { }));
        assertTrue(e.getMessage().contains("リサンプリング"), e.getMessage());
        // フィルタなしなら同じ格子で計算できる（負例側の対照）
        assertDoesNotThrow(() -> svc.compute(req(s(), null), p -> { }));
        // リサンプリングを指定すれば LoG も計算できる
        RoiFeatureResult ok = svc.compute(req(s("DOUBLEARRAY_logSigmaMm", "1.5",
                "DOUBLEARRAY_resamplingFactorXYZ", "1.0,1.0,1.0"), null), p -> { });
        assertTrue(ok.rows().stream().anyMatch(r -> r.column().startsWith(LOG15)));
    }

    @Test
    void twoDimensionalUnitsFilterInPlane(@TempDir Path dir) throws Exception {
        RoiFeatureResult r = service(volume(1.0, 1.0), dir).compute(
                req(s("DOUBLEARRAY_logSigmaMm", "1.5"), EnumSet.of(RoiFeatureRequest.RoiMode.MAX_SECTION_2D)),
                p -> { });
        Map<String, Double> sec = values(r.section().rows());
        assertTrue(sec.containsKey(LOG15 + MEAN), "2D の単位にも LoG の列が出る");
        assertTrue(r.section().record().settingsProperties().contains("BOOL_force2D=1\n"));
        assertNotEquals(values(r.rows()).get(LOG15 + MEAN), sec.get(LOG15 + MEAN),
                "2D は面内フィルタ、3D は体積フィルタなので値が違う");
    }
}

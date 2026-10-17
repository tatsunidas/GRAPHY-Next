/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.cache.CacheStore;
import com.vis.graphynext.cache.Checkpoints;
import com.vis.graphynext.dicom.DicomProperties;
import ij.ImagePlus;
import io.github.tatsunidas.radiomics.main.FeatureVisualizationMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.TreeMap;

/**
 * テクスチャマップの<b>スライス単位の途中結果</b>（{@code <storageDir>/.cache/radiomics}、ローカルのみ）。
 *
 * <p>キーは「出力の値に効く入力すべて」の SHA-256。<b>読み込んだボリュームの画素そのもの</b>（画像・マスク）と校正、
 * 特徴・カーネル・stride・2D/3D・margin・設定、RadiomicsJ の版を含める。ファイルの mtime などの間接的な印には
 * 頼らない（画素が同じなら同じ結果、違えば別のキー）。出力のメタ情報（シリーズ説明・番号）は含めない。
 *
 * <p>上限は未設定（無制限）。既定値は実測のうえで決める（P2-11）。
 */
@Component
public class MapCheckpointStore {

    private static final Logger log = LoggerFactory.getLogger(MapCheckpointStore.class);

    /** 計算の仕方（スライス単位の呼び出し・補間など）を変えたら上げる。 */
    static final String ENGINE_VERSION = "tex-ckpt-1";

    private final Checkpoints checkpoints;
    private final String radiomicsjVersion;

    @Autowired
    public MapCheckpointStore(DicomProperties props) {
        this(new CacheStore(Paths.get(props.getStorageDir(), ".cache", "radiomics"), 0), detectRadiomicsjVersion());
    }

    MapCheckpointStore(CacheStore store, String radiomicsjVersion) {
        this.checkpoints = new Checkpoints(store);
        this.radiomicsjVersion = radiomicsjVersion;
    }

    /** RadiomicsJ の版。取れなければ null（＝途中結果を使わない。古い版の結果を黙って使わないため）。 */
    static String detectRadiomicsjVersion() {
        try (InputStream is = FeatureVisualizationMap.class
                .getResourceAsStream("/META-INF/maven/io.github.tatsunidas/radiomicsj/pom.properties")) {
            if (is == null) {
                return null;
            }
            Properties p = new Properties();
            p.load(is);
            String v = p.getProperty("version");
            return v == null || v.isBlank() ? null : v;
        } catch (IOException e) {
            return null;
        }
    }

    /** 途中結果を使えるか（RadiomicsJ の版が分かっているときだけ）。 */
    boolean enabled() {
        return radiomicsjVersion != null;
    }

    /**
     * @return キー。使えないときは null
     */
    String key(TextureSeriesRequest req, RadiomicsMapEngine.LoadedVolume vol,
               int filterSize, int stride, boolean d2, int margin) {
        if (!enabled()) {
            return null;
        }
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            put(md, ENGINE_VERSION);
            put(md, radiomicsjVersion);
            put(md, req.feature());
            put(md, filterSize + "/" + stride + "/" + d2 + "/" + margin + "/" + vol.label() + "/" + vol.hasMask());
            put(md, vol.width() + "x" + vol.height() + "x" + vol.slices());
            put(md, vol.calibration().pixelWidth + "," + vol.calibration().pixelHeight + ","
                    + vol.calibration().pixelDepth);
            Map<String, String> settings = new TreeMap<>();
            if (req.settings() != null) {
                settings.putAll(req.settings());
            }
            for (Map.Entry<String, String> e : settings.entrySet()) {
                put(md, e.getKey() + "=" + e.getValue());
            }
            hashVolume(md, vol.image());
            hashVolume(md, vol.mask());
            return toHex(md.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void hashVolume(MessageDigest md, ImagePlus imp) {
        int n = imp.getNSlices();
        for (int z = 1; z <= n; z++) {
            float[] px = (float[]) imp.getStack().getProcessor(z).convertToFloatProcessor().getPixels();
            ByteBuffer bb = ByteBuffer.allocate(px.length * 4).order(ByteOrder.LITTLE_ENDIAN);
            bb.asFloatBuffer().put(px);
            md.update(bb.array());
        }
    }

    private static void put(MessageDigest md, String s) {
        byte[] b = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        md.update(ByteBuffer.allocate(4).putInt(b.length).array());
        md.update(b);
    }

    private static String toHex(byte[] d) {
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    /** 1 スライス（低解像度の計算結果）を保存する。 */
    void save(String key, int index, float[] pixels) {
        ByteBuffer bb = ByteBuffer.allocate(pixels.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        bb.asFloatBuffer().put(pixels);
        checkpoints.save(key, index, bb.array());
    }

    /** 保存済みのスライスを読む。無い・壊れている・長さ違いは empty。 */
    Optional<float[]> load(String key, int index, int length) {
        return checkpoints.load(key, index, length * 4).map(b -> {
            float[] out = new float[length];
            ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out);
            return out;
        });
    }

    void clear(String key, int slices) {
        if (key != null) {
            checkpoints.clear(key, slices);
            log.debug("[texture] checkpoints cleared key={}", key.substring(0, 12));
        }
    }
}

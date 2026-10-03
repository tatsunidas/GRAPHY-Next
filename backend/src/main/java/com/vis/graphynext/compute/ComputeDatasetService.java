/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.anonymize.AnonymizeConfig;
import com.vis.graphynext.anonymize.AnonymizeService;
import com.vis.graphynext.anonymize.PixelCodec;
import org.dcm4che3.data.Tag;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 外部の計算機へ送るデータセットを作る。設計: fw/remote-compute-design.md §3。
 *
 * <p>🔑 <b>匿名化は既存の {@link AnonymizeService} がする</b>（{@link AnonymizeService#anonymizeSeries}）。
 * ここが足すのは「外へ出してよいか」の判定（{@link RemoteBurnPolicy}）と、出力の形（dicom-zip / npz）だけ。
 *
 * <p>返すのは<b>ハンドル</b>（{@code dsh_<uuid>}）だけで、プラグインに中身は渡さない。
 * 計算機へのアップロードは本体がハンドルから行う（段 5）。プラグインに生のバイト列を外へ送る口を持たせないため。
 */
@Service
public class ComputeDatasetService {

    private static final Logger log = LoggerFactory.getLogger(ComputeDatasetService.class);
    /** 作ったデータセットを残す時間。送り終わるか、これを過ぎたら消す。 */
    static final Duration TTL = Duration.ofHours(2);
    /** 置き換える患者 ID / 氏名。 */
    static final String PSEUDONYM = "GRAPHY-ANON";

    public enum Format {
        DICOM_ZIP("dicom-zip", ".zip"), NPZ("npz", ".npz");

        final String code;
        final String extension;

        Format(String code, String extension) {
            this.code = code;
            this.extension = extension;
        }

        public String code() {
            return code;
        }

        public static Optional<Format> of(String code) {
            for (Format f : values()) {
                if (f.code.equals(code)) {
                    return Optional.of(f);
                }
            }
            return Optional.empty();
        }
    }

    /**
     * 作ったデータセット。{@code file} は本体の中でだけ使う（外へは出さない）。
     *
     * @param sha256          ファイルの SHA-256（同意画面と監査ログに出す。段 4）
     * @param burnedInstances マスクで焼き込みを塗ったインスタンス数
     */
    public record Dataset(String handle, Format format, Path file, long bytes, String sha256, int instances,
                          int burnedInstances, String sourceStudyUid, String sourceSeriesUid, String modality,
                          Instant createdAt) {
    }

    /** 作らなかった（送ってはいけない・形が合わない）。{@link #reason()} は画面で訳すコード。 */
    public static final class DatasetRefused extends RuntimeException {
        private final String reason;

        public DatasetRefused(String reason, String detail) {
            super(reason + (detail == null ? "" : ": " + detail));
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    private final AnonymizeService anonymizer;
    private final PixelCodec codec;
    private final ObjectMapper mapper;
    private final Map<String, Dataset> datasets = new ConcurrentHashMap<>();

    public ComputeDatasetService(AnonymizeService anonymizer, PixelCodec codec, ObjectMapper mapper) {
        this.anonymizer = anonymizer;
        this.codec = codec;
        this.mapper = mapper;
    }

    /**
     * 1 シリーズを匿名化してデータセットにする。
     *
     * @throws DatasetRefused 焼き込みの規則で送れない／匿名化に失敗したインスタンスがある／npz にできない形
     */
    public Dataset create(String studyUid, String seriesUid, Format format) {
        sweep();
        if (anonymizer.isWeb()) {
            throw new DatasetRefused("web-mode", null);
        }
        AnonymizeService.SeriesBurnFacts facts = anonymizer.seriesBurnFacts(studyUid, seriesUid);
        RemoteBurnPolicy.Decision decision = RemoteBurnPolicy.decide(facts);
        if (!decision.allowed()) {
            log.info("[compute] dataset refused: series={} reason={} modalities={}", seriesUid, decision.reason(),
                    facts.modalities());
            throw new DatasetRefused(decision.reason(), null);
        }
        AnonymizeConfig cfg = remoteConfig();
        String handle = "dsh_" + UUID.randomUUID();
        Path dir = null;
        try {
            dir = Files.createTempDirectory("graphy-compute-");
            Path file = dir.resolve("dataset" + format.extension);
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            AnonymizeService.Result r;
            String modality = facts.modalities().size() == 1 ? facts.modalities().iterator().next() : null;
            try (OutputStream out = new DigestOutputStream(Files.newOutputStream(file), sha)) {
                if (format == Format.NPZ) {
                    VolumeAssembler va = new VolumeAssembler(codec);
                    r = anonymizer.anonymizeSeries(studyUid, seriesUid, cfg, decision.burnIn(), va);
                    if (va.failure() != null) {
                        throw new DatasetRefused(va.failure(), null);
                    }
                    check(r, decision);
                    try {
                        va.writeNpz(out, mapper);
                    } catch (VolumeAssembler.UnsupportedLayout e) {
                        throw new DatasetRefused(e.getMessage(), null); // 並べてみて分かる形（重なり・欠け）
                    }
                } else {
                    try (ZipOutputStream zip = new ZipOutputStream(out)) {
                        int[] n = {0};
                        r = anonymizer.anonymizeSeries(studyUid, seriesUid, cfg, decision.burnIn(), (ds, ts) -> {
                            // 匿名化後の UID で名前を付ける（元の UID をファイル名に残さない）
                            zip.putNextEntry(new ZipEntry(String.format("%05d_%s.dcm", ++n[0],
                                    ds.getString(Tag.SOPInstanceUID))));
                            AnonymizeService.writeDicom(ds, ts, zip);
                            zip.closeEntry();
                        });
                        check(r, decision);
                    }
                }
            }
            Dataset d = new Dataset(handle, format, file, Files.size(file), HexFormat.of().formatHex(sha.digest()),
                    r.instances(), r.burnedInstances(), studyUid, seriesUid, modality, Instant.now());
            datasets.put(handle, d);
            log.info("[compute] dataset {} {} instances={} burned={} bytes={}", handle, format.code, d.instances(),
                    d.burnedInstances(), d.bytes());
            return d;
        } catch (DatasetRefused e) {
            deleteDir(dir);
            throw e;
        } catch (IOException e) {
            deleteDir(dir);
            throw new UncheckedIOException(e);
        } catch (NoSuchAlgorithmException e) {
            deleteDir(dir);
            throw new IllegalStateException(e);
        }
    }

    public Optional<Dataset> get(String handle) {
        Dataset d = handle == null ? null : datasets.get(handle);
        if (d != null && expired(d)) {
            discard(handle);
            return Optional.empty();
        }
        return Optional.ofNullable(d);
    }

    /** 送り終えた・要らなくなったデータセットを消す。 */
    public void discard(String handle) {
        Dataset d = datasets.remove(handle);
        if (d != null) {
            deleteDir(d.file().getParent());
        }
    }

    /**
     * 外へ出す匿名化の設定。<b>PS3.15 の Basic プロファイル</b>（保持オプション無し＝いちばん厳しい）に、
     * 焼き込みを塗る {@code CleanPixelData} だけを足す。UID は置き換わり、日付・記述は消える。
     * 画像の幾何（位置・向き・画素間隔）は匿名化の対象外なので残る（npz の幾何に要る）。
     */
    static AnonymizeConfig remoteConfig() {
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(AnonymizeConfig.Option.CleanPixelData);
        cfg.setReplacePatientId(PSEUDONYM);
        cfg.setReplacePatientName(PSEUDONYM);
        return cfg;
    }

    /** 匿名化の結果を確かめる。1 件でも失敗・塗り残しがあれば送らない（半端なものを外に出さない）。 */
    private static void check(AnonymizeService.Result r, RemoteBurnPolicy.Decision decision) {
        if (!r.errors().isEmpty()) {
            throw new DatasetRefused("anonymize-failed", r.errors().get(0));
        }
        if (r.instances() == 0) {
            throw new DatasetRefused("series-not-found", null);
        }
        if (decision.burnIn() && (r.burnedInstances() != r.instances())) {
            // 事前検査では塗れるはずだった。塗れなかったものがあれば外に出さない
            throw new DatasetRefused("burnin-incomplete",
                    r.burnedInstances() + "/" + r.instances());
        }
    }

    private void sweep() {
        for (Dataset d : datasets.values()) {
            if (expired(d)) {
                discard(d.handle());
            }
        }
    }

    private static boolean expired(Dataset d) {
        return d.createdAt().plus(TTL).isBefore(Instant.now());
    }

    private static void deleteDir(Path dir) {
        if (dir == null) {
            return;
        }
        try (var s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // 一時フォルダ。消せなければ OS に任せる
                }
            });
        } catch (IOException ignored) {
            // 同上
        }
    }
}

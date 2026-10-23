/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * 受信した DICOM（C-STORE・C-GET）を、保管庫・索引に入れる前に匿名化する。
 *
 * <p>受信は 1 枚ずつ・別々の関連付け・日をまたいで届くので、UID・患者 ID・日付のずらしは
 * 元の値と鍵だけから決まる仮名（{@link ConsistentPseudonyms}）にする。原本は保管せず、匿名化できない
 * もの（焼き込み文字の恐れ・設定の不備・処理の失敗）は受け取らない。
 *
 * <p>設定は受信のたびに読む（再起動なしで次の受信から効く）。無効なら何もしない。
 * 記録には元の氏名・ID・UID を書かない（新しい UID と送信側 AE タイトルだけ）。
 */
@Service
public class ReceiveAnonymizer {

    private static final Logger log = LoggerFactory.getLogger(ReceiveAnonymizer.class);

    public static final String ENABLED_KEY = "dicom.receiveAnonymize.enabled";
    public static final String PROFILE_KEY = "dicom.receiveAnonymize.profile";
    public static final String DEFAULT_PREFIX = "ANON-";
    /** 属性（BurnedInAnnotation）が無くても、画素に文字が入りやすいので受け付けない種類。 */
    static final Set<String> BURN_PRONE_MODALITIES = Set.of("US", "SC", "ES", "XC", "GM", "OT");

    /** 受信用の匿名化プロファイル。手動の匿名化の {@code AnonRequest} と同じ意味の項目を持つ。 */
    public record Profile(List<String> options, String patientIdPrefix, String patientName,
                          List<String> manualRetainTags, Map<String, String> customReplacements) {
    }

    /** 状態（画面・REST 用）。 */
    public record Status(boolean enabled, boolean profileValid, Instant keyCreatedAt, boolean keyCreatedThisRun,
                         long accepted, long rejected, List<String> recentRejections) {
    }

    /** 受け付けられない理由。{@code reason} は記録・応答に出してよい固定の短い語。 */
    public static class Rejected extends IOException {
        private static final long serialVersionUID = 1L;
        private final String reason;

        public Rejected(String reason) {
            super(reason);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true);

    private final SettingsService settings;
    private final Path keyFile;
    private final DicomAnonymizerEngine engine = new DicomAnonymizerEngine();

    private PseudonymKey key;
    private boolean keyCreatedThisRun;
    private final AtomicLong accepted = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    private final Deque<String> recent = new ArrayDeque<>();

    public ReceiveAnonymizer(SettingsService settings,
                             @Value("${graphy.receive-anonymize.key-file:./data/receive-anon.key}") String keyFile) {
        this.settings = settings;
        this.keyFile = Path.of(keyFile);
    }

    public boolean enabled() {
        return "true".equals(settings.getAll().get(ENABLED_KEY));
    }

    /**
     * 受信した一時ファイルを匿名化して、新しい一時ファイルを返す（元の一時ファイルは消す）。
     * 無効なら {@code temp} をそのまま返す。失敗・拒否では両方の一時ファイルを消して例外を投げる。
     */
    public Path process(Path temp, String callingAet) throws IOException {
        Map<String, String> s = settings.getAll();
        if (!"true".equals(s.get(ENABLED_KEY))) {
            return temp;
        }
        Path out = null;
        try {
            Profile profile = readProfile(s.get(PROFILE_KEY));
            AnonymizeConfig cfg = configOf(profile);
            Attributes ds;
            String tsuid;
            try (DicomInputStream in = new DicomInputStream(temp.toFile())) {
                // URI: 画素を元ファイルへの参照で持つ（圧縮画素の扱いは手動の匿名化と同じ）。出力を書き終えるまで元を消さない。
                in.setIncludeBulkData(IncludeBulkData.URI);
                in.readFileMetaInformation();
                ds = in.readDataset(-1, -1);
                tsuid = in.getTransferSyntax();
            }
            rejectIfBurnPossible(ds);

            ConsistentPseudonyms pseudonyms = new ConsistentPseudonyms(key());
            String orig = ds.getString(Tag.PatientID, "");
            String newId = pseudonyms.patientId(orig, profile.patientIdPrefix() == null ? DEFAULT_PREFIX : profile.patientIdPrefix());
            String newName = profile.patientName() == null || profile.patientName().isBlank() ? newId : profile.patientName();
            int shift = cfg.hasOption(AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates)
                    ? DateShifter.shiftDaysFor(orig, pseudonyms.dateSeed()) : 0;
            engine.deidentify(ds, cfg, new DicomAnonymizerEngine.PatientMapping(newId, newName, shift), pseudonyms.uidMap());

            Path dir = temp.toAbsolutePath().getParent();
            out = dir.resolve(UUID.randomUUID() + ".anon");
            try (OutputStream os = Files.newOutputStream(out)) {
                AnonymizeService.writeDicom(ds, tsuid, os);
            }
            Files.deleteIfExists(temp);
            accepted.incrementAndGet();
            log.info("[receive-anon] 受付 aet={} sop={}", callingAet, ds.getString(Tag.SOPInstanceUID));
            return out;
        } catch (Rejected r) {
            noteRejected(callingAet, r.reason());
            cleanup(temp, out);
            throw r;
        } catch (Exception e) {
            // 匿名化できないものは受け取らない。原本を保管庫に入れない。記録に元の値は書かない（例外の文面も出さない）。
            noteRejected(callingAet, "failed:" + e.getClass().getSimpleName());
            cleanup(temp, out);
            throw new IOException("受信時の匿名化に失敗しました", e);
        }
    }

    private void rejectIfBurnPossible(Attributes ds) throws Rejected {
        String burned = ds.getString(Tag.BurnedInAnnotation);
        if ("YES".equalsIgnoreCase(burned)) {
            throw new Rejected("burned-in-annotation");
        }
        if (burned == null && BURN_PRONE_MODALITIES.contains(ds.getString(Tag.Modality, ""))) {
            throw new Rejected("burn-prone-modality");
        }
    }

    /** 設定の JSON を読む。無い（null/空）なら既定。読めない・不正なら例外（受信を全部断る）。 */
    public Profile readProfile(String json) throws IOException {
        if (json == null || json.isBlank()) {
            return new Profile(List.of(), DEFAULT_PREFIX, null, List.of(), Map.of());
        }
        return MAPPER.readValue(json, Profile.class);
    }

    /** プロファイルから設定を作る（未知のオプション・日付の排他違反・受信時に実現できないオプションは 400 の例外）。 */
    AnonymizeConfig configOf(Profile p) {
        var req = new AnonymizeController.AnonRequest(null, p.options(), null, null, null,
                p.manualRetainTags(), p.customReplacements(), false, null);
        AnonymizeController.validateProfile(req);
        AnonymizeConfig cfg = AnonymizeController.toConfig(req);
        // 受信時は画素を触らない。入れたまま受けると「文字を消した」と誤解させるので、設定として認めない。
        if (cfg.hasOption(AnonymizeConfig.Option.CleanPixelData)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "受信時の匿名化では CleanPixelData は使えません（画素は変更しません）");
        }
        return cfg;
    }

    /** 保存前の検査（REST から）。不正なら例外。 */
    public void validate(String profileJson) throws IOException {
        configOf(readProfile(profileJson));
    }

    private synchronized PseudonymKey key() throws IOException {
        if (key == null) {
            key = PseudonymKey.loadOrCreate(keyFile);
            keyCreatedThisRun = key.wasCreated();
            if (keyCreatedThisRun) {
                log.warn("[receive-anon] 仮名の鍵を新しく作りました。以前の鍵で受けた検査とは別の仮名になります。");
            }
        }
        return key;
    }

    private synchronized void noteRejected(String aet, String reason) {
        rejected.incrementAndGet();
        recent.addFirst(reason);
        while (recent.size() > 5) {
            recent.removeLast();
        }
        log.warn("[receive-anon] 拒否 aet={} reason={}", aet, reason);
    }

    private static void cleanup(Path temp, Path out) {
        for (Path p : new Path[] {temp, out}) {
            if (p == null) {
                continue;
            }
            try {
                Files.deleteIfExists(p);
            } catch (IOException ignore) {
                // ベストエフォート
            }
        }
    }

    /** 起動時に、落ちたときに残った受信の一時ファイル（原本）を消す。SCP を開始する前に呼ぶ。 */
    public int sweepIncoming(Path dir) {
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        int n = 0;
        try (Stream<Path> files = Files.list(dir)) {
            for (Path f : files.filter(Files::isRegularFile).toList()) {
                try {
                    Files.delete(f);
                    n++;
                } catch (IOException e) {
                    log.warn("[receive-anon] 受信の一時ファイルを消せません: {}", f.getFileName());
                }
            }
        } catch (IOException e) {
            log.warn("[receive-anon] 受信の一時フォルダを読めません: {}", e.getMessage());
        }
        return n;
    }

    public synchronized Status status() {
        boolean valid = true;
        try {
            validate(settings.getAll().get(PROFILE_KEY));
        } catch (Exception e) {
            valid = false;
        }
        // 状態を見るだけで鍵を作らない（作るのは最初の受信のとき）。
        Instant created = null;
        try {
            if (key != null || Files.exists(keyFile)) {
                created = key().createdAt();
            }
        } catch (Exception ignore) {
            // 鍵が壊れている: created は null のまま
        }
        return new Status(enabled(), valid, created, keyCreatedThisRun, accepted.get(), rejected.get(), List.copyOf(recent));
    }

    /** 鍵の書き出し（バックアップ用）。 */
    public byte[] exportKey() throws IOException {
        return key().exportBytes();
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.PixelCodec;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.ApplicationEntity;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Connection;
import org.dcm4che3.net.DataWriterAdapter;
import org.dcm4che3.net.Device;
import org.dcm4che3.net.DimseRSP;
import org.dcm4che3.net.pdu.AAssociateRQ;
import org.dcm4che3.net.pdu.PresentationContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * 最小の C-STORE SCU。DICOM Part-10 ファイルをリモート AE へ送信する（DICOM Send）。
 *
 * <p>DB に依存しない純粋な dcm4che 実装。
 * <ul>
 *   <li>{@link #store}: 1 ファイルを 1 アソシエーションで送る（C-ECHO 同様の最小実装。テスト用にも使う）。</li>
 *   <li>{@link #storeAll}: 複数ファイルを<b>単一アソシエーション</b>で送る（スタディ送信の本線）。
 *       多数インスタンスのスタディで毎ファイル接続を張り直す非効率／PACS 側のアソシエーション制限を避ける。</li>
 * </ul>
 */
public class DicomStoreScu {

    private static final Logger log = LoggerFactory.getLogger(DicomStoreScu.class);

    private static final int CONNECT_TIMEOUT_MS = 5000;

    /** AAssociateRQ が提示できる Presentation Context の上限（DICOM 仕様）。 */
    private static final int MAX_PRESENTATION_CONTEXTS = 128;

    /**
     * 保管庫が圧縮して持つ（受信時の可逆圧縮）転送構文。相手が受けないときは、復号して Explicit VR LE で送る。
     * 有損 JPEG など、ほかの圧縮は従来どおり（変換しない）。
     */
    private static final Set<String> LOSSLESS_STORED = Set.of(UID.JPEGLSLossless, UID.JPEG2000Lossless);

    /** 復号して送るための部品。null なら復号フォールバックなし（従来どおり、ファイルの転送構文だけ提示）。 */
    private final PixelCodec codec;

    public DicomStoreScu() {
        this(null);
    }

    public DicomStoreScu(PixelCodec codec) {
        this.codec = codec;
    }

    /** 保管庫が可逆圧縮で持つ転送構文か（相手が受けないとき、復号して送る対象）。 */
    public static boolean isLosslessStored(String tsuid) {
        return tsuid != null && LOSSLESS_STORED.contains(tsuid);
    }

    private boolean canFallBack(String tsuid) {
        return codec != null && tsuid != null && LOSSLESS_STORED.contains(tsuid);
    }

    /** 送信時の転送構文の方針。STORED は保存どおり（従来の挙動）、ほかは指定した非圧縮構文だけを相手に提示する。 */
    public enum TsPolicy {
        STORED(null),
        EXPLICIT_LE(UID.ExplicitVRLittleEndian),
        IMPLICIT_LE(UID.ImplicitVRLittleEndian);

        private final String uid;

        TsPolicy(String uid) {
            this.uid = uid;
        }

        /** 指定する転送構文。STORED は null。 */
        public String uid() {
            return uid;
        }
    }

    /** 送るときの転送構文。元の転送構文を相手が受けるならそれ、受けず Explicit VR LE を受けるならそれ、どちらも無ければ null。 */
    private String chooseTs(Association as, String cuid, String tsuid) {
        if (!canFallBack(tsuid)) {
            return tsuid;
        }
        Set<String> accepted = as.getTransferSyntaxesFor(cuid);
        if (accepted.contains(tsuid)) {
            return tsuid;
        }
        return accepted.contains(UID.ExplicitVRLittleEndian) ? UID.ExplicitVRLittleEndian : null;
    }

    /** 指定した転送構文を相手が受理したときだけそれを返す。受理されなければ null（保存どおりへは戻さない）。 */
    private String chooseTs(Association as, String cuid, TsPolicy policy) {
        return as.getTransferSyntaxesFor(cuid).contains(policy.uid()) ? policy.uid() : null;
    }

    /** ファイルから送るデータセットを作る。chosen が元と違う圧縮画像は復号する。復号できなければ null。 */
    private Attributes datasetFor(Path file, String tsuid, String chosen) throws IOException {
        if (chosen.equals(tsuid) || PixelCodec.isUncompressed(tsuid)) {
            try (DicomInputStream din = new DicomInputStream(file.toFile())) {
                din.readFileMetaInformation();
                return din.readDataset();
            }
        }
        PixelCodec.Uncompressed u = codec.toUncompressed(file);
        return u == null ? null : u.ds();
    }

    /**
     * 指定した非圧縮構文で送れない理由。送れるなら null。
     * 保存が非圧縮ならそのまま再符号化できる。可逆圧縮はコーデックがあれば復号できる。有損圧縮などは変換しない。
     */
    private String cannotConvertReason(String tsuid) {
        if (PixelCodec.isUncompressed(tsuid)) {
            return null;
        }
        if (!isLosslessStored(tsuid)) {
            return "圧縮形式 " + tsuid + " は非圧縮へ変換しません";
        }
        if (codec == null || !codec.available()) {
            return "圧縮画像（" + tsuid + "）を復号できません" + (codec == null ? "" : "（" + codec.unavailableReason() + "）");
        }
        return null;
    }

    public record StoreResult(boolean success, int status, String message) {
    }

    /**
     * バッチ送信（{@link #storeAll}）の結果。
     *
     * @param total    送信対象として渡されたファイル数
     * @param sent     C-STORE 成功（警告ステータス含む）数
     * @param failed   失敗数（読込失敗・PC 不受理・非成功ステータス・例外）
     * @param messages 失敗/警告の人間可読メッセージ（先頭から最大数件）
     */
    public record BatchResult(int total, int sent, int failed, List<String> messages) {
    }

    public StoreResult store(String host, int port, String calledAet, String callingAet, Path dicomFile) {
        return store(host, port, calledAet, callingAet, dicomFile, null);
    }

    /** TLS 付き C-STORE。{@code tls} が null/usable でないときは平文。 */
    public StoreResult store(String host, int port, String calledAet, String callingAet, Path dicomFile,
                             com.vis.graphynext.dicom.DicomProperties.Tls tls) {
        return store(host, port, calledAet, callingAet, dicomFile, tls, TsPolicy.STORED);
    }

    /** 転送構文の方針つき C-STORE。STORED 以外は、指定した非圧縮構文だけを提示し、受理されなければ失敗にする。 */
    public StoreResult store(String host, int port, String calledAet, String callingAet, Path dicomFile,
                             com.vis.graphynext.dicom.DicomProperties.Tls tls, TsPolicy policy) {
        Attributes fmi;
        Attributes dataset;
        try (DicomInputStream din = new DicomInputStream(dicomFile.toFile())) {
            fmi = din.readFileMetaInformation();
            dataset = din.readDataset();
        } catch (IOException e) {
            return new StoreResult(false, -1, "読み込み失敗: " + e.getMessage());
        }
        String cuid = fmi.getString(Tag.MediaStorageSOPClassUID);
        String iuid = fmi.getString(Tag.MediaStorageSOPInstanceUID);
        String tsuid = fmi.getString(Tag.TransferSyntaxUID);

        Device device = new Device("graphy-store-scu");
        Connection local = new Connection();
        local.setConnectTimeout(CONNECT_TIMEOUT_MS);
        ApplicationEntity ae = new ApplicationEntity(callingAet);
        device.addConnection(local);
        device.addApplicationEntity(ae);
        ae.addConnection(local);

        ExecutorService executor = Executors.newSingleThreadExecutor();
        ScheduledExecutorService scheduled = Executors.newSingleThreadScheduledExecutor();
        device.setExecutor(executor);
        device.setScheduledExecutor(scheduled);

        Connection remote = new Connection();
        remote.setHostname(host);
        remote.setPort(port);
        remote.setConnectTimeout(CONNECT_TIMEOUT_MS);

        if (tls != null && tls.isUsable()) {
            com.vis.graphynext.dicom.DicomTls.applyKeyMaterial(device, tls);
            com.vis.graphynext.dicom.DicomTls.applyToConnection(local, tls, false);
            com.vis.graphynext.dicom.DicomTls.applyToConnection(remote, tls, false);
        }

        AAssociateRQ rq = new AAssociateRQ();
        rq.setCalledAET(calledAet);
        if (policy == TsPolicy.STORED) {
            rq.addPresentationContext(new PresentationContext(1, cuid, tsuid));
            if (canFallBack(tsuid)) {
                rq.addPresentationContext(new PresentationContext(3, cuid, UID.ExplicitVRLittleEndian));
            }
        } else {
            String reason = cannotConvertReason(tsuid);
            if (reason != null) {
                return new StoreResult(false, -1, reason);
            }
            rq.addPresentationContext(new PresentationContext(1, cuid, policy.uid()));
        }

        Association as = null;
        try {
            as = ae.connect(local, remote, rq);
            String sendTs = policy == TsPolicy.STORED ? chooseTs(as, cuid, tsuid) : chooseTs(as, cuid, policy);
            if (sendTs == null) {
                return new StoreResult(false, -1, policy == TsPolicy.STORED
                        ? "相手が転送構文 " + tsuid + " も Explicit VR Little Endian も受け付けません"
                        : "相手が指定の転送構文 " + policy.uid() + " を受け付けません");
            }
            Attributes toSend = datasetFor(dicomFile, tsuid, sendTs);
            if (toSend == null) {
                return new StoreResult(false, -1, "圧縮画像を復号できないため送れません（相手は " + tsuid + " を受け付けません）");
            }
            DimseRSP rsp = as.cstore(cuid, iuid, 0, new DataWriterAdapter(toSend), sendTs);
            rsp.next();
            int status = rsp.getCommand().getInt(Tag.Status, -1);
            if (status == 0) {
                log.info("C-STORE ok: {} -> {}@{}:{}", iuid, calledAet, host, port);
                return new StoreResult(true, status, "C-STORE succeeded");
            }
            return new StoreResult(false, status, "C-STORE status 0x" + Integer.toHexString(status));
        } catch (Exception e) {
            log.warn("C-STORE failed to {}@{}:{}: {}", calledAet, host, port, e.toString());
            return new StoreResult(false, -1, e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            if (as != null) {
                try {
                    as.release();
                } catch (Exception ignore) {
                    // ベストエフォート
                }
            }
            executor.shutdown();
            scheduled.shutdown();
        }
    }

    /**
     * 複数の DICOM Part-10 ファイルを<b>単一アソシエーション</b>でリモート AE へ C-STORE する。
     *
     * <p>各ファイルの FMI から (SOPClassUID, TransferSyntaxUID) を集めて Presentation Context を一括提示し、
     * 各ファイルは自身の転送構文で送る（再エンコードしない＝圧縮 TS もそのまま）。ファイル単位で失敗を捕捉し、
     * 1 件の失敗で全体を止めない。成功ステータス(0)に加え警告(0xBxxx)も「送信成功」として数える。
     */
    public BatchResult storeAll(String host, int port, String calledAet, String callingAet, List<Path> files,
                                com.vis.graphynext.dicom.DicomProperties.Tls tls) {
        return storeAll(host, port, calledAet, callingAet, files, tls, TsPolicy.STORED);
    }

    /** 転送構文の方針つき一括送信。STORED 以外は指定構文のみ提示し、変換できない・受理されない画像は失敗として数える。 */
    public BatchResult storeAll(String host, int port, String calledAet, String callingAet, List<Path> files,
                                com.vis.graphynext.dicom.DicomProperties.Tls tls, TsPolicy policy) {
        int total = files.size();
        List<String> messages = new ArrayList<>();
        if (files.isEmpty()) {
            return new BatchResult(0, 0, 0, messages);
        }

        // 1) 各ファイルの FMI を先読みして送信メタ（cuid/iuid/tsuid）と提示すべき PC の集合を作る。
        record Item(Path file, String cuid, String iuid, String tsuid) {
        }
        List<Item> items = new ArrayList<>(total);
        Set<String> pcKeys = new LinkedHashSet<>(); // "cuid\tsuid" の重複排除
        Map<String, String[]> pcPairs = new LinkedHashMap<>();
        int failed = 0;
        for (Path f : files) {
            String cuid;
            String iuid;
            String tsuid;
            try (DicomInputStream din = new DicomInputStream(f.toFile())) {
                Attributes fmi = din.readFileMetaInformation();
                cuid = fmi != null ? fmi.getString(Tag.MediaStorageSOPClassUID) : null;
                iuid = fmi != null ? fmi.getString(Tag.MediaStorageSOPInstanceUID) : null;
                tsuid = fmi != null ? fmi.getString(Tag.TransferSyntaxUID) : null;
            } catch (IOException e) {
                failed++;
                addMessage(messages, "読み込み失敗 " + f.getFileName() + ": " + e.getMessage());
                continue;
            }
            if (cuid == null || iuid == null || tsuid == null) {
                failed++;
                addMessage(messages, "FMI 不足のため送信不可: " + f.getFileName());
                continue;
            }
            if (policy != TsPolicy.STORED) {
                String reason = cannotConvertReason(tsuid);
                if (reason != null) {
                    failed++;
                    addMessage(messages, reason + ": " + iuid);
                    continue;
                }
                items.add(new Item(f, cuid, iuid, tsuid));
                String pKey = cuid + '\t' + policy.uid();
                if (pcKeys.add(pKey)) {
                    pcPairs.put(pKey, new String[] { cuid, policy.uid() });
                }
                continue;
            }
            items.add(new Item(f, cuid, iuid, tsuid));
            String key = cuid + '\t' + tsuid;
            if (pcKeys.add(key)) {
                pcPairs.put(key, new String[] { cuid, tsuid });
            }
            if (canFallBack(tsuid)) {
                String evrKey = cuid + '\t' + UID.ExplicitVRLittleEndian;
                if (pcKeys.add(evrKey)) {
                    pcPairs.put(evrKey, new String[] { cuid, UID.ExplicitVRLittleEndian });
                }
            }
        }
        if (items.isEmpty()) {
            return new BatchResult(total, 0, failed, messages);
        }

        Device device = new Device("graphy-store-scu");
        Connection local = new Connection();
        local.setConnectTimeout(CONNECT_TIMEOUT_MS);
        ApplicationEntity ae = new ApplicationEntity(callingAet);
        device.addConnection(local);
        device.addApplicationEntity(ae);
        ae.addConnection(local);

        ExecutorService executor = Executors.newSingleThreadExecutor();
        ScheduledExecutorService scheduled = Executors.newSingleThreadScheduledExecutor();
        device.setExecutor(executor);
        device.setScheduledExecutor(scheduled);

        Connection remote = new Connection();
        remote.setHostname(host);
        remote.setPort(port);
        remote.setConnectTimeout(CONNECT_TIMEOUT_MS);

        if (tls != null && tls.isUsable()) {
            com.vis.graphynext.dicom.DicomTls.applyKeyMaterial(device, tls);
            com.vis.graphynext.dicom.DicomTls.applyToConnection(local, tls, false);
            com.vis.graphynext.dicom.DicomTls.applyToConnection(remote, tls, false);
        }

        AAssociateRQ rq = new AAssociateRQ();
        rq.setCalledAET(calledAet);
        int pcId = 1; // Presentation Context ID は奇数
        int offered = 0;
        for (String[] pair : pcPairs.values()) {
            if (offered >= MAX_PRESENTATION_CONTEXTS) {
                log.warn("提示 PC が上限 {} に達したため一部 SOPClass/TS を提示しません", MAX_PRESENTATION_CONTEXTS);
                break;
            }
            rq.addPresentationContext(new PresentationContext(pcId, pair[0], pair[1]));
            pcId += 2;
            offered++;
        }

        int sent = 0;
        Association as = null;
        try {
            as = ae.connect(local, remote, rq);
            for (Item it : items) {
                try {
                    // 送信元ファイルは cstore の前に読み切って閉じる。ネットワーク I/O 中にファイルハンドルを
                    // 保持しないことで、受信側が同一パスへ書き戻す構成（自己送信）でも Windows のファイルロックで
                    // 失敗しない（POSIX は開いたまま rename 置換可だが Windows は不可）。
                    String sendTs = policy == TsPolicy.STORED
                            ? chooseTs(as, it.cuid(), it.tsuid()) : chooseTs(as, it.cuid(), policy);
                    if (sendTs == null) {
                        failed++;
                        addMessage(messages, policy == TsPolicy.STORED
                                ? "相手が転送構文 " + it.tsuid() + " も Explicit VR Little Endian も受け付けません: " + it.iuid()
                                : "相手が指定の転送構文 " + policy.uid() + " を受け付けません: " + it.iuid());
                        continue;
                    }
                    Attributes dataset = datasetFor(it.file(), it.tsuid(), sendTs);
                    if (dataset == null) {
                        failed++;
                        addMessage(messages, "圧縮画像を復号できないため送れません: " + it.iuid());
                        continue;
                    }
                    DimseRSP rsp = as.cstore(it.cuid(), it.iuid(), 0, new DataWriterAdapter(dataset), sendTs);
                    rsp.next();
                    int status = rsp.getCommand().getInt(Tag.Status, -1);
                    if (status == 0) {
                        sent++;
                    } else if ((status & 0xF000) == 0xB000) {
                        // 警告（例: Coercion / Elements Discarded）。受理されているので成功として数える。
                        sent++;
                        addMessage(messages, "警告 0x" + Integer.toHexString(status) + ": " + it.iuid());
                    } else {
                        failed++;
                        addMessage(messages, "status 0x" + Integer.toHexString(status) + ": " + it.iuid());
                    }
                } catch (Exception e) {
                    failed++;
                    addMessage(messages, e.getClass().getSimpleName() + " " + it.file().getFileName() + ": " + e.getMessage());
                }
            }
            log.info("C-STORE batch: {} 件中 {} 送信 / {} 失敗 -> {}@{}:{}",
                    total, sent, failed, calledAet, host, port);
            return new BatchResult(total, sent, failed, messages);
        } catch (Exception e) {
            // アソシエーション確立失敗: 未送信は全て失敗扱い。
            int notSent = items.size();
            failed += notSent;
            addMessage(messages, "接続失敗: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            log.warn("C-STORE batch 接続失敗 {}@{}:{}: {}", calledAet, host, port, e.toString());
            return new BatchResult(total, sent, failed, messages);
        } finally {
            if (as != null) {
                try {
                    as.release();
                } catch (Exception ignore) {
                    // ベストエフォート
                }
            }
            executor.shutdown();
            scheduled.shutdown();
        }
    }

    /** 失敗/警告メッセージを蓄積（肥大化を防ぐため先頭 50 件まで）。 */
    private static void addMessage(List<String> messages, String msg) {
        if (messages.size() < 50) {
            messages.add(msg);
        }
    }
}

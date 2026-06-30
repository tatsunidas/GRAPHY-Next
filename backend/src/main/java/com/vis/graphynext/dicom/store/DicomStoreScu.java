/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
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
        rq.addPresentationContext(new PresentationContext(1, cuid, tsuid));

        Association as = null;
        try {
            as = ae.connect(local, remote, rq);
            DimseRSP rsp = as.cstore(cuid, iuid, 0, new DataWriterAdapter(dataset), tsuid);
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
            items.add(new Item(f, cuid, iuid, tsuid));
            String key = cuid + '\t' + tsuid;
            if (pcKeys.add(key)) {
                pcPairs.put(key, new String[] { cuid, tsuid });
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
                try (DicomInputStream din = new DicomInputStream(it.file().toFile())) {
                    din.readFileMetaInformation();
                    Attributes dataset = din.readDataset();
                    DimseRSP rsp = as.cstore(it.cuid(), it.iuid(), 0, new DataWriterAdapter(dataset), it.tsuid());
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

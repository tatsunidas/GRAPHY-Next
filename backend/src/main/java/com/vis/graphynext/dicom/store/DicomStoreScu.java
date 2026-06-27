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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * 最小の C-STORE SCU。DICOM Part-10 ファイルをリモート AE へ送信する。
 *
 * <p>DB に依存しない純粋な dcm4che 実装。1 送信ごとに専用の {@link Device}/executor を生成し解放する。
 */
public class DicomStoreScu {

    private static final Logger log = LoggerFactory.getLogger(DicomStoreScu.class);

    private static final int CONNECT_TIMEOUT_MS = 5000;

    public record StoreResult(boolean success, int status, String message) {
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
}

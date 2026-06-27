package com.vis.graphynext.dicom;

import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.net.ApplicationEntity;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Connection;
import org.dcm4che3.net.Device;
import org.dcm4che3.net.DimseRSP;
import org.dcm4che3.net.pdu.AAssociateRQ;
import org.dcm4che3.net.pdu.PresentationContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * C-ECHO（Verification SOP Class）の SCU。リモート AE への DICOM 疎通確認を行う。
 *
 * <p>DB・ストレージに依存しない純粋な dcm4che 実装。1 回の echo ごとに専用の
 * {@link Device} と executor を生成し、完了後に必ず解放する。
 */
@Component
public class DicomEchoScu {

    private static final Logger log = LoggerFactory.getLogger(DicomEchoScu.class);

    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int RESPONSE_TIMEOUT_MS = 5000;

    /**
     * リモート AE へ C-ECHO を送る。
     *
     * @param host       リモートホスト
     * @param port       リモートポート
     * @param calledAet  リモートの AE タイトル（Called AE）
     * @param callingAet 自局の AE タイトル（Calling AE）
     */
    public EchoResult echo(String host, int port, String calledAet, String callingAet) {
        long start = System.nanoTime();

        Device device = new Device("graphy-echo-scu");
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

        AAssociateRQ rq = new AAssociateRQ();
        rq.setCalledAET(calledAet);
        rq.addPresentationContext(new PresentationContext(
                1, UID.Verification, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian));

        Association as = null;
        try {
            as = ae.connect(local, remote, rq);
            DimseRSP rsp = as.cecho();
            rsp.next(); // 応答を待つ
            int status = rsp.getCommand().getInt(Tag.Status, -1);
            long elapsed = elapsedMs(start);
            if (status == 0) {
                log.info("C-ECHO ok: {}@{}:{} ({} ms)", calledAet, host, port, elapsed);
                return EchoResult.ok(status, elapsed);
            }
            return EchoResult.failure(elapsed,
                    "C-ECHO returned non-success status 0x" + Integer.toHexString(status));
        } catch (Exception e) {
            long elapsed = elapsedMs(start);
            log.warn("C-ECHO failed to {}@{}:{}: {}", calledAet, host, port, e.toString());
            return EchoResult.failure(elapsed, e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            if (as != null) {
                try {
                    as.release();
                } catch (Exception ignore) {
                    // ベストエフォート解放
                }
            }
            executor.shutdown();
            scheduled.shutdown();
        }
    }

    private static long elapsedMs(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000L;
    }
}

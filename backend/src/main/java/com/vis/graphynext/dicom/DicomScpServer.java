package com.vis.graphynext.dicom;

import org.dcm4che3.data.UID;
import org.dcm4che3.net.ApplicationEntity;
import org.dcm4che3.net.Connection;
import org.dcm4che3.net.Device;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.service.BasicCEchoSCP;
import org.dcm4che3.net.service.DicomService;
import org.dcm4che3.net.service.DicomServiceRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * DIMSE リスナー（SCP）。既定で C-ECHO（Verification）応答に対応し、
 * {@link #addService} で C-STORE 等のハンドラと {@link TransferCapability} を追加できる。
 *
 * <p>DB・Spring に依存しない純粋な dcm4che 実装。テストからは直接 new して使える。
 */
public class DicomScpServer {

    private static final Logger log = LoggerFactory.getLogger(DicomScpServer.class);

    private final String aeTitle;
    private final String bindAddress;
    private final int port;

    private final List<DicomService> extraServices = new ArrayList<>();
    private final List<TransferCapability> extraCapabilities = new ArrayList<>();

    private Device device;
    private ExecutorService executor;
    private ScheduledExecutorService scheduled;
    private volatile boolean running;

    public DicomScpServer(String aeTitle, String bindAddress, int port) {
        this.aeTitle = aeTitle;
        this.bindAddress = bindAddress;
        this.port = port;
    }

    /**
     * 追加の DIMSE サービスと、それが受理する TransferCapability を登録する。start() 前に呼ぶこと。
     */
    public synchronized void addService(DicomService service, TransferCapability... capabilities) {
        if (running) {
            throw new IllegalStateException("起動後はサービスを追加できません");
        }
        extraServices.add(service);
        for (TransferCapability tc : capabilities) {
            extraCapabilities.add(tc);
        }
    }

    public synchronized void start() {
        if (running) {
            return;
        }
        device = new Device("graphy-scp");
        Connection conn = new Connection("dicom", bindAddress, port);

        ApplicationEntity ae = new ApplicationEntity(aeTitle);
        ae.setAssociationAcceptor(true);
        ae.addConnection(conn);
        // C-ECHO（常に対応）
        ae.addTransferCapability(new TransferCapability(null, UID.Verification,
                TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian));
        for (TransferCapability tc : extraCapabilities) {
            ae.addTransferCapability(tc);
        }

        device.addConnection(conn);
        device.addApplicationEntity(ae);

        DicomServiceRegistry registry = new DicomServiceRegistry();
        registry.addDicomService(new BasicCEchoSCP());
        for (DicomService svc : extraServices) {
            registry.addDicomService(svc);
        }
        device.setDimseRQHandler(registry);

        executor = Executors.newCachedThreadPool();
        scheduled = Executors.newSingleThreadScheduledExecutor();
        device.setExecutor(executor);
        device.setScheduledExecutor(scheduled);

        try {
            device.bindConnections();
            running = true;
            log.info("DICOM SCP listening: AE={} {}:{} (services={})",
                    aeTitle, bindAddress, port, extraServices.size() + 1);
        } catch (Exception e) {
            shutdownExecutors();
            throw new IllegalStateException(
                    "DICOM SCP のバインドに失敗しました (" + bindAddress + ":" + port + ")", e);
        }
    }

    public synchronized void stop() {
        if (!running) {
            return;
        }
        try {
            device.unbindConnections();
        } finally {
            shutdownExecutors();
            running = false;
            log.info("DICOM SCP stopped: AE={} {}:{}", aeTitle, bindAddress, port);
        }
    }

    public boolean isRunning() {
        return running;
    }

    public int getPort() {
        return port;
    }

    public String getAeTitle() {
        return aeTitle;
    }

    private void shutdownExecutors() {
        if (executor != null) {
            executor.shutdown();
        }
        if (scheduled != null) {
            scheduled.shutdown();
        }
    }
}

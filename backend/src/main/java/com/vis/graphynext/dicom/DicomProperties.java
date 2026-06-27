package com.vis.graphynext.dicom;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/**
 * {@code graphy.dicom.*}（application.yml）を束縛する DICOM 設定。
 *
 * <p>standalone モードの DICOM ノードとしての設定（自局 AE、SCP リスナー、受理 SOP クラス、
 * リモート AE 一覧）を保持する。これらは web モードでは未使用。
 */
@ConfigurationProperties(prefix = "graphy.dicom")
public class DicomProperties {

    /** 自局（このアプリ）の AE タイトル。SCU 発信時の Calling AE 既定値にも使う。 */
    private String localAeTitle = "GRAPHYNEXT";

    /** ローカル保管庫のルートディレクトリ（standalone）。受信 DICOM はこの下に保存する。 */
    private String storageDir = "./data/dicom";

    /**
     * C-STORE で受理する Storage SOP Class 設定（クラスパスリソース）。
     * all-storage("*") ではなく明示列挙にすることで C-GET/C-MOVE SCP と整合させる。
     */
    private String storageSopClassesResource = "/dicom/storage-sop-classes.properties";

    /** リモート AE 一覧（旧 ae.properties の後継）。C-MOVE 宛先 / Storage Commitment SCU に使う。 */
    private List<RemoteAe> remoteAes = new ArrayList<>();

    /** DIMSE リスナー（SCP）設定。 */
    private Scp scp = new Scp();

    public String getLocalAeTitle() {
        return localAeTitle;
    }

    public void setLocalAeTitle(String localAeTitle) {
        this.localAeTitle = localAeTitle;
    }

    public String getStorageDir() {
        return storageDir;
    }

    public void setStorageDir(String storageDir) {
        this.storageDir = storageDir;
    }

    public String getStorageSopClassesResource() {
        return storageSopClassesResource;
    }

    public void setStorageSopClassesResource(String storageSopClassesResource) {
        this.storageSopClassesResource = storageSopClassesResource;
    }

    public List<RemoteAe> getRemoteAes() {
        return remoteAes;
    }

    public void setRemoteAes(List<RemoteAe> remoteAes) {
        this.remoteAes = remoteAes;
    }

    /** リモート AE（C-MOVE 宛先など）。形式は ae.properties の &lt;aet&gt;=&lt;host&gt;:&lt;port&gt; に相当。 */
    public static class RemoteAe {
        private String aeTitle;
        private String host;
        private int port;

        public String getAeTitle() {
            return aeTitle;
        }

        public void setAeTitle(String aeTitle) {
            this.aeTitle = aeTitle;
        }

        public String getHost() {
            return host;
        }

        public void setHost(String host) {
            this.host = host;
        }

        public int getPort() {
            return port;
        }

        public void setPort(int port) {
            this.port = port;
        }
    }

    public Scp getScp() {
        return scp;
    }

    public void setScp(Scp scp) {
        this.scp = scp;
    }

    public static class Scp {
        /** SCP リスナーを起動するか（standalone モードで有効化する想定）。 */
        private boolean enabled = false;
        /** リスナーのバインドポート。 */
        private int port = 11112;
        /** バインドアドレス（0.0.0.0 で全 NIC）。 */
        private String bindAddress = "0.0.0.0";

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public int getPort() {
            return port;
        }

        public void setPort(int port) {
            this.port = port;
        }

        public String getBindAddress() {
            return bindAddress;
        }

        public void setBindAddress(String bindAddress) {
            this.bindAddress = bindAddress;
        }
    }
}

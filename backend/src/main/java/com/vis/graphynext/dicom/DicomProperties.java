package com.vis.graphynext.dicom;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code graphy.dicom.*}（application.yml）を束縛する DICOM 設定。
 *
 * <p>当面は Verification（C-ECHO）の疎通確認に必要な、自局 AE タイトルと
 * SCP リスナー設定のみを持つ。将来 C-STORE/C-FIND 等を足す際にここを拡張する。
 */
@ConfigurationProperties(prefix = "graphy.dicom")
public class DicomProperties {

    /** 自局（このアプリ）の AE タイトル。SCU 発信時の Calling AE 既定値にも使う。 */
    private String localAeTitle = "GRAPHYNEXT";

    /** ローカル保管庫のルートディレクトリ（standalone）。受信 DICOM はこの下に保存する。 */
    private String storageDir = "./data/dicom";

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

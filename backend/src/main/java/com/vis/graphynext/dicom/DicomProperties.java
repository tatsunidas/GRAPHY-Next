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

    /**
     * dcm4che バイナリ配布のホーム（{@code bin/getscu} 等がある場所）。
     * standalone の C-GET/C-MOVE はこの CLI ツールをプロセス起動して解決する。
     * 空のときは {@code ~/dcm4che-*} を自動検出する。
     */
    private String dcm4cheHome = "";

    /** DIMSE リスナー（SCP）設定。 */
    private Scp scp = new Scp();

    /** DIMSE の TLS（相互TLS）設定。SCP リスナーと SCU 送信の双方に適用。 */
    private Tls tls = new Tls();

    /** web モードの DICOMweb 接続先（BFF が QIDO/WADO/STOW を中継する外部 PACS）。 */
    private Dicomweb dicomweb = new Dicomweb();

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

    public String getDcm4cheHome() {
        return dcm4cheHome;
    }

    public void setDcm4cheHome(String dcm4cheHome) {
        this.dcm4cheHome = dcm4cheHome;
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

    public Tls getTls() {
        return tls;
    }

    public void setTls(Tls tls) {
        this.tls = tls;
    }

    public Dicomweb getDicomweb() {
        return dicomweb;
    }

    public void setDicomweb(Dicomweb dicomweb) {
        this.dicomweb = dicomweb;
    }

    /**
     * DIMSE TLS（相互TLS）設定。自局の鍵+証明書（key-store）と信頼する相手（trust-store）。
     * SCP は平文ポートとは別の TLS ポートで待ち受ける。
     */
    public static class Tls {
        private boolean enabled = false;
        /** TLS リスナーのポート（平文 port とは別。DICOM 慣習は 2762）。 */
        private int port = 2762;
        private String keyStore = "";
        private String keyStorePassword = "";
        private String keyStoreType = "PKCS12";
        private String trustStore = "";
        private String trustStorePassword = "";
        private String trustStoreType = "PKCS12";
        private List<String> protocols = new ArrayList<>(List.of("TLSv1.2", "TLSv1.3"));
        private List<String> cipherSuites = new ArrayList<>(List.of(
                "TLS_AES_128_GCM_SHA256",
                "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
                "TLS_RSA_WITH_AES_128_CBC_SHA"));
        /** SCP リスナーで相互TLS（クライアント証明書要求）にするか。 */
        private boolean needClientAuth = true;

        /** TLS を張れる設定が揃っているか（enabled かつ key/trust store が実在）。 */
        public boolean isUsable() {
            if (!enabled || keyStore.isBlank() || trustStore.isBlank()) {
                return false;
            }
            return new java.io.File(keyStore).isFile() && new java.io.File(trustStore).isFile();
        }

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

        public String getKeyStore() {
            return keyStore;
        }

        public void setKeyStore(String keyStore) {
            this.keyStore = keyStore;
        }

        public String getKeyStorePassword() {
            return keyStorePassword;
        }

        public void setKeyStorePassword(String keyStorePassword) {
            this.keyStorePassword = keyStorePassword;
        }

        public String getKeyStoreType() {
            return keyStoreType;
        }

        public void setKeyStoreType(String keyStoreType) {
            this.keyStoreType = keyStoreType;
        }

        public String getTrustStore() {
            return trustStore;
        }

        public void setTrustStore(String trustStore) {
            this.trustStore = trustStore;
        }

        public String getTrustStorePassword() {
            return trustStorePassword;
        }

        public void setTrustStorePassword(String trustStorePassword) {
            this.trustStorePassword = trustStorePassword;
        }

        public String getTrustStoreType() {
            return trustStoreType;
        }

        public void setTrustStoreType(String trustStoreType) {
            this.trustStoreType = trustStoreType;
        }

        public List<String> getProtocols() {
            return protocols;
        }

        public void setProtocols(List<String> protocols) {
            this.protocols = protocols;
        }

        public List<String> getCipherSuites() {
            return cipherSuites;
        }

        public void setCipherSuites(List<String> cipherSuites) {
            this.cipherSuites = cipherSuites;
        }

        public boolean isNeedClientAuth() {
            return needClientAuth;
        }

        public void setNeedClientAuth(boolean needClientAuth) {
            this.needClientAuth = needClientAuth;
        }
    }

    /** DICOMweb 接続設定（web モードの BFF 中継先）。 */
    public static class Dicomweb {
        /** RS ベース URL 例: http://host:8080/dcm4chee-arc/aets/DCM4CHEE/rs */
        private String baseUrl = "";
        /** Bearer トークン（任意）。 */
        private String bearerToken = "";

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getBearerToken() {
            return bearerToken;
        }

        public void setBearerToken(String bearerToken) {
            this.bearerToken = bearerToken;
        }
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

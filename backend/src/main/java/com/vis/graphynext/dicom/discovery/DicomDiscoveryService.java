/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.DicomScpLifecycle;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * mDNS/DNS-SD（{@code _dicom._tcp}）による、同じ LAN の DICOM 機器の自動検出と、自局の広告。
 *
 * <p><b>広告</b>は設定 {@value #ADVERTISE_KEY} が ON（既定 OFF）で、SCP が実際に動いているときだけ。
 * アプリの起動後に別スレッドで始める（失敗しても起動を止めない）。流すのは AE タイトル・ポート・TLS の有無・版だけで、
 * 患者情報・画像は一切流さない。設定の変更は SCP と同じく再起動後に反映。
 * <b>探索</b>は利用者が押したときだけ約 3 秒（常駐しない・保存しない）。
 *
 * <p>mDNS の実装は OS で分ける（{@link MdnsEngine}）。オフのときはエンジンを使わない（JmDNS の初期化も、
 * {@code dns-sd} の起動もしない）。mDNS は認証が無く、同じ LAN の誰でも名前を名乗れる。
 * 見つけた相手の自動登録・自動送信はしない（呼び出し側の責務）。
 */
@Component
@ConditionalOnProperty(prefix = "graphy.dicom.scp", name = "enabled", havingValue = "true")
public class DicomDiscoveryService {

    /** Settings(H2) に「ネットワーク上で自分の AE を知らせる」を保存するキー。frontend の registry と一致させること。 */
    public static final String ADVERTISE_KEY = "dicom.discovery.advertise";

    private static final Logger log = LoggerFactory.getLogger(DicomDiscoveryService.class);

    /** 実際に待ち受けている SCP の状態。 */
    public record ScpState(boolean running, String aeTitle, int port, int tlsPort) {
    }

    /** 探索で見つかった相手。 */
    public record Found(String name, String aeTitle, boolean aeTitleFromName, String host, int port, boolean tls, int tlsPort) {
    }

    /** 広告の状態（画面と検証用）。 */
    public record Status(boolean advertising, String reason, String serviceName, int port, boolean tls, int tlsPort,
                         Map<String, String> txt) {
    }

    private final Supplier<Boolean> advertiseEnabled;
    private final Supplier<ScpState> scpState;
    private final Supplier<List<InetAddress>> addresses;
    private final MdnsEngine engine;
    private final String appVersion;

    private MdnsEngine.Advertisement advertisement;
    private Status advertised;
    private String reason = "起動中";

    @org.springframework.beans.factory.annotation.Autowired
    public DicomDiscoveryService(SettingsService settings, DicomLocalAeService localAe,
                                 ObjectProvider<DicomScpLifecycle> scpProvider,
                                 @Value("${graphy.version:dev}") String appVersion) {
        this(() -> "true".equalsIgnoreCase(String.valueOf(settings.getAll().get(ADVERTISE_KEY)).trim()),
                () -> {
                    DicomScpLifecycle scp = scpProvider.getIfAvailable();
                    boolean running = scp != null && scp.isRunning();
                    return new ScpState(running, localAe.aeTitle(), running ? scp.getServer().getPort() : localAe.scpPort(),
                            running ? scp.getServer().getTlsPort() : -1);
                },
                DicomDiscoveryService::pickAddresses, MdnsEngine.forCurrentOs(), appVersion);
    }

    /** 試験用。広告の有無・SCP の状態・使うアドレス・エンジンを差し込める。 */
    DicomDiscoveryService(Supplier<Boolean> advertiseEnabled, Supplier<ScpState> scpState,
                          Supplier<List<InetAddress>> addresses, MdnsEngine engine, String appVersion) {
        this.advertiseEnabled = advertiseEnabled;
        this.scpState = scpState;
        this.addresses = addresses;
        this.engine = engine;
        this.appVersion = appVersion;
    }

    /** 起動後に別スレッドで広告を始める。オフのとき・SCP が止まっているときはエンジンを使わない。 */
    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        Thread t = new Thread(this::startAdvertising, "dicom-discovery-start");
        t.setDaemon(true);
        t.start();
    }

    /** 広告を始める（試験からも呼ぶ）。条件を満たさなければ何もしない。 */
    synchronized void startAdvertising() {
        if (advertisement != null) {
            return;
        }
        if (!advertiseEnabled.get()) {
            reason = "設定がオフです";
            return;
        }
        ScpState s = scpState.get();
        if (!s.running()) {
            reason = "DICOM 受信（SCP）が動いていません";
            return;
        }
        Map<String, String> txt = txtOf(s);
        try {
            advertisement = engine.advertise(s.aeTitle(), s.port(), txt, addresses.get());
            advertised = new Status(true, "広告中", s.aeTitle(), s.port(), s.tlsPort() > 0, Math.max(s.tlsPort(), 0), txt);
            reason = "広告中";
            log.info("mDNS 広告を開始: {} {} port={} tlsPort={}", MdnsEngine.TYPE, s.aeTitle(), s.port(), s.tlsPort());
        } catch (IOException | RuntimeException e) {
            reason = "広告を開始できません: " + e.getMessage();
            log.warn("mDNS 広告を開始できません: {}", e.toString());
        }
    }

    private Map<String, String> txtOf(ScpState s) {
        Map<String, String> txt = new LinkedHashMap<>();
        txt.put("aet", s.aeTitle());
        txt.put("tls", s.tlsPort() > 0 ? "1" : "0");
        txt.put("tlsPort", s.tlsPort() > 0 ? String.valueOf(s.tlsPort()) : "0");
        txt.put("app", appVersion);
        return txt;
    }

    public synchronized Status status() {
        if (advertised == null) {
            return new Status(false, reason, null, 0, false, 0, Map.of());
        }
        return advertised;
    }

    /** 約 3 秒だけ探して、見つかった相手を返す。自局は除く。結果は保存しない。 */
    public List<Found> scan() throws IOException {
        ScpState self = scpState.get();
        Map<String, Found> uniq = new LinkedHashMap<>();
        for (MdnsEngine.Peer p : engine.browse(addresses.get())) {
            boolean fromName = p.txtAet() == null || p.txtAet().isBlank();
            String aet = fromName ? p.name() : p.txtAet().trim();
            if (aet.equals(self.aeTitle()) && p.port() == self.port()) {
                continue; // 自分自身
            }
            int tlsPort = parseInt(p.txtTlsPort());
            boolean tls = "1".equals(p.txtTls()) && tlsPort > 0;
            // 同じ相手が複数の NIC で見えても 1 件にする（アドレスが違えば別の到達先として残す）
            uniq.putIfAbsent(aet + '\t' + p.host() + '\t' + p.port(),
                    new Found(p.name(), aet, fromName, p.host(), p.port(), tls, tls ? tlsPort : 0));
        }
        List<Found> out = new ArrayList<>(uniq.values());
        out.sort(Comparator.comparing(Found::name).thenComparing(Found::host));
        return out;
    }

    @jakarta.annotation.PreDestroy
    synchronized void shutdown() {
        if (advertisement != null) {
            try {
                advertisement.stop();
            } catch (RuntimeException ignore) {
                // 終了時のベストエフォート
            }
            advertisement = null;
            advertised = null;
            reason = "停止しました";
        }
    }

    private static int parseInt(String v) {
        try {
            return v == null ? 0 : Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** 仮想・VPN 系の NIC の名前（Docker・VM・トンネルなど）。広告・探索の対象にしない。 */
    private static final java.util.regex.Pattern VIRTUAL_NAME = java.util.regex.Pattern.compile(
            "^(docker|br-|veth|virbr|vmnet|vboxnet|vnet|utun|tun|tap|awdl|llw|bridge|anpi|ap\\d|tailscale|zt|wg|ham).*",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    /**
     * 使うアドレス（最大 4 つ）。自局のホスト名を正引きしない（名前解決で起動が遅れた前例）。
     * 起動していてマルチキャスト可の、物理的な NIC の非ループバック IPv4 をすべて。1 つも無ければループバック。
     */
    static List<InetAddress> pickAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual() || ni.isPointToPoint() || !ni.supportsMulticast()
                        || VIRTUAL_NAME.matcher(ni.getName()).matches()) {
                    continue;
                }
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLinkLocalAddress() && !a.isLoopbackAddress() && out.size() < 4) {
                        out.add(a);
                        break; // 1 つの NIC につき 1 つ
                    }
                }
            }
        } catch (IOException e) {
            log.debug("ネットワークインターフェースを列挙できません: {}", e.toString());
        }
        if (out.isEmpty()) {
            out.add(InetAddress.getLoopbackAddress());
        }
        return out;
    }
}

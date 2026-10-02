/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 外へ送る要求と、その承認の札。設計: fw/remote-compute-design.md §4.2。
 *
 * <ol>
 *   <li>{@link #create}: 送る内容（宛先・データセット・コード）を<b>ここで確定</b>し、内容のハッシュを付ける</li>
 *   <li>main が {@link #detail} で内容を<b>自分で取り直して</b>自分のウィンドウに出す（レンダラは内容を渡せない）</li>
 *   <li>main が {@link #decide} で承認／拒否を返す。承認は<b>見せた内容のハッシュ</b>と一致したときだけ通る</li>
 *   <li>送る直前に {@link #consume}。承認済み・5 分以内・内容が変わっていない・<b>1 回きり</b>のときだけ返す</li>
 * </ol>
 * どの出来事も {@link ComputeAuditLog} に残す。
 */
@Service
public class ComputeEgressService {

    static final Duration TTL = Duration.ofMinutes(5);

    public enum Status { PENDING, APPROVED, DENIED, CONSUMED, EXPIRED }

    /** 同意画面と監査に出すデータセットの要約（ファイルの場所は出さない）。 */
    public record DatasetSummary(String handle, String format, long bytes, String sha256, int instances,
                                 int burnedInstances, String modality) {
        static DatasetSummary of(ComputeDatasetService.Dataset d) {
            return new DatasetSummary(d.handle(), d.format().code(), d.bytes(), d.sha256(), d.instances(),
                    d.burnedInstances(), d.modality());
        }
    }

    /**
     * 送る要求。{@code contentHash} は宛先・プラグイン・データセットのハッシュ・コードから作る。
     *
     * @param anonymization 匿名化の方法（同意画面に出す）
     */
    public record EgressRequest(String id, String pluginId, String pluginName, String endpointId,
                                String endpointLabel, String endpointUrl, boolean plaintext,
                                List<DatasetSummary> datasets, String code, String codeSha256,
                                String anonymization, String contentHash, Instant createdAt, Status status) {
        EgressRequest with(Status s) {
            return new EgressRequest(id, pluginId, pluginName, endpointId, endpointLabel, endpointUrl, plaintext,
                    datasets, code, codeSha256, anonymization, contentHash, createdAt, s);
        }
    }

    /** 作らなかった。{@link #reason()} は画面で訳すコード。 */
    public static final class EgressRefused extends RuntimeException {
        private final String reason;

        public EgressRefused(String reason) {
            super(reason);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    static final String ANONYMIZATION = "DICOM PS3.15 Basic Profile + Clean Pixel Data; patient = "
            + ComputeDatasetService.PSEUDONYM;

    private final ComputeEndpointRegistry endpoints;
    private final ComputeDatasetService datasets;
    private final ComputeAuditLog audit;
    private final Map<String, EgressRequest> requests = new ConcurrentHashMap<>();

    public ComputeEgressService(ComputeEndpointRegistry endpoints, ComputeDatasetService datasets,
                                ComputeAuditLog audit) {
        this.endpoints = endpoints;
        this.datasets = datasets;
        this.audit = audit;
    }

    /**
     * 要求を作る。<b>まだ何も送らない。</b>
     *
     * @param handles 本体が作ったデータセット（{@link ComputeDatasetService#create}）。中身はプラグインに渡っていない
     */
    public EgressRequest create(String pluginId, String pluginName, String endpointId, List<String> handles,
                                String code, int maxCodeChars) {
        sweep();
        ComputeEndpointRegistry.Entry ep = endpoints.get(endpointId)
                .orElseThrow(() -> new EgressRefused("unknown-endpoint"));
        String codeProblem = CodeInspector.inspect(code, maxCodeChars);
        if (codeProblem != null) {
            auditRefused(pluginId, endpointId, codeProblem, code);
            throw new EgressRefused(codeProblem);
        }
        List<DatasetSummary> ds = new ArrayList<>();
        for (String h : handles == null ? List.<String>of() : handles) {
            ds.add(DatasetSummary.of(datasets.get(h).orElseThrow(() -> new EgressRefused("unknown-dataset"))));
        }
        String codeSha = sha256(code);
        String url = ep.endpoint().base().toString();
        boolean plaintext = "http".equals(ep.endpoint().base().getScheme());
        String id = "egr_" + UUID.randomUUID();
        String hash = contentHash(pluginId, endpointId, url, ds, codeSha);
        EgressRequest r = new EgressRequest(id, pluginId, pluginName == null ? pluginId : pluginName, endpointId,
                ep.label(), url, plaintext, List.copyOf(ds), code, codeSha, ANONYMIZATION, hash, Instant.now(),
                Status.PENDING);
        requests.put(id, r);
        ObjectNode line = base("egress-requested", r);
        line.put("codeHead", ComputeAuditLog.codeHead(code)).put("codeChars", code.length());
        audit.append(line);
        return r;
    }

    /**
     * データセットを作る前の検査（宛先・コード）。弾いたら<b>監査ログに残して</b>理由を返す。
     * 匿名化は重いので、送れないと分かっている要求に対しては走らせない。
     *
     * @return 拒否の理由。問題なければ null
     */
    public String precheck(String pluginId, String endpointId, String code, int maxCodeChars) {
        String reason = endpointId == null || endpoints.get(endpointId).isEmpty() ? "unknown-endpoint"
                : CodeInspector.inspect(code, maxCodeChars);
        if (reason != null) {
            auditRefused(pluginId, endpointId, reason, code);
        }
        return reason;
    }

    /** 送る前に弾いたこと（権限が無い等）を監査ログに残す。 */
    public void refused(String pluginId, String endpointId, String reason) {
        auditRefused(pluginId, endpointId, reason, null);
    }

    /** main が同意画面に出すための全文。期限切れ・決定済みなら空。 */
    public Optional<EgressRequest> detail(String id) {
        EgressRequest r = current(id);
        return r != null && r.status() == Status.PENDING ? Optional.of(r) : Optional.empty();
    }

    /**
     * main からの承認／拒否。承認は<b>見せた内容のハッシュ</b>が今の内容と一致するときだけ通る。
     *
     * @return 決定後の状態。対象が無い・期限切れ・決定済み・ハッシュ違いなら空
     */
    public Optional<Status> decide(String id, boolean approve, String contentHash) {
        EgressRequest r = current(id);
        if (r == null || r.status() != Status.PENDING) {
            return Optional.empty();
        }
        if (approve && !r.contentHash().equals(contentHash)) {
            audit.append(base("egress-hash-mismatch", r));
            return Optional.empty();
        }
        Status s = approve ? Status.APPROVED : Status.DENIED;
        if (!requests.replace(id, r, r.with(s))) {
            return Optional.empty(); // 同時に決定された
        }
        audit.append(base(approve ? "egress-approved" : "egress-denied", r));
        if (!approve) {
            r.datasets().forEach(d -> datasets.discard(d.handle()));
        }
        return Optional.of(s);
    }

    /**
     * 送る直前に呼ぶ。承認済み・期限内・データセットが残っている・<b>1 回目</b>のときだけ返す。
     * 返したら札は使用済みになる。
     */
    public Optional<EgressRequest> consume(String id) {
        EgressRequest r = current(id);
        if (r == null || r.status() != Status.APPROVED) {
            return Optional.empty();
        }
        for (DatasetSummary d : r.datasets()) {
            if (datasets.get(d.handle()).isEmpty()) {
                return Optional.empty();
            }
        }
        if (!requests.replace(id, r, r.with(Status.CONSUMED))) {
            return Optional.empty(); // 同時に使われた
        }
        audit.append(base("egress-consumed", r));
        return Optional.of(r);
    }

    public Optional<Status> status(String id) {
        EgressRequest r = current(id);
        return Optional.ofNullable(r == null ? null : r.status());
    }

    /** 期限切れなら EXPIRED にして返す。 */
    private EgressRequest current(String id) {
        EgressRequest r = id == null ? null : requests.get(id);
        if (r == null) {
            return null;
        }
        if ((r.status() == Status.PENDING || r.status() == Status.APPROVED)
                && r.createdAt().plus(TTL).isBefore(Instant.now())) {
            EgressRequest expired = r.with(Status.EXPIRED);
            if (requests.replace(id, r, expired)) {
                audit.append(base("egress-expired", r));
                r.datasets().forEach(d -> datasets.discard(d.handle()));
            }
            return requests.get(id);
        }
        return r;
    }

    private void sweep() {
        Instant old = Instant.now().minus(TTL.multipliedBy(12));
        requests.values().removeIf(r -> r.createdAt().isBefore(old));
        for (String id : List.copyOf(requests.keySet())) {
            current(id);
        }
    }

    private ObjectNode base(String event, EgressRequest r) {
        ObjectNode line = audit.event(event)
                .put("requestId", r.id())
                .put("pluginId", r.pluginId())
                .put("endpointId", r.endpointId())
                .put("host", hostOf(r.endpointUrl()))
                .put("plaintext", r.plaintext())
                .put("codeSha256", r.codeSha256())
                .put("contentHash", r.contentHash());
        ArrayNode arr = line.putArray("datasets");
        for (DatasetSummary d : r.datasets()) {
            arr.addObject().put("format", d.format()).put("bytes", d.bytes()).put("sha256", d.sha256())
                    .put("instances", d.instances()).put("burnedInstances", d.burnedInstances())
                    .put("modality", d.modality());
        }
        return line;
    }

    private void auditRefused(String pluginId, String endpointId, String reason, String code) {
        ObjectNode line = audit.event("egress-refused").put("pluginId", pluginId).put("endpointId", endpointId)
                .put("reason", reason);
        if (code != null) {
            line.put("codeSha256", sha256(code)).put("codeChars", code.length());
        }
        audit.append(line);
    }

    private static String hostOf(String url) {
        try {
            return java.net.URI.create(url).getHost();
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static String contentHash(String pluginId, String endpointId, String url, List<DatasetSummary> ds,
                              String codeSha) {
        StringBuilder sb = new StringBuilder("v1\n").append(pluginId).append('\n').append(endpointId).append('\n')
                .append(url).append('\n').append(codeSha).append('\n');
        for (DatasetSummary d : ds) {
            sb.append(d.handle()).append(' ').append(d.format()).append(' ').append(d.sha256()).append(' ')
                    .append(d.bytes()).append('\n');
        }
        return sha256(sb.toString());
    }

    static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

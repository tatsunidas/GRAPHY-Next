/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomEchoScu;
import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.DicomTlsService;
import com.vis.graphynext.dicom.EchoResult;
import com.vis.graphynext.dicom.qr.DimseOutcome.Kind;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 通信先との「通信テスト」。疎通（C-ECHO）→ 検索のパターン（C-FIND）→ 取り出し（C-GET）→
 * 送ってもらう（C-MOVE）の順に、<b>1 段ずつ</b>実行して結果を返す（画面が 1 段ずつ表示を進められるように）。
 *
 * <p>🔴 GET・MOVE は存在しない StudyInstanceUID で問い合わせる。相手が<b>そのサービスを受け付けるか</b>と
 * 返った status だけを見る。画像は動かない。結果に患者の値（氏名・ID・生年月日）は入れない
 * （件数・返ってきた項目の名前・相手の status だけ）。
 */
@Service
public class QrProbeService {

    private static final Logger log = LoggerFactory.getLogger(QrProbeService.class);

    private static final int RESPONSE_TIMEOUT_MS = 20_000;
    private static final long RUN_TIMEOUT_MS = 45_000;

    /** 通信テストの対象と、任意の絞り込み（患者 ID・検査日）。 */
    public record Request(String host, int port, String calledAet, boolean tls, String patientId,
                          String studyDate, String studyUid) {
    }

    /** 試す 1 段。{@code stage} は echo / find / get / move。 */
    public record Step(String id, String stage, String label) {
    }

    /**
     * 1 段の結果。{@code verdict}: ok（通った）／warn（受け付けたが相手がエラー status を返した）／ng（通らない）／
     * skipped（前提が無く試さなかった）。{@code adopt} は、この組み合わせを通信先の検索方式として採るときの値。
     */
    public record Result(String id, String stage, String label, String verdict, String kind, Integer status,
                         String errorComment, String reason, Integer count, List<String> returnedKeys,
                         long millis, String command, String evidence, String sampleStudyUid, FindProfile adopt) {
    }

    private record Combo(String id, String label, String level, FindProfile profile, List<String> keys,
                         boolean needsPatientId, boolean needsStudyUid, boolean useDate, FindProfile adopt) {
    }

    private static final List<String> BASIC_KEYS = List.of(
            "StudyInstanceUID", "PatientID", "PatientName", "StudyDate", "AccessionNumber");
    static final List<String> STANDARD_KEYS = List.of(
            "StudyInstanceUID", "PatientID", "PatientName", "PatientBirthDate", "PatientSex",
            "StudyDate", "StudyDescription", "AccessionNumber", "ModalitiesInStudy",
            "NumberOfStudyRelatedSeries", "NumberOfStudyRelatedInstances");

    private static final FindProfile D = FindProfile.DEFAULT;

    private static final List<Combo> COMBOS = List.of(
            new Combo("find-minimal", "最小の項目だけで検索", "STUDY", D, FindProfile.MINIMAL_STUDY,
                    false, false, true, D.withKeys(null, FindProfile.MINIMAL_STUDY, null)),
            new Combo("find-basic", "患者 ID・名前・検査日などを加えて検索", "STUDY", D, BASIC_KEYS,
                    false, false, true, D.withKeys(null, BASIC_KEYS, null)),
            new Combo("find-standard", "GRAPHY-Next の標準の項目で検索", "STUDY", D, STANDARD_KEYS,
                    false, false, true, D),
            new Combo("find-implicit", "標準の項目で、転送構文を Implicit VR に限って検索", "STUDY",
                    D.withTransferSyntax("implicit"), STANDARD_KEYS, false, false, true,
                    D.withTransferSyntax("implicit")),
            new Combo("find-patientroot", "患者レベル（Patient Root）で検索", "PATIENT",
                    D.withModel("PatientRoot"), List.of("PatientID", "PatientName"), false, false, false,
                    D.withModel("PatientRoot")),
            new Combo("find-patientroot-study", "患者 ID を指定して、その患者の検査を検索（Patient Root）", "STUDY",
                    D.withModel("PatientRoot"), BASIC_KEYS, true, false, true, D.withModel("PatientRoot")),
            new Combo("find-series", "シリーズレベルで検索", "SERIES", D, FindProfile.MINIMAL_SERIES,
                    false, true, false, null),
            new Combo("find-utf8", "文字コード（UTF-8）を付けて検索", "STUDY", D.withCharset("ISO_IR 192"),
                    BASIC_KEYS, false, false, true, D.withKeys(null, BASIC_KEYS, null).withCharset("ISO_IR 192")));

    private final Dcm4cheTools tools;
    private final DimseQrService qr;
    private final DicomLocalAeService localAe;
    private final DicomEchoScu echoScu;
    private final DicomTlsService tlsService;

    public QrProbeService(Dcm4cheTools tools, DimseQrService qr, DicomLocalAeService localAe,
                          DicomEchoScu echoScu, DicomTlsService tlsService) {
        this.tools = tools;
        this.qr = qr;
        this.localAe = localAe;
        this.echoScu = echoScu;
        this.tlsService = tlsService;
    }

    /** 試す段の一覧（実行順）。 */
    public List<Step> plan() {
        List<Step> steps = new ArrayList<>();
        steps.add(new Step("echo", "echo", "相手につながる"));
        for (Combo c : COMBOS) {
            steps.add(new Step(c.id(), "find", c.label()));
        }
        steps.add(new Step("get", "get", "画像を取り出せる（C-GET）"));
        steps.add(new Step("move", "move", "画像を送ってもらえる（C-MOVE）"));
        return steps;
    }

    public Result run(String stepId, Request req) {
        long t0 = System.nanoTime();
        try {
            return switch (stepId) {
                case "echo" -> echo(req, t0);
                case "get" -> retrieve("get", "画像を取り出せる（C-GET）", req, t0);
                case "move" -> retrieve("move", "画像を送ってもらえる（C-MOVE）", req, t0);
                default -> {
                    Combo c = COMBOS.stream().filter(x -> x.id().equals(stepId)).findFirst()
                            .orElseThrow(() -> new IllegalArgumentException("unknown step: " + stepId));
                    yield find(c, req, t0);
                }
            };
        } catch (IOException e) {
            log.warn("通信テストの実行に失敗: step={} ({})", stepId, e.toString());
            return new Result(stepId, stageOf(stepId), stepId, "ng", Kind.UNKNOWN.name(), null, null,
                    e.getMessage(), null, List.of(), ms(t0), null, null, null, null);
        }
    }

    private static String stageOf(String id) {
        return id.startsWith("find") ? "find" : id;
    }

    private Result echo(Request req, long t0) {
        EchoResult r = echoScu.echo(req.host(), req.port(), req.calledAet(), localAe.aeTitle(),
                req.tls() ? tlsService.effective() : null);
        if (r.success()) {
            return new Result("echo", "echo", "相手につながる", "ok", Kind.OK.name(), r.status(), null, null,
                    null, List.of(), r.elapsedMs(), null, null, null, null);
        }
        DimseOutcome o = DimseOutcome.parse(1, r.message());
        return new Result("echo", "echo", "相手につながる", "ng", o.kind().name(), null, null,
                o.reason() != null ? o.reason() : r.message(), null, List.of(), r.elapsedMs(), null,
                DimseOutcome.evidence(r.message()), null, null);
    }

    private Result find(Combo c, Request req, long t0) throws IOException {
        if (c.needsPatientId() && blank(req.patientId())) {
            return skipped(c.id(), "find", c.label(), "患者 ID を入れると試せます");
        }
        if (c.needsStudyUid() && blank(req.studyUid())) {
            return skipped(c.id(), "find", c.label(), "検査が 1 件見つかると試せます");
        }
        Map<String, String> leading = c.needsStudyUid() ? Map.of("StudyInstanceUID", req.studyUid()) : null;
        Map<String, String> match = new LinkedHashMap<>();
        if (!blank(req.patientId()) && !"SERIES".equals(c.level())) {
            match.put("PatientID", req.patientId());
        }
        if (c.useDate() && !blank(req.studyDate())) {
            match.put("StudyDate", req.studyDate());
        }
        FindProfile p = c.profile();
        if (p.responseTimeoutMs() == null) {
            p = new FindProfile(p.model(), p.patientKeys(), p.studyKeys(), p.seriesKeys(), p.wildcard(),
                    p.transferSyntax(), p.charset(), RESPONSE_TIMEOUT_MS);
        }
        Path tool = tools.require("findscu");
        Path outDir = Files.createTempDirectory("graphy-probe-find-");
        try {
            List<String> cmd = FindArgs.build(tool.toString(), localAe.aeTitle(), req.calledAet(), req.host(),
                    req.port(), c.level(), p, leading, c.keys(), match, outDir.toString(), qr.tlsArgs(req.tls()));
            Dcm4cheTools.Result r = runTool(cmd);
            if (r == null) {
                return new Result(c.id(), "find", c.label(), "ng", Kind.TIMEOUT.name(), null, null, null, null,
                        List.of(), ms(t0), mask(cmd), null, null, null);
            }
            DimseOutcome o = DimseOutcome.parse(r.exitCode(), r.output());
            List<Attributes> rsp = o.ok() ? readResponses(outDir) : List.of();
            List<String> returned = new ArrayList<>();
            String sample = null;
            for (String key : c.keys()) {
                int tag = ElementDictionary.tagForKeyword(key, null);
                if (rsp.stream().anyMatch(a -> a.containsValue(tag))) {
                    returned.add(key);
                }
            }
            for (Attributes a : rsp) {
                if (sample == null && a.containsValue(Tag.StudyInstanceUID)) {
                    sample = a.getString(Tag.StudyInstanceUID);
                }
            }
            return new Result(c.id(), "find", c.label(), o.ok() ? "ok" : "ng", o.kind().name(), o.status(),
                    o.errorComment(), o.reason(), o.ok() ? rsp.size() : null, returned, ms(t0), mask(cmd),
                    DimseOutcome.evidence(r.output()), sample, o.ok() ? c.adopt() : null);
        } finally {
            deleteQuietly(outDir);
        }
    }

    /** GET / MOVE: 存在しない UID で問い合わせ、相手がサービスを受け付けるかを見る。画像は動かない。 */
    private Result retrieve(String stage, String label, Request req, long t0) throws IOException {
        String uid = "2.25." + new BigInteger(1, uuidBytes());
        boolean get = "get".equals(stage);
        Path tool = tools.require(get ? "getscu" : "movescu");
        Path outDir = Files.createTempDirectory("graphy-probe-" + stage + "-");
        try {
            List<String> cmd = new ArrayList<>(List.of(tool.toString(),
                    "-b", localAe.aeTitle(), "-c", req.calledAet() + "@" + req.host() + ":" + req.port()));
            if (!get) {
                cmd.add("--dest");
                cmd.add(localAe.aeTitle());
            }
            cmd.addAll(List.of("-L", "STUDY", "-m", "StudyInstanceUID=" + uid));
            if (get) {
                cmd.add("--directory");
                cmd.add(outDir.toString());
            }
            cmd.addAll(qr.tlsArgs(req.tls()));
            Dcm4cheTools.Result r = runTool(cmd);
            if (r == null) {
                return new Result(stage, stage, label, "ng", Kind.TIMEOUT.name(), null, null, null, null,
                        List.of(), ms(t0), mask(cmd), null, null, null);
            }
            DimseOutcome o = DimseOutcome.parse(r.exitCode(), r.output());
            // 受け付けたうえで status を返した（存在しない UID なので、エラー status になることがある）
            String verdict = o.ok() ? "ok" : o.kind() == Kind.STATUS_ERROR ? "warn" : "ng";
            return new Result(stage, stage, label, verdict, o.kind().name(), o.status(), o.errorComment(),
                    o.reason(), null, List.of(), ms(t0), mask(cmd), DimseOutcome.evidence(r.output()), null, null);
        } finally {
            deleteQuietly(outDir);
        }
    }

    /** 時間切れのとき null。 */
    private Dcm4cheTools.Result runTool(List<String> cmd) throws IOException {
        try {
            return tools.run(cmd, RUN_TIMEOUT_MS);
        } catch (IOException e) {
            if (e.getMessage() != null && e.getMessage().contains("タイムアウト")) {
                return null;
            }
            throw e;
        }
    }

    private static List<Attributes> readResponses(Path outDir) {
        List<Attributes> out = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            for (Path f : walk.filter(Files::isRegularFile).filter(x -> x.getFileName().toString().endsWith(".dcm"))
                    .sorted(Comparator.comparing(Path::toString)).toList()) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    out.add(in.readDataset());
                } catch (Exception e) {
                    log.warn("通信テストの応答を読めませんでした: {}", f.getFileName());
                }
            }
        } catch (IOException e) {
            log.warn("通信テストの応答の列挙に失敗: {}", e.toString());
        }
        return out;
    }

    /** 報告にそのまま貼れるよう、患者に関わる照合値は伏せる。 */
    static String mask(List<String> cmd) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < cmd.size(); i++) {
            String a = cmd.get(i);
            if (i > 0 && "-m".equals(cmd.get(i - 1)) && a.contains("=")) {
                String key = a.substring(0, a.indexOf('='));
                if (key.equals("PatientID") || key.equals("PatientName") || key.equals("AccessionNumber")) {
                    a = key + "=<値>";
                }
            }
            if (a.startsWith("/") || a.contains("\\")) {
                a = Path.of(a).getFileName() == null ? a : "…/" + Path.of(a).getFileName();
            }
            out.add(a);
        }
        return String.join(" ", out);
    }

    private static Result skipped(String id, String stage, String label, String why) {
        return new Result(id, stage, label, "skipped", null, null, null, why, null, List.of(), 0, null, null,
                null, null);
    }

    private static byte[] uuidBytes() {
        UUID u = UUID.randomUUID();
        return java.nio.ByteBuffer.allocate(16).putLong(u.getMostSignificantBits()).putLong(u.getLeastSignificantBits())
                .array();
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static long ms(long t0) {
        return (System.nanoTime() - t0) / 1_000_000;
    }

    private static void deleteQuietly(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException ignore) {
            // 一時ディレクトリの掃除に失敗しても結果には影響しない
        }
    }
}

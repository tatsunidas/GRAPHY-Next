package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.vis.graphynext.dicom.DicomProperties;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

/**
 * standalone の Query/Retrieve。dcm4che CLI ツールを起動して解決する。
 *
 * <ul>
 *   <li>C-GET: {@code getscu} で一時ディレクトリへ取得し、{@link DicomStorageService} に取り込む。</li>
 *   <li>C-MOVE: {@code movescu --dest <自局AE>} で、リモート PACS から自前 SCP へ送らせる
 *       （受信は稼働中の SCP が索引へ取り込む）。</li>
 * </ul>
 */
@Service
public class DimseQrService {

    private static final Logger log = LoggerFactory.getLogger(DimseQrService.class);

    private static final long TOOL_TIMEOUT_MS = 120_000;

    private final Dcm4cheTools tools;
    private final DicomStorageService storage;
    private final DicomProperties props;

    public DimseQrService(Dcm4cheTools tools, DicomStorageService storage, DicomProperties props) {
        this.tools = tools;
        this.storage = storage;
        this.props = props;
    }

    /**
     * C-GET で study を取得し、取得した各インスタンスをローカル索引へ取り込む。
     *
     * @return 取り込んだインスタンス数
     */
    public int getStudy(String host, int port, String calledAet, String studyUid) throws IOException {
        Path tool = tools.require("getscu");
        Path outDir = Files.createTempDirectory("graphy-getscu-");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", props.getLocalAeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "-L", "STUDY",
                "-m", "StudyInstanceUID=" + studyUid,
                "--directory", outDir.toString()));
        cmd.addAll(tlsArgs());
        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            throw new IOException("getscu 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        int count = 0;
        try (Stream<Path> walk = Files.walk(outDir)) {
            List<Path> files = walk.filter(Files::isRegularFile).toList();
            for (Path f : files) {
                try {
                    storage.ingest(f);
                    count++;
                } catch (Exception e) {
                    log.warn("取得ファイルの取り込みに失敗: {} ({})", f, e.toString());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        log.info("C-GET 完了: study={} 取り込み {} 件", studyUid, count);
        return count;
    }

    /**
     * C-MOVE で study を移動先 AE へ送らせる。destAet を自局 AE にすれば自前 SCP が受信して索引化する。
     *
     * @return movescu の終了コード（0 で成功）
     */
    public int moveStudy(String host, int port, String calledAet, String studyUid, String destAet)
            throws IOException {
        Path tool = tools.require("movescu");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", props.getLocalAeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "--dest", destAet,
                "-L", "STUDY",
                "-m", "StudyInstanceUID=" + studyUid));
        cmd.addAll(tlsArgs());
        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            throw new IOException("movescu 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        log.info("C-MOVE 完了: study={} -> dest={}", studyUid, destAet);
        return r.exitCode();
    }

    /** TLS が設定済みなら getscu/movescu 用の TLS 引数を返す（鍵/信頼ストア + cipher/protocol）。 */
    private List<String> tlsArgs() {
        DicomProperties.Tls tls = props.getTls();
        if (!tls.isUsable()) {
            return List.of();
        }
        List<String> a = new ArrayList<>();
        a.add("--key-store");
        a.add(tls.getKeyStore());
        a.add("--key-store-pass");
        a.add(tls.getKeyStorePassword());
        a.add("--key-store-type");
        a.add(tls.getKeyStoreType());
        a.add("--key-pass");
        a.add(tls.getKeyStorePassword());
        a.add("--trust-store");
        a.add(tls.getTrustStore());
        a.add("--trust-store-pass");
        a.add(tls.getTrustStorePassword());
        a.add("--trust-store-type");
        a.add(tls.getTrustStoreType());
        for (String c : tls.getCipherSuites()) {
            a.add("--tls-cipher");
            a.add(c);
        }
        for (String p : tls.getProtocols()) {
            a.add("--tls-protocol");
            a.add(p);
        }
        return a;
    }

    private static String tail(String s) {
        if (s == null) {
            return "";
        }
        return s.length() <= 800 ? s : s.substring(s.length() - 800);
    }

    private static void deleteQuietly(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignore) {
                    // ベストエフォート
                }
            });
        } catch (IOException ignore) {
            // ベストエフォート
        }
    }
}

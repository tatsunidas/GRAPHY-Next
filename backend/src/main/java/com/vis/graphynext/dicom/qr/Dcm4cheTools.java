package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * dcm4che の CLI ツール（getscu / movescu / findscu / storescu）をプロセス起動するヘルパ。
 *
 * <p>standalone の C-GET/C-MOVE は自前で DIMSE クライアントを実装せず、実績ある dcm4che
 * ツールを起動して解決する。ツールの場所は {@code graphy.dicom.dcm4che-home}、未設定なら
 * {@code ~/dcm4che-*} を自動検出する。
 */
@Component
public class Dcm4cheTools {

    private static final Logger log = LoggerFactory.getLogger(Dcm4cheTools.class);

    private final DicomProperties props;

    public Dcm4cheTools(DicomProperties props) {
        this.props = props;
    }

    public record Result(int exitCode, String output) {
        public boolean ok() {
            return exitCode == 0;
        }
    }

    /** 指定ツールの実行ファイルを解決する（Windows は .bat も考慮）。 */
    public Optional<Path> tool(String name) {
        List<Path> bases = new ArrayList<>();
        String home = props.getDcm4cheHome();
        if (home != null && !home.isBlank()) {
            bases.add(Path.of(home));
        } else {
            // ~/dcm4che-* を自動検出
            Path userHome = Path.of(System.getProperty("user.home"));
            try (DirectoryStream<Path> s = Files.newDirectoryStream(userHome, "dcm4che-*")) {
                for (Path d : s) {
                    bases.add(d);
                }
            } catch (IOException ignore) {
                // 検出不可
            }
        }
        boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
        for (Path base : bases) {
            for (String exe : win ? new String[]{name + ".bat", name + ".exe", name} : new String[]{name}) {
                Path p = base.resolve("bin").resolve(exe);
                if (Files.isExecutable(p)) {
                    return Optional.of(p);
                }
            }
        }
        return Optional.empty();
    }

    public boolean isAvailable(String name) {
        return tool(name).isPresent();
    }

    public Path require(String name) {
        return tool(name).orElseThrow(() -> new IllegalStateException(
                "dcm4che ツール '" + name + "' が見つかりません。graphy.dicom.dcm4che-home を設定してください。"));
    }

    /** コマンドを実行し、標準出力/標準エラーを結合して返す。timeout 超過は例外。 */
    public Result run(List<String> command, long timeoutMs) throws IOException {
        log.debug("exec: {}", String.join(" ", command)); // 外部ツール起動: トラブル時に DEBUG で確認
        Process p = new ProcessBuilder(command).redirectErrorStream(true).start();
        StringBuilder out = new StringBuilder();
        try (var r = p.inputReader()) {
            char[] buf = new char[4096];
            int n;
            while ((n = r.read(buf)) != -1) {
                out.append(buf, 0, n);
            }
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                throw new IOException("ツール実行がタイムアウト: " + String.join(" ", command));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("ツール実行が中断されました", e);
        }
        return new Result(p.exitValue(), out.toString());
    }
}

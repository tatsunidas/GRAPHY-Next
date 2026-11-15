package automator;

import com.vis.graphynext.plugin.spi.GraphyPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * H78・H79 の検証用（形式変換の代わり）: 本体が渡した NIfTI（.nii.gz）を**自分の JAR のコードで読んで**ヘッダを返し、
 * 自分の一時フォルダ（tmp/graphy-plugin-nifti/nifti-bridge-check/&lt;job&gt;/）へ書き戻す。
 * {@code args.mode}: {@code "inspect"}（読むだけ）／{@code "copy"}（読んで書き戻し、そのパスを返す）／
 * {@code "nosform"}（sform・qform を 0 にして書き戻す＝向きが NIfTI に無い形）。
 */
public class NiftiBridgeProbe implements GraphyPlugin {

    @Override
    public Object run(Map<String, Object> args) throws Exception {
        Path in = Path.of(String.valueOf(args.get("path")));
        String mode = String.valueOf(args.getOrDefault("mode", "inspect"));
        byte[] raw;
        try (InputStream gz = new GZIPInputStream(Files.newInputStream(in))) {
            raw = gz.readAllBytes();
        }
        ByteBuffer h = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sizeofHdr", h.getInt(0));
        out.put("dim0", (int) h.getShort(40));
        out.put("nx", (int) h.getShort(42));
        out.put("ny", (int) h.getShort(44));
        out.put("nz", (int) h.getShort(46));
        out.put("nt", (int) h.getShort(48));
        out.put("datatype", (int) h.getShort(70));
        out.put("magic", "" + (char) raw[344] + (char) raw[345] + (char) raw[346]);
        out.put("bytes", raw.length);
        if (!"inspect".equals(mode)) {
            if ("nosform".equals(mode)) {
                h.putShort(252, (short) 0); // qform_code
                h.putShort(254, (short) 0); // sform_code
            }
            Path dir = Path.of(System.getProperty("java.io.tmpdir"), "graphy-plugin-nifti", "nifti-bridge-check",
                    UUID.randomUUID().toString());
            Files.createDirectories(dir);
            Path f = dir.resolve("out.nii.gz");
            try (OutputStream o = new GZIPOutputStream(Files.newOutputStream(f))) {
                o.write(raw);
            }
            out.put("path", f.toString());
        }
        return out;
    }
}

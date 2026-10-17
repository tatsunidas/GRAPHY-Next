package automator;

import com.vis.graphynext.plugin.spi.GraphyPlugin;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** H68 の検証用: 自分の一時フォルダ（tmp/graphy-plugin-microscopy/<id>/<job>/）に uint8 4×3×2 のチャネルを 2 本書く。 */
public class MicroscopyProbe implements GraphyPlugin {

    @Override
    public Object run(Map<String, Object> args) throws Exception {
        Path dir = Path.of(System.getProperty("java.io.tmpdir"), "graphy-plugin-microscopy", "microscopy-check",
                UUID.randomUUID().toString());
        Files.createDirectories(dir);
        String[] paths = new String[2];
        for (int c = 0; c < 2; c++) {
            byte[] px = new byte[4 * 3 * 2];
            for (int i = 0; i < px.length; i++) {
                px[i] = (byte) (c * 100 + i);
            }
            Path f = dir.resolve("ch" + c + ".raw");
            Files.write(f, px);
            paths[c] = f.toString();
        }
        return Map.of("paths", List.of(paths));
    }
}

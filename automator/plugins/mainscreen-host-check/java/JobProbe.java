/*
 * 実機検証用のバックエンド面（H45 runBackendJob の検査用）。スパイクが javac で JAR にする。
 * SPI（com.vis.graphynext.plugin.spi.GraphyPlugin）だけに依存する。
 */
package automator;

import com.vis.graphynext.plugin.spi.GraphyPlugin;

import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;

public class JobProbe implements GraphyPlugin {

    @Override
    @SuppressWarnings("unchecked")
    public Object run(Map<String, Object> args) throws Exception {
        BiConsumer<Double, String> progress = args.get("__progress") instanceof BiConsumer<?, ?> p
                ? (BiConsumer<Double, String>) p : null;
        BooleanSupplier cancelled = args.get("__cancelled") instanceof BooleanSupplier c ? c : null;
        String op = String.valueOf(args.getOrDefault("op", "progress"));
        switch (op) {
            case "progress": {
                int steps = 5;
                for (int i = 1; i <= steps; i++) {
                    Thread.sleep(150);
                    if (progress != null) progress.accept((double) i / steps, "step " + i);
                }
                return Map.of("steps", steps, "hadProgress", progress != null);
            }
            case "wait-cancel": {
                long end = System.currentTimeMillis() + 20_000;
                while (System.currentTimeMillis() < end) {
                    if (cancelled != null && cancelled.getAsBoolean()) return Map.of("sawCancel", true);
                    Thread.sleep(50);
                }
                return Map.of("sawCancel", false);
            }
            case "fail":
                throw new IllegalStateException("probe-fail");
            default:
                return Map.of("hadProgress", progress != null, "hadCancelled", cancelled != null);
        }
    }
}

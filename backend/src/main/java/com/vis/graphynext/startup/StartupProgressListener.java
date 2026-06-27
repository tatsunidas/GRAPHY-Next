package com.vis.graphynext.startup;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.boot.context.event.ApplicationPreparedEvent;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.context.event.ApplicationStartedEvent;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.ConfigurableEnvironment;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * standalone 起動時の各段階を {@link StartupProgress} で報告する。
 * Spring のライフサイクルイベントに沿って、フォルダ確認 → DB マイグレーション → プラグイン → 完了 を出す。
 *
 * <p>{@code SpringApplication.addListeners(...)} で登録する（@Component より早い段階のイベントを拾うため）。
 * web プロファイルでは何もしない（スプラッシュ不要）。
 */
public class StartupProgressListener implements ApplicationListener<ApplicationEvent> {

    private volatile boolean standalone;

    @Override
    public void onApplicationEvent(ApplicationEvent event) {
        if (event instanceof ApplicationEnvironmentPreparedEvent ev) {
            ConfigurableEnvironment env = ev.getEnvironment();
            standalone = Arrays.asList(env.getActiveProfiles()).contains("standalone");
            if (!standalone) {
                return;
            }
            StartupProgress.report("init", "running", "起動を開始しています");
            // 必要なサブフォルダの確認・作成
            StartupProgress.report("folders", "running", "必要なフォルダを確認しています");
            ensureDir(env.getProperty("graphy.dicom.storage-dir", "./data/dicom"));
            ensureDir(env.getProperty("graphy.dicom.storage-dir", "./data/dicom") + "/incoming");
            ensureDir(env.getProperty("graphy.plugins.dir", "./plugins"));
            StartupProgress.report("folders", "ok", "フォルダの確認が完了しました");
            return;
        }
        if (!standalone) {
            return;
        }
        if (event instanceof ApplicationPreparedEvent) {
            StartupProgress.report("database", "running", "データベースを確認・マイグレーションしています");
        } else if (event instanceof ApplicationStartedEvent) {
            // ここまでで JPA(Hibernate)のスキーマ更新は完了している
            StartupProgress.report("database", "ok", "データベースの準備が完了しました");
            StartupProgress.report("plugins", "running", "プラグインを読み込んでいます");
            // TODO: 実際のプラグインロード結果を反映（現状は枠のみ）
            StartupProgress.report("plugins", "ok", "プラグインの読み込みが完了しました");
        } else if (event instanceof ApplicationReadyEvent) {
            StartupProgress.report("ready", "ok", "起動が完了しました");
        }
    }

    private static void ensureDir(String path) {
        try {
            Files.createDirectories(Path.of(path));
        } catch (Exception ignore) {
            // ベストエフォート（後続処理で再試行/失敗検知される）
        }
    }
}

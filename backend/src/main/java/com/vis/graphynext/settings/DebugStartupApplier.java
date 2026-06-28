package com.vis.graphynext.settings;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 起動時に、永続化されたデバッグモード設定を読み取りログレベルへ反映する。
 * （再起動後もデバッグモードが維持される）
 */
@Component
public class DebugStartupApplier {

    private final SettingsService settings;
    private final DebugLogControl debugLogControl;

    public DebugStartupApplier(SettingsService settings, DebugLogControl debugLogControl) {
        this.settings = settings;
        this.debugLogControl = debugLogControl;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void applyPersisted() {
        String v = settings.getAll().get(SettingsService.DEBUG_MODE_KEY);
        if (v != null) {
            debugLogControl.apply(Boolean.parseBoolean(v));
        }
    }
}

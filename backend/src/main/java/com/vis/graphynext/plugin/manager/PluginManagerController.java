/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.Callable;

/**
 * プラグインマネージャ REST（取得・導入・更新・削除）。実行レイヤの {@code /api/plugins} とは別系統。
 * 設計: fw/plugin-manager-design.md。
 *
 * <ul>
 *   <li>{@code GET    /api/plugin-manager/status} — 導入操作の可否</li>
 *   <li>{@code GET    /api/plugin-manager/installed} — 導入済み一覧（台帳）</li>
 *   <li>{@code GET    /api/plugin-manager/versions?repo=} — {@code owner/repo} のリリース一覧</li>
 *   <li>{@code POST   /api/plugin-manager/install/github} — {repo, version?} から導入</li>
 *   <li>{@code POST   /api/plugin-manager/install/file} — ローカル zip を導入（オフライン）</li>
 *   <li>{@code POST   /api/plugin-manager/{id}/reinstall|enable|disable}</li>
 *   <li>{@code DELETE /api/plugin-manager/{id}} — アンインストール</li>
 * </ul>
 *
 * 例外の写像: 403（モード非許可）/ 404（未導入）/ 422（検証失敗）/ 400（不正引数）/ 500。
 */
@RestController
@RequestMapping("/api/plugin-manager")
public class PluginManagerController {

    private static final Logger log = LoggerFactory.getLogger(PluginManagerController.class);

    private final PluginManagerService service;

    public PluginManagerController(PluginManagerService service) {
        this.service = service;
    }

    @GetMapping("/status")
    public PluginManagerService.ManagerStatus status() {
        return service.managerStatus();
    }

    @GetMapping("/installed")
    public List<InstalledPlugin> installed() {
        return service.installed();
    }

    @GetMapping("/versions")
    public ResponseEntity<Object> versions(@RequestParam String repo) {
        return handle(() -> service.versions(repo));
    }

    @PostMapping("/inspect/github")
    public ResponseEntity<Object> inspectGithub(@RequestBody InstallRequest req) {
        if (req == null || req.repo() == null || req.repo().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "repo is required (owner/repo)"));
        }
        return handle(() -> service.inspectGitHub(req.repo(), req.version()));
    }

    @PostMapping("/inspect/file")
    public ResponseEntity<Object> inspectFile(@RequestParam("file") MultipartFile file) {
        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "file is required"));
        }
        return handle(() -> service.inspectFile(file.getBytes(), file.getOriginalFilename()));
    }

    @PostMapping("/install/github")
    public ResponseEntity<Object> installGithub(@RequestBody InstallRequest req) {
        if (req == null || req.repo() == null || req.repo().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "repo is required (owner/repo)"));
        }
        return handle(() -> service.installFromGitHub(
                req.repo(), req.version(), req.confirmedSha256(), req.acknowledgeUnverified()));
    }

    @PostMapping("/install/file")
    public ResponseEntity<Object> installFile(@RequestParam("file") MultipartFile file,
                                              @RequestParam(value = "confirmedSha256", required = false)
                                              String confirmedSha256) {
        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "file is required"));
        }
        return handle(() -> service.installFromFile(file.getBytes(), file.getOriginalFilename(), confirmedSha256));
    }

    @PostMapping("/{id}/reinstall")
    public ResponseEntity<Object> reinstall(@PathVariable String id) {
        return handle(() -> service.reinstall(id));
    }

    @PostMapping("/{id}/enable")
    public ResponseEntity<Object> enable(@PathVariable String id) {
        return handle(() -> { service.enable(id); return Map.of("id", id, "enabled", true); });
    }

    @PostMapping("/{id}/disable")
    public ResponseEntity<Object> disable(@PathVariable String id) {
        return handle(() -> { service.disable(id); return Map.of("id", id, "enabled", false); });
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Object> uninstall(@PathVariable String id) {
        return handle(() -> {
            PluginInstaller.UninstallResult r = service.uninstall(id);
            if (!r.existed()) throw new NoSuchElementException("plugin not installed: " + id);
            // ファイルを掴まれていて今は消せなかった場合も「削除済み」で返す（台帳からは外れ、
            // 走査対象からも外れ、次回起動時に実体が消える）。UI は削除後に再起動バナーを出す。
            return Map.of("id", id, "removed", true, "restartRequired", r.pendingRestart());
        });
    }

    /** 例外を HTTP ステータスへ一元写像する。 */
    private ResponseEntity<Object> handle(Callable<Object> action) {
        try {
            return ResponseEntity.ok(action.call());
        } catch (PluginManagerForbiddenException e) {
            return ResponseEntity.status(403).body(Map.of("error", e.getMessage()));
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(404).body(Map.of("error", e.getMessage()));
        } catch (PluginInstallException e) {
            return ResponseEntity.status(422).body(Map.of("error", e.getMessage()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", String.valueOf(e.getMessage())));
        } catch (Exception e) {
            log.warn("[plugin-manager] operation failed: {}", e.getMessage());
            return ResponseEntity.status(500).body(Map.of("error", String.valueOf(e.getMessage())));
        }
    }

    /**
     * {@code POST /inspect/github} および {@code /install/github} のボディ。
     *
     * @param confirmedSha256       同意画面で提示された zip の sha256（TOCTOU 対策・検査を経た導入では必須運用）
     * @param acknowledgeUnverified sha256 資産が無く完全性を検証できないことを承知で導入するか
     */
    public record InstallRequest(String repo, String version,
                                 String confirmedSha256, boolean acknowledgeUnverified) {}
}

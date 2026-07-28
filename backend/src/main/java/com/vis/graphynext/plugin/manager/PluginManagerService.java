/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.PluginDescriptor;
import com.vis.graphynext.plugin.PluginProperties;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;

/**
 * プラグインマネージャの取りまとめ（取得元の解決＋ライフサイクル）。
 *
 * <p>導入系（install / update / reinstall / enable / disable / uninstall）は次の 3 条件が
 * すべて揃ったときだけ許可する（設計: fw/plugin-manager-design.md §5）:
 * <ol>
 *   <li>standalone であること — web は共有サーバーのため運営キュレーション前提で 403</li>
 *   <li>{@code graphy.plugins.manager-enabled=true} — この環境で管理機能を許すか（管理者ゲート）</li>
 *   <li>{@link InstallOptIn} — ユーザーが環境設定で明示的に導入を許可したか</li>
 * </ol>
 * 一覧取得は常に可能。
 */
@Service
public class PluginManagerService {

    private static final Logger log = LoggerFactory.getLogger(PluginManagerService.class);

    private final PluginProperties props;
    private final GitHubReleaseClient github;
    private final Environment env;
    private final InstallOptIn optIn;
    private final ObjectMapper mapper;
    private final PluginInstaller installer;

    public PluginManagerService(PluginProperties props,
                                ObjectMapper mapper,
                                GitHubReleaseClient github,
                                Environment env,
                                InstallOptIn optIn,
                                @Value("${graphy.version:dev}") String coreVersion) {
        this.props = props;
        this.github = github;
        this.env = env;
        this.optIn = optIn;
        this.mapper = mapper;
        Path dir = Path.of(props.getDir() == null || props.getDir().isBlank() ? "./plugins" : props.getDir())
                .toAbsolutePath().normalize();
        this.installer = new PluginInstaller(dir, mapper, coreVersion);
    }

    /** 導入済み一覧（台帳）。読み取りは常に可能。 */
    public List<InstalledPlugin> installed() {
        return installer.installed();
    }

    /** マネージャの状態（フロントが導入 UI とオプトイン トグルを出すか判断するため）。 */
    public ManagerStatus managerStatus() {
        return new ManagerStatus(canMutate(), isStandalone(), props.isManagerEnabled(),
                optIn.isEnabled(), canOptIn(),
                props.getGithubToken() != null && !props.getGithubToken().isBlank());
    }

    /** {@code owner/repo} の互換フィルタ済みバージョン一覧（新しい順）。 */
    public List<AvailableVersion> versions(String repo) {
        requireMutable(); // ネットワーク取得を伴うため導入可能時のみ
        List<GitHubReleaseClient.Release> rels = github.listReleases(repo, token());
        return rels.stream()
                .sorted(byTagDesc())
                .map(r -> new AvailableVersion(
                        r.tagName(), r.publishedAt(), r.prerelease(),
                        findZipAsset(r).map(GitHubReleaseClient.Asset::name).orElse(null)))
                .toList();
    }

    /**
     * GitHub Release の zip を取得して<b>中身を検査するだけ</b>（展開・保存はしない）。
     * 同意画面はこの結果を見せ、ユーザーが承諾したら {@code confirmedSha256} 付きで install を呼ぶ。
     */
    public PluginPreview inspectGitHub(String repo, String version) {
        requireMutable();
        Fetched f = fetchFromGitHub(repo, version);
        return preview(f.bytes(), new InstalledPlugin.Source("github", repo), f.expectedSha(),
                f.minisig(), f.publishedKey());
    }

    /** ローカル zip の検査（オフライン導入の同意画面用）。 */
    public PluginPreview inspectFile(byte[] zip, String filename) {
        requireMutable();
        return preview(zip, new InstalledPlugin.Source("file", filename), null, null, null);
    }

    /**
     * GitHub Release からインストール（version 未指定なら最新の非 prerelease）。
     *
     * @param confirmedSha256 同意画面で提示した zip の sha256。指定すると、実際に取得したものが
     *                        それと一致しない限り導入しない（同意〜導入の間に資産が差し替わる TOCTOU 対策）
     * @param acknowledgeUnverified {@code <zip>.sha256} 資産が無く完全性を検証できない場合でも、
     *                        ユーザーが承知のうえ導入するか。false なら拒否する
     */
    public InstalledPlugin installFromGitHub(String repo, String version,
                                             String confirmedSha256, boolean acknowledgeUnverified)
            throws IOException {
        requireMutable();
        Fetched f = fetchFromGitHub(repo, version);
        InstalledPlugin.Source source = new InstalledPlugin.Source("github", repo);

        // 署名は「あるのに壊れている／鍵が変わった」を最も重く扱う（承知しても通さない）。
        String id = idOf(f.bytes());
        SignatureState sig = evaluateSignature(f.bytes(), f.minisig(), f.publishedKey(), id);
        if (sig.state().equals("invalid")) {
            throw new PluginInstallException("signature check failed: " + sig.problem());
        }

        // 署名で真正性が取れているなら、sha256 資産の有無は問わない（署名の方が強い保証）。
        if (!sig.ok() && f.expectedSha() == null && !acknowledgeUnverified) {
            throw new PluginInstallException(
                    "release has neither a valid signature nor a '" + f.zipName() + ".sha256' asset:"
                    + " integrity cannot be verified (install anyway only with explicit acknowledgement)");
        }
        requireConfirmed(f.bytes(), confirmedSha256);
        return installer.install(f.bytes(), source, f.expectedSha(), trustTier(source, sig),
                sig.ok() ? sig.keyId() : null,
                sig.ok() ? signerKeyToStore(f, sig) : null);
    }

    /** TOFU 用に固定する公開鍵。以前固定した鍵があればそれを維持し、初回のみリリースの鍵を採る。 */
    private String signerKeyToStore(Fetched f, SignatureState sig) {
        Optional<InstalledPlugin> known = installer.installed().stream()
                .filter(p -> p.signerPublicKey() != null && p.signerKeyId() != null
                        && p.signerKeyId().equalsIgnoreCase(sig.keyId()))
                .findFirst();
        if (known.isPresent()) return known.get().signerPublicKey();
        if (sig.state().equals("trusted")) {
            return props.getTrustedKeys().stream()
                    .filter(k -> {
                        try {
                            return Minisign.parseKey(k).keyId().equalsIgnoreCase(sig.keyId());
                        } catch (PluginInstallException e) {
                            return false;
                        }
                    })
                    .findFirst().orElse(f.publishedKey());
        }
        return f.publishedKey();
    }

    /** zip から id だけを読む（署名判定の TOFU 照合に使う）。 */
    private String idOf(byte[] zip) {
        String base = PluginPackage.manifestBasePrefix(zip);
        return PluginPackage.readDescriptor(zip, base, mapper).id();
    }

    /** ローカル zip（オフライン/エアギャップ導入）。 */
    public InstalledPlugin installFromFile(byte[] zip, String filename, String confirmedSha256) throws IOException {
        requireMutable();
        requireConfirmed(zip, confirmedSha256);
        return installer.install(zip, new InstalledPlugin.Source("file", filename), null, "local");
    }

    /** 同意画面で提示した成果物と、いま導入しようとしているものが同一であることを保証する。 */
    private void requireConfirmed(byte[] bytes, String confirmedSha256) {
        if (confirmedSha256 == null || confirmedSha256.isBlank()) return; // 未指定＝検査を経ていない呼び出し
        String actual = PluginPackage.sha256(bytes);
        if (!confirmedSha256.trim().equalsIgnoreCase(actual)) {
            throw new PluginInstallException(
                    "package changed since it was reviewed: confirmed " + confirmedSha256 + " but got " + actual);
        }
    }

    // --- 署名（minisign / Ed25519） ------------------------------------------

    /**
     * 署名の状態を判定する。ユーザーは鍵を扱わない — 判定材料は
     * ①本体設定の信頼鍵、②台帳に記録済みの初回の鍵（TOFU）、③リリースが提示する鍵、の順に探す。
     *
     * @param pluginId 判定対象の id（TOFU の照合に使う。検査時点で判明している）
     */
    private SignatureState evaluateSignature(byte[] content, String sigText, String offeredKeyText, String pluginId) {
        if (sigText == null) return SignatureState.unsigned();
        Minisign.Sig sig;
        try {
            sig = Minisign.parseSig(sigText);
        } catch (PluginInstallException e) {
            return SignatureState.invalid(null, "malformed signature: " + e.getMessage());
        }

        // ① 本体が信頼している鍵（公式配布）。
        for (String keyText : props.getTrustedKeys()) {
            Minisign.Key key;
            try {
                key = Minisign.parseKey(keyText);
            } catch (PluginInstallException e) {
                log.warn("[plugin-manager] ignoring malformed trusted key: {}", e.getMessage());
                continue;
            }
            if (!key.keyId().equalsIgnoreCase(sig.keyId())) continue;
            return Minisign.verify(content, sig, key)
                    ? SignatureState.trusted(key, sig)
                    : SignatureState.invalid(sig.keyId(), "signature does not match the trusted key");
        }

        // ② 以前この id を入れたときの鍵（TOFU）。リリースが新しい鍵を出してきても、こちらを優先する。
        Optional<InstalledPlugin> known = pluginId == null ? Optional.empty()
                : installer.installed().stream().filter(p -> p.id().equals(pluginId)).findFirst();
        String pinned = known.map(InstalledPlugin::signerPublicKey).orElse(null);
        if (pinned != null) {
            Minisign.Key key = Minisign.parseKey(pinned);
            if (!key.keyId().equalsIgnoreCase(sig.keyId())) {
                return SignatureState.invalid(sig.keyId(),
                        "signed by a different key than the installed version (expected " + key.keyId() + ")");
            }
            return Minisign.verify(content, sig, key)
                    ? SignatureState.pinned(key, sig)
                    : SignatureState.invalid(sig.keyId(), "signature does not match the previously used key");
        }

        // ③ リリースが提示する鍵。初回なので「この鍵で署名されている」ことしか言えない（TOFU の起点）。
        if (offeredKeyText == null) {
            return SignatureState.invalid(sig.keyId(), "signature present but no public key was published");
        }
        Minisign.Key key;
        try {
            key = Minisign.parseKey(offeredKeyText);
        } catch (PluginInstallException e) {
            return SignatureState.invalid(sig.keyId(), "malformed public key: " + e.getMessage());
        }
        return Minisign.verify(content, sig, key)
                ? SignatureState.firstUse(key, sig)
                : SignatureState.invalid(sig.keyId(), "signature does not match the published key");
    }

    /**
     * 署名の判定結果。
     *
     * @param state   {@code unsigned} / {@code trusted}（信頼鍵）/ {@code pinned}（TOFU 一致）/
     *                {@code first-use}（初回・鍵は未知）/ {@code invalid}
     * @param keyId   署名に含まれる鍵 ID
     * @param comment minisign の trusted comment（署名で保護された注記）
     * @param problem invalid の理由
     */
    record SignatureState(String state, String keyId, String publicKey, String comment, String problem) {

        static SignatureState unsigned() {
            return new SignatureState("unsigned", null, null, null, null);
        }

        static SignatureState trusted(Minisign.Key k, Minisign.Sig s) {
            return new SignatureState("trusted", k.keyId(), null, s.trustedComment(), null);
        }

        static SignatureState pinned(Minisign.Key k, Minisign.Sig s) {
            return new SignatureState("pinned", k.keyId(), null, s.trustedComment(), null);
        }

        static SignatureState firstUse(Minisign.Key k, Minisign.Sig s) {
            return new SignatureState("first-use", k.keyId(), null, s.trustedComment(), null);
        }

        static SignatureState invalid(String keyId, String problem) {
            return new SignatureState("invalid", keyId, null, null, problem);
        }

        /** 署名が有効に検証できたか。 */
        boolean ok() {
            return state.equals("trusted") || state.equals("pinned") || state.equals("first-use");
        }

        /** 既知の鍵で検証できた（＝同意画面を省いてよい）か。 */
        boolean known() {
            return state.equals("trusted") || state.equals("pinned");
        }
    }

    /** 取得（リリース選択→zip 資産→sha256 資産→ダウンロード）をまとめる。 */
    private Fetched fetchFromGitHub(String repo, String version) {
        List<GitHubReleaseClient.Release> rels = github.listReleases(repo, token());
        if (rels.isEmpty()) throw new PluginInstallException("no releases for " + repo);
        GitHubReleaseClient.Release rel = pickRelease(rels, version)
                .orElseThrow(() -> new PluginInstallException(
                        "no matching release for " + repo + (version == null ? "" : " @ " + version)));
        GitHubReleaseClient.Asset zip = findZipAsset(rel)
                .orElseThrow(() -> new PluginInstallException(
                        "release " + rel.tagName() + " has no .zip asset"));
        String expectedSha = fetchSha256(rel, zip);
        return new Fetched(github.download(downloadUrl(zip), token()), expectedSha, zip.name(), rel.tagName(),
                fetchText(rel, zip.name() + ".minisig"),
                firstText(rel, zip.name() + ".pub", "minisign.pub"));
    }

    /** 資産名が完全一致するテキスト資産を取得（無ければ null）。 */
    private String fetchText(GitHubReleaseClient.Release rel, String assetName) {
        Optional<GitHubReleaseClient.Asset> a = rel.assets().stream()
                .filter(x -> x.name() != null && x.name().equalsIgnoreCase(assetName))
                .findFirst();
        if (a.isEmpty()) return null;
        try {
            return new String(github.download(downloadUrl(a.get()), token()), StandardCharsets.UTF_8);
        } catch (RuntimeException e) {
            log.warn("[plugin-manager] asset '{}' unreadable: {}", assetName, e.getMessage());
            return null;
        }
    }

    private String firstText(GitHubReleaseClient.Release rel, String... assetNames) {
        for (String n : assetNames) {
            String t = fetchText(rel, n);
            if (t != null) return t;
        }
        return null;
    }

    /** zip を展開せずに読み、同意画面に出す情報を組み立てる。 */
    private PluginPreview preview(byte[] zip, InstalledPlugin.Source source, String expectedSha,
                                  String minisig, String publishedKey) {
        String base = PluginPackage.manifestBasePrefix(zip);
        PluginDescriptor d = PluginPackage.readDescriptor(zip, base, mapper);
        PluginPackage.Contents c = PluginPackage.contents(zip, base);
        PluginInstaller.Compat compat = installer.compat(d);
        SignatureState sig = evaluateSignature(zip, minisig, publishedKey, d.id());
        return new PluginPreview(
                d.id(), d.name(), d.version(), d.description(), d.author(), d.homepage(), d.license(),
                source.type(), source.ref(), trustTier(source, sig),
                PluginPackage.sha256(zip), expectedSha != null, c.hasUi(), c.jars(), c.files(), c.totalBytes(),
                d.permissions() == null ? List.of() : d.permissions(),
                compat.graphyOk(), compat.graphyRange(), compat.coreVersion(),
                compat.osOk(), compat.declaredOs(), compat.currentOs(),
                installer.installed().stream().anyMatch(p -> p.id().equals(d.id())),
                sig.state(), sig.keyId(), sig.comment(), sig.problem());
    }

    /**
     * 信頼ティア。署名が信頼鍵で通ったものだけ {@code verified}。
     * それ以外は従来どおり github＝community / file＝local（＝「検証していない」を意味する）。
     */
    private static String trustTier(InstalledPlugin.Source source, SignatureState sig) {
        if (sig.state().equals("trusted")) return "verified";
        return "file".equals(source.type()) ? "local" : "community";
    }

    /** 現行バージョンを取得元から再取得（破損修復）。file 由来は再アップロードが必要。 */
    public InstalledPlugin reinstall(String id) throws IOException {
        requireMutable();
        InstalledPlugin cur = installer.installed().stream()
                .filter(p -> p.id().equals(id)).findFirst()
                .orElseThrow(() -> new NoSuchElementException("plugin not installed: " + id));
        InstalledPlugin.Source src = cur.source();
        if (src != null && "github".equals(src.type())) {
            // 同じ版を取り直すだけなので、導入時に台帳へ記録済みの sha256 を同意済み値として使う。
            // sha256 資産が無いまま導入されていた場合は、その事実を引き継いで許可する。
            return installFromGitHub(src.ref(), cur.version(), cur.sha256(), true);
        }
        throw new PluginInstallException("reinstall unsupported for source '"
                + (src == null ? "?" : src.type()) + "': re-upload the zip");
    }

    public void enable(String id) throws IOException {
        requireMutable();
        installer.setEnabled(id, true);
    }

    public void disable(String id) throws IOException {
        requireMutable();
        installer.setEnabled(id, false);
    }

    public boolean uninstall(String id) throws IOException {
        requireMutable();
        return installer.uninstall(id);
    }

    // --- 取得元の解決ヘルパ -------------------------------------------------

    private Optional<GitHubReleaseClient.Release> pickRelease(
            List<GitHubReleaseClient.Release> rels, String version) {
        if (version != null && !version.isBlank()) {
            String want = version.trim();
            String wantNoV = want.startsWith("v") || want.startsWith("V") ? want.substring(1) : want;
            return rels.stream().filter(r -> {
                String tag = r.tagName() == null ? "" : r.tagName();
                String tagNoV = tag.startsWith("v") || tag.startsWith("V") ? tag.substring(1) : tag;
                return tag.equals(want) || tagNoV.equals(wantNoV);
            }).findFirst();
        }
        // 最新の非 prerelease を semver 降順で。無ければ何でも先頭。
        return rels.stream().filter(r -> !r.prerelease()).max(bySemverAsc())
                .or(() -> rels.stream().findFirst());
    }

    private Optional<GitHubReleaseClient.Asset> findZipAsset(GitHubReleaseClient.Release r) {
        return r.assets().stream()
                .filter(a -> a.name() != null && a.name().toLowerCase().endsWith(".zip"))
                .findFirst();
    }

    /**
     * {@code <zip>.sha256} 資産があれば取得し、先頭トークン（hex）を期待値として返す。
     *
     * <p>資産名は<b>完全一致のみ</b>を見る。以前は「末尾が .sha256 の最初の資産」も拾っていたが、
     * 無関係な資産のハッシュを期待値にしてしまうため厳格化した（fail-closed ではあるが誤判定）。
     */
    private String fetchSha256(GitHubReleaseClient.Release rel, GitHubReleaseClient.Asset zip) {
        Optional<GitHubReleaseClient.Asset> shaAsset = rel.assets().stream()
                .filter(a -> a.name() != null && a.name().equalsIgnoreCase(zip.name() + ".sha256"))
                .findFirst();
        if (shaAsset.isEmpty()) return null;
        try {
            byte[] body = github.download(downloadUrl(shaAsset.get()), token());
            String content = new String(body, StandardCharsets.UTF_8).trim();
            if (content.isEmpty()) return null;
            return content.split("\\s+")[0]; // "<hex>  filename" 形式に対応
        } catch (RuntimeException e) {
            log.warn("[plugin-manager] sha256 asset unreadable, skipping integrity check: {}", e.getMessage());
            return null;
        }
    }

    private String downloadUrl(GitHubReleaseClient.Asset asset) {
        // token があれば private でも取れる API URL を優先、無ければ公開 URL。
        if (token() != null && asset.apiUrl() != null) return asset.apiUrl();
        return asset.browserUrl() != null ? asset.browserUrl() : asset.apiUrl();
    }

    private static Comparator<GitHubReleaseClient.Release> bySemverAsc() {
        return Comparator.comparing(r -> {
            try {
                return SemVer.parse(r.tagName());
            } catch (RuntimeException e) {
                return SemVer.parse("0.0.0");
            }
        });
    }

    private static Comparator<GitHubReleaseClient.Release> byTagDesc() {
        return bySemverAsc().reversed();
    }

    // --- モードゲート -------------------------------------------------------

    private String token() {
        String t = props.getGithubToken();
        return t == null || t.isBlank() ? null : t;
    }

    private boolean isStandalone() {
        return Arrays.asList(env.getActiveProfiles()).contains("standalone");
    }

    /** ユーザーがオプトイン トグルを操作できる環境か（＝管理者ゲートが開いている standalone）。 */
    private boolean canOptIn() {
        return props.isManagerEnabled() && isStandalone();
    }

    private boolean canMutate() {
        return canOptIn() && optIn.isEnabled();
    }

    private void requireMutable() {
        if (!canMutate()) {
            throw new PluginManagerForbiddenException(canOptIn()
                    ? "plugin install/manage requires the user opt-in (settings key '"
                      + SettingsService.PLUGIN_INSTALL_ENABLED_KEY + "')"
                    : "plugin install/manage is disabled in this mode (standalone + graphy.plugins.manager-enabled required)");
        }
    }

    /**
     * マネージャの可否状態。
     *
     * @param canManage      導入系を実行できるか（3 条件すべて）
     * @param standalone     standalone プロファイルか
     * @param managerEnabled 管理者ゲート（{@code graphy.plugins.manager-enabled}）
     * @param installEnabled ユーザーのオプトイン現在値
     * @param canOptIn       オプトイン トグルを操作できるか（＝トグルを表示するか）
     */
    public record ManagerStatus(boolean canManage, boolean standalone,
                                boolean managerEnabled, boolean installEnabled,
                                boolean canOptIn, boolean hasGithubToken) {}

    /** 取得可能なバージョン（互換情報は導入時に判定）。 */
    public record AvailableVersion(String tag, String publishedAt, boolean prerelease, String zipAsset) {}

    /** 取得済みの配布物（内部用）。 */
    private record Fetched(byte[] bytes, String expectedSha, String zipName, String tag,
                           String minisig, String publishedKey) {}

    /**
     * 導入前の検査結果（同意画面に出す内容）。展開・保存はまだ行っていない。
     *
     * @param sha256           取得した zip の実測ハッシュ。同意後の install にそのまま渡す
     * @param integrityVerified リリースに {@code <zip>.sha256} 資産があり照合できたか
     * @param hasUi            {@code ui.js} を含む（レンダラで動くコード）
     * @param jars             同梱 JAR（<b>アプリと同じ権限の JVM で動く</b>）
     * @param osOk             実行中の OS に対応しているか（{@code engines.os} との突き合わせ）
     * @param declaredOs       宣言された対応 OS（空＝OS 非依存）
     * @param currentOs        実行中の OS トークン
     * @param alreadyInstalled 同 id が導入済み（＝上書きになる）
     * @param signature        署名の状態: unsigned / trusted（本体の信頼鍵）/ pinned（前回と同じ鍵）/
     *                         first-use（初回・鍵は未知）/ invalid
     * @param signerKeyId      署名鍵の ID
     * @param signatureComment minisign の trusted comment（署名で保護された注記）
     * @param signatureProblem invalid の理由
     */
    public record PluginPreview(
            String id, String name, String version, String description, String author,
            String homepage, String license,
            String sourceType, String sourceRef, String trust,
            String sha256, boolean integrityVerified,
            boolean hasUi, List<String> jars, List<String> files, long totalBytes,
            List<String> permissions,
            boolean graphyOk, String graphyRange, String coreVersion,
            boolean osOk, List<String> declaredOs, String currentOs,
            boolean alreadyInstalled,
            String signature, String signerKeyId, String signatureComment, String signatureProblem) {

        /**
         * 同意画面を出さずにそのまま導入してよいか。
         *
         * <p>既知の鍵（本体の信頼鍵＝公式配布、もしくは前回と同じ鍵＝更新）で署名が検証でき、
         * 互換性も満たすなら、ユーザーにとっては「導入を押すだけ」でよい。署名が無い・鍵が未知の
         * ときだけ中身を提示して同意を取る。設計: fw/plugin-manager-design.md §5.2。
         */
        @JsonProperty("autoInstallable")
        public boolean autoInstallable() {
            return installable() && ("trusted".equals(signature) || "pinned".equals(signature));
        }

        /**
         * 導入できる状態か（互換 NG は同意しても入れられない）。
         *
         * <p>record は宣言した構成要素だけが JSON になるため、派生値であるこれは
         * {@code @JsonProperty} で明示しないとフロントに届かない（実際に取りこぼして
         * 同意画面が常に「導入できません」になった）。
         */
        @JsonProperty("installable")
        public boolean installable() {
            return graphyOk && osOk;
        }
    }
}

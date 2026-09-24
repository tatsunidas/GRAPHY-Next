/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.ArrayList;
import java.util.List;

/**
 * Anonymizer REST（PS3.15）。属性匿名化＋Pixel 焼き込みで ZIP/フォルダ出力、焼き込みマスク登録。
 */
@RestController
@RequestMapping("/api/anonymizer")
public class AnonymizeController {

    private final AnonymizeService service;
    private final AnonymizeMaskStore maskStore;

    public AnonymizeController(AnonymizeService service, AnonymizeMaskStore maskStore) {
        this.service = service;
        this.maskStore = maskStore;
    }

    /** リクエスト本文。 */
    public record AnonRequest(List<String> studyUids, List<String> options, String replacePatientName,
                              String replacePatientId, Long randomSeed, List<String> manualRetainTags,
                              java.util.Map<String, String> customReplacements, boolean burnIn, String destination) {
    }

    public record ProfileDto(String name, List<String> options) {
    }

    /** 既定プロファイル雛形。 */
    @GetMapping("/profiles")
    public List<ProfileDto> profiles() {
        return List.of(
                new ProfileDto("basic", List.of()),
                new ProfileDto("retainUIDs", List.of("RetainUIDs")),
                new ProfileDto("research", List.of("RetainPatientCharacteristics",
                        "RetainLongitudinalTemporalInformationModifiedDates", "CleanDescriptors", "RetainSafePrivate")),
                new ProfileDto("cleanPixel", List.of("CleanPixelData")));
    }

    /** 出力見込み件数を伝えるヘッダ（ZIP 本体はストリームなので JSON で結果を返せないため）。 */
    private static final String H_INSTANCES = "X-Anonymize-Instances";
    private static final String H_PROBLEMS = "X-Anonymize-Problems";
    /**
     * 焼き込みの見込み件数。
     *
     * <p>ZIP は {@code Result} を返せないので「何件塗れたか」を事後に伝える手段が無い。
     * {@link #requireBurnableIfCleanPixelData} が「塗れないものがあれば中止」まで済ませているので、
     * <b>ここで返す見込み件数がそのまま実績になる</b>。マスクの無い対象が何件残るかも併せて出す。
     */
    private static final String H_BURN = "X-Anonymize-Burn";
    private static final String H_UNMASKED = "X-Anonymize-Unmasked";

    @PostMapping("/zip")
    public ResponseEntity<StreamingResponseBody> zip(@RequestBody AnonRequest req) {
        requireStandalone();
        validate(req);

        // ストリームを流し始めるとステータスを変えられない（＝失敗しても 200 ＋ 空 ZIP になり、
        // UI は成功メッセージを出す）。書き出す前に対象件数を数え、0 件ならここで弾く。
        AnonymizeService.Preflight pre = service.preflight(req.studyUids());
        if (pre.resolvable() == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "匿名化できるインスタンスが 0 件のため ZIP を作成しませんでした（索引 " + pre.indexed() + " 件）。"
                            + String.join(" / ", pre.problems()));
        }

        AnonymizeConfig cfg = toConfig(req);
        AnonymizeService.BurnPreflight burn = requireBurnableIfCleanPixelData(cfg, req.burnIn(), req.studyUids());
        StreamingResponseBody body = out -> {
            try {
                service.anonymizeToZip(req.studyUids(), cfg, req.burnIn(), out);
            } catch (Exception e) {
                throw new java.io.IOException(e);
            }
        };
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"anonymized.zip\"")
                .header(H_INSTANCES, String.valueOf(pre.resolvable()))
                .header(H_PROBLEMS, String.valueOf(pre.problems().size()))
                .header(H_BURN, String.valueOf(burn == null ? 0 : burn.burnable()))
                .header(H_UNMASKED, String.valueOf(burn == null ? 0 : burn.unmasked()))
                // fetch() から読めるようにする（既定では safelisted な応答ヘッダしか見えない）。
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS,
                        String.join(",", H_INSTANCES, H_PROBLEMS, H_BURN, H_UNMASKED))
                .body(body);
    }

    @PostMapping("/copy")
    public AnonymizeService.Result copy(@RequestBody AnonRequest req) {
        requireStandalone();
        validate(req);
        if (req.destination() == null || req.destination().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "destination が空です");
        }
        AnonymizeConfig cfg = toConfig(req);
        requireBurnableIfCleanPixelData(cfg, req.burnIn(), req.studyUids());
        try {
            return service.anonymizeToFolder(req.studyUids(), cfg, req.burnIn(), req.destination());
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }

    // ── 焼き込みマスク（2D viewer から登録、Anonymizer が参照） ──
    @PostMapping("/masks")
    public void registerMask(@RequestBody AnonymizeMaskStore.SeriesMask mask) {
        if (mask == null || mask.seriesUid() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "seriesUid が必要です");
        }
        validateMask(mask);
        maskStore.put(mask);
    }

    /** 多角形の頂点数の上限。これを超える ROI は手描きでも現実的でなく、DoS の入口になる。 */
    private static final int MAX_MASK_VERTICES = 100_000;

    /**
     * 焼き込みマスクの形が「実際に塗れるもの」かを、登録の時点で検査する。
     *
     * <p>🔴 <b>ここで弾かないと新しい偽申告を作る</b> —— 面積を持たない形（頂点 3 未満）や
     * 壊れた座標を受け付けると、「登録できたのに 1 画素も塗られていないのに Clean Pixel Data を
     * 申告する」状態になりうる。塗れない形は<b>登録の時点で断る</b>。
     *
     * <p>frontend 側でも閉じた面 ROI だけに絞るが、API は直接叩けるのでここが正本。
     */
    static void validateMask(AnonymizeMaskStore.SeriesMask mask) {
        if (mask.polygons() == null) {
            return;
        }
        for (AnonymizeMaskStore.MaskPolygon p : mask.polygons()) {
            if (p == null || p.xs() == null || p.ys() == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "マスクの頂点列がありません");
            }
            if (p.xs().length != p.ys().length) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "マスクの x と y の頂点数が一致しません: " + p.xs().length + " / " + p.ys().length);
            }
            if (p.xs().length < 3) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "焼き込みマスクは閉じた面（3 頂点以上）である必要があります。"
                                + "線・点・角度の ROI は面積を持たないため使えません。");
            }
            if (p.xs().length > MAX_MASK_VERTICES) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "マスクの頂点が多すぎます: " + p.xs().length + "（上限 " + MAX_MASK_VERTICES + "）");
            }
            for (int i = 0; i < p.xs().length; i++) {
                if (!Double.isFinite(p.xs()[i]) || !Double.isFinite(p.ys()[i])) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                            "マスクの座標に NaN / Infinity が含まれています");
                }
            }
        }
    }

    @GetMapping("/masks")
    public List<AnonymizeMaskStore.SeriesMask> masks(@RequestParam String seriesUids) {
        List<String> ids = new ArrayList<>();
        for (String s : seriesUids.split(",")) {
            if (!s.isBlank()) {
                ids.add(s.trim());
            }
        }
        return maskStore.get(ids);
    }

    @DeleteMapping("/masks")
    public void clearMask(@RequestParam(required = false) String seriesUid) {
        if (seriesUid == null || seriesUid.isBlank()) {
            maskStore.clear();
        } else {
            maskStore.remove(seriesUid);
        }
    }

    /**
     * Clean Pixel Data を要求されたのに<b>実行できない</b>状態なら、書き出す前に止める。
     *
     * <p>🔴 <b>「一部だけ塗れた ZIP」を黙って渡すのが最も危険</b> —— 受け取り側は ZIP 全体が
     * clean だと解釈する。ZIP はストリーミングなので 1 バイト流したらステータスを変えられず、
     * 途中で気づいても遅い。よって判定は流し始める前に済ませる。
     *
     * <p>誤った申告をするくらいなら機能を止める、という判断基準の実装。
     */
    AnonymizeService.BurnPreflight requireBurnableIfCleanPixelData(AnonymizeConfig cfg, boolean burnIn,
            List<String> studyUids) {
        if (!cfg.hasOption(AnonymizeConfig.Option.CleanPixelData)) {
            return null;
        }
        checkBurnRequest(burnIn, maskStore.size());
        // 🔴 マスクの「登録件数」だけでは足りない。**対象のインスタンスに実際に塗れるか**を見る。
        //    これが無かったために、圧縮 XA（JPEG）で 1 画素も塗られていない出力が、警告も無く
        //    渡っていた（2026-09-24・利用者報告）。塗れないものが 1 件でもあれば書き出さない。
        AnonymizeService.BurnPreflight burn = service.burnPreflight(studyUids);
        checkBurnPreflight(burn);
        return burn;
    }

    /** 要求そのものが矛盾していないか（対象データを読む前に分かること）。 */
    // package-private: validate と同じ理由で直接テストする。
    static void checkBurnRequest(boolean burnIn, int maskCount) {
        if (!burnIn) {
            // チェックだけ入れて焼き込みを回さない＝設定と出力が食い違う。通さない。
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Clean Pixel Data を選ぶ場合は焼き込みの実行も有効にしてください。"
                            + "焼き込みを行わないと画素は変わらず、除去済みという申告もできません。");
        }
        if (maskCount == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "焼き込みマスクが 1 件も登録されていないため、Clean Pixel Data を実行できません。"
                            + "マスクが無いまま出力すると焼き込み文字が残ったままになるので中止しました。");
        }
    }

    /**
     * 対象データを見たうえで、焼き込みが本当に成立するか。
     *
     * <p>🔴 <b>「塗れないものが 1 件でもあれば中止」</b>。一部だけ塗れた出力を渡すのが最も危険で、
     * 受け取り側は全体が clean だと解釈する。ZIP はストリーミングなので、流し始めてからでは遅い。
     */
    // package-private: 同上。
    static void checkBurnPreflight(AnonymizeService.BurnPreflight burn) {
        if (burn.blocked() > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "焼き込みマスクが登録されているのに適用できないインスタンスが " + burn.blocked()
                            + " 件あるため中止しました（塗れるのは " + burn.burnable() + " 件）。"
                            + "そのまま出力すると焼き込み文字が残ったままになります。理由: "
                            + String.join(" / ", burn.problems()));
        }
        if (burn.burnable() == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "登録されている焼き込みマスクは、今回の対象シリーズのものではありません"
                            + "（対象 " + burn.unmasked() + " 件はいずれもマスク未登録）。"
                            + "このまま出力しても 1 画素も塗られないため中止しました。");
        }
    }

    private void requireStandalone() {
        if (service.isWeb()) {
            throw new ResponseStatusException(HttpStatus.NOT_IMPLEMENTED,
                    "web モードの匿名化（WADO 取得）は未対応です。standalone をご利用ください。");
        }
    }

    // package-private: Spring も Mockito も要らずに直接テストする（この JDK では
    // Mockito が ObjectProvider をモックできず、@WebMvcTest 系が動かないため）。
    static void validate(AnonRequest req) {
        if (req.studyUids() == null || req.studyUids().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "studyUids が空です");
        }
        validateDateOptions(req);
    }

    /**
     * 日付オプションの排他を検査する。
     *
     * <p>PS3.15 では Full Dates（原本の日付を保持）と Modified Dates（関係を保ったまま加工）は
     * <b>どちらか一方</b>を選ぶもの。両方立つと {@code AnonymizeConfig.getActionByOptionsAndDefault()} の
     * 「加工(C,X)は保持(K)より優先（安全側）」により <b>Full Dates が負けて</b>、
     * 利用者が「保持」を選んだつもりの日付が加工される。
     *
     * <p>🔴 <b>ここが正本</b>。UI 側の排他だけでは塞げない —— プロファイルの読み込みは
     * 任意の JSON ファイルから options を丸ごと差し替えるし、API を直接叩くこともできる。
     *
     * <p>⚠ C&gt;K の優先規則そのものは変えない。あれは辞書解決の汎用の安全側フォールバックで、
     * 他のオプションの組み合わせにも効いている。日付 2 つの排他という個別事情で触ると
     * 影響範囲が読めなくなる。<b>競合を後段で解決するのではなく、競合した設定を受け付けない</b>のが正しい層。
     */
    private static void validateDateOptions(AnonRequest req) {
        if (req.options() == null) {
            return;
        }
        boolean full = req.options().contains(
                AnonymizeConfig.Option.RetainLongitudinalTemporalInformationFullDates.name());
        boolean modified = req.options().contains(
                AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates.name());
        if (full && modified) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "日付オプションは排他です。Full Dates（原本の日付を保持）と Modified Dates"
                            + "（前後関係を保ったままシフト）のどちらか一方を選んでください。"
                            + "両方を指定すると加工が保持に優先し、保持したつもりの日付が加工されます。");
        }
    }

    /** @see #validate(AnonRequest) （同じ理由で package-private） */
    static AnonymizeConfig toConfig(AnonRequest req) {
        AnonymizeConfig cfg = new AnonymizeConfig();
        if (req.options() != null) {
            for (String o : req.options()) {
                try {
                    cfg.addOption(AnonymizeConfig.Option.valueOf(o));
                } catch (IllegalArgumentException e) {
                    // 🔴 黙って無視しない。脱識別で「読めなかった設定を無視する」は、
                    // 利用者が指定したつもりの保護がそのまま消えることを意味する。
                    // 綴り違いのオプション 1 つで保護が外れた出力が出るくらいなら止める。
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                            "未知の匿名化オプションです: " + o);
                }
            }
        }
        if (req.replacePatientName() != null) {
            cfg.setReplacePatientName(req.replacePatientName());
        }
        if (req.replacePatientId() != null) {
            cfg.setReplacePatientId(req.replacePatientId());
        }
        cfg.setRandomSeed(req.randomSeed());
        if (req.manualRetainTags() != null) {
            for (String hex : req.manualRetainTags()) {
                Integer tag = parseTag(hex);
                if (tag != null) {
                    cfg.getManualRetainTags().add(tag);
                }
            }
        }
        if (req.customReplacements() != null) {
            req.customReplacements().forEach((hex, val) -> {
                Integer tag = parseTag(hex);
                if (tag != null) {
                    cfg.getCustomTagReplacements().put(tag, val);
                }
            });
        }
        return cfg;
    }

    private static Integer parseTag(String hex) {
        if (hex == null) {
            return null;
        }
        String h = hex.replaceAll("[^0-9A-Fa-f]", "");
        if (h.length() != 8) {
            return null;
        }
        try {
            return (int) Long.parseLong(h, 16);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

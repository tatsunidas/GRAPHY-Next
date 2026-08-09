/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import java.time.Instant;

/**
 * 患者 1 人分の位置合わせ記録の保存単位（設計 {@code fw/registration-design.md} §12.4）。
 *
 * <p><b>なぜ保存するのか</b>: 開き直したときに<b>まったく同じ重ね合わせ</b>を復元できないと
 * 使い物にならない。エンジンは決定的に作ってあるが、それは<b>コードが同一である限り</b>の話で、
 * バージョンが上がれば結果は変わりうる。したがって<b>再現性を「再計算」に依存させてはいけない</b>。
 * 結果そのものを保存するのが唯一の担保になる。
 *
 * <p><b>なぜ患者単位か</b>: {@code RoiDocument} と同じ理由。縦断の追跡では複数スタディに
 * またがって同じ組み合わせを見るため、スタディ単位に割ると問い合わせが分断される。
 *
 * <p><b>なぜ JSON 1 本か</b>: 記録の中身は 4×4 行列・変位場（Base64）・手動 6 値・
 * ハイパーパラメータ一式で、エンジンの進化に合わせて増える。列に開くと変換モデルを
 * 増やすたびにスキーマ移行が必要になる。スキーマの正本はフロントの
 * {@code viewer/registrationRecord.ts}。
 *
 * <p><b>DICOM SRO との関係</b>: 可搬な正式記録は SRO（66.1 / 66.3）で、これはその前段。
 * アプリ内で「開き直せば同じ絵」を成立させるためのもの。
 */
@Entity
@Table(name = "registration_document")
public class RegistrationDocument {

    /** 患者判定キー（{@code RoiDocument} と同じ値を使う）。 */
    @Id
    @Column(length = 256)
    private String patientKey;

    /** 記録の配列を含む JSON（スキーマはフロントの `registrationRecord.ts` が正本）。 */
    @Lob
    @Column(nullable = false)
    private String json;

    /** 保存されている記録件数（一覧を JSON パースなしで見せるため）。 */
    @Column(nullable = false)
    private int recordCount;

    @Column(nullable = false)
    private Instant updatedAt;

    /**
     * 楽観ロック。2D Viewer は患者ごとに複数ウィンドウを開けるため、別ウィンドウが
     * 同じ患者の記録を同時に保存し得る。<b>後から来た方が黙って前の保存を消す</b>のを防ぐ。
     */
    @Version
    private Long version;

    protected RegistrationDocument() {
    }

    public RegistrationDocument(String patientKey, String json, int recordCount) {
        this.patientKey = patientKey;
        this.json = json;
        this.recordCount = recordCount;
        this.updatedAt = Instant.now();
    }

    public void update(String json, int recordCount) {
        this.json = json;
        this.recordCount = recordCount;
        this.updatedAt = Instant.now();
    }

    public String getPatientKey() {
        return patientKey;
    }

    public String getJson() {
        return json;
    }

    public int getRecordCount() {
        return recordCount;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public Long getVersion() {
        return version;
    }
}

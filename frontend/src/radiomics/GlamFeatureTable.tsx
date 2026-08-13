/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * GLAM 特徴量 150 個の表（19 行列 × 8 統計）。
 *
 * <p>1 つの特徴は必ず **(行列, 統計) の組**として定義されている
 * （`SecondVirialCoefficient_Mean` = 行列 SecondVirialCoefficient を統計 Mean で潰したもの）。
 * だから 150 行の一覧ではなく **19 行 × 8 列の格子**で出す。同じ行列の 8 個が横に並ぶので、
 * 「どの統計で見ても同じ向き」なのか「Mean と DiagonalMean で符号が違う」のかが一目で分かる。
 *
 * <p>自己ペアだけで定義される行列（Compressibility）は、対角/非対角に分ける統計を持たない。
 * その 2 セルは空欄になる（バックエンドが null を返す）。
 *
 * <p>CSV は `name,value` の 150 行。表計算や統計ソフトへそのまま渡せる形にしてある
 * （このアプリは 1 症例ずつ回す道具なので、複数症例をまとめるのは受け取った側の仕事）。
 */
import { useMemo } from "react";
import { useI18n } from "../i18n/i18n";
import { GLAM_MATRICES, GLAM_STATISTICS, glamFeatureString } from "../viewer/textureFeatures";

/** 有効数字 4 桁。桁が飛ぶ（第二ビリアル係数は数千、占有率は 0.001 台）ので指数も許す。 */
function format(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(3);
  return String(Number(v.toPrecision(4)));
}

export function GlamFeatureTable({
  features,
  fileLabel,
}: {
  features: Record<string, number | null>;
  /** CSV のファイル名に使う識別子（シリーズ番号など）。 */
  fileLabel: string;
}) {
  const { t } = useI18n();

  const defined = useMemo(
    () => Object.values(features).filter((v) => v != null && Number.isFinite(v)).length,
    [features],
  );

  const onCsv = () => {
    const rows = [["name", "value"]];
    for (const m of GLAM_MATRICES) {
      for (const s of GLAM_STATISTICS) {
        const name = `${m.name}_${s}`;
        // 存在しない組み合わせ（自己ペアだけの行列 × 対角/非対角）は行ごと出さない。
        // 表では空欄でよいが、CSV に無い特徴の名前が並ぶと受け取った側が困る。
        if (!(name in features)) continue;
        const v = features[name];
        rows.push([name, v == null || !Number.isFinite(v) ? "" : String(v)]);
      }
    }
    const csv = rows.map((r) => r.join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `glam-features-${fileLabel || "roi"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ color: "#6b7785", fontSize: 11 }}>
          {t("glam.features.count", { defined, total: Object.keys(features).length })}
        </span>
        <button onClick={onCsv} style={btn}>{t("glam.features.csv")}</button>
      </div>
      <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", position: "sticky", left: 0, background: "#f4f7fa" }}>
                {t("glam.features.matrix")}
              </th>
              {GLAM_STATISTICS.map((s) => (
                <th key={s} style={th}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GLAM_MATRICES.map((m) => (
              <tr key={m.name}>
                <td style={{ ...td, textAlign: "left", whiteSpace: "nowrap", position: "sticky", left: 0, background: "#fff" }}>
                  {t(m.labelKey)}
                </td>
                {GLAM_STATISTICS.map((s) => {
                  const v = features[`${m.name}_${s}`];
                  return (
                    <td key={s} style={td} title={glamFeatureString(m.name, s)}>
                      {format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const table: React.CSSProperties = { borderCollapse: "collapse", fontSize: 11, minWidth: 720 };
const th: React.CSSProperties = {
  position: "sticky", top: 0, background: "#f4f7fa", border: "1px solid #e2e7ee",
  padding: "3px 6px", fontWeight: 600, whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  border: "1px solid #eef2f6", padding: "2px 6px", textAlign: "right",
  fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
};
const btn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer",
  fontSize: 11, padding: "2px 8px",
};

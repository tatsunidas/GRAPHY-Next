import { type ImageInfo } from "./imageInfo";
import { useI18n } from "../i18n/i18n";

/** 数値整形（桁数指定、未定義は "—"）。 */
function num(v: number | undefined, digits = 2): string {
  return v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);
}

/**
 * 右サイドのキャリブレーション情報パネル。
 * 輝度（Modality LUT=Rescale, VOI=Window）/ ボクセルサイズ / FOV / ビット深度・符号 を一覧表示。
 */
export function ImageInfoPanel({ info }: { info: ImageInfo | null }) {
  const { t } = useI18n();
  if (!info) return null;

  const pixelSpacing =
    info.columnPixelSpacing !== undefined && info.rowPixelSpacing !== undefined
      ? `${num(info.columnPixelSpacing, 3)} × ${num(info.rowPixelSpacing, 3)} mm`
      : t("viewer.info.notCalibrated");
  const fov =
    info.fovWidthMm !== undefined && info.fovHeightMm !== undefined
      ? `${num(info.fovWidthMm, 1)} × ${num(info.fovHeightMm, 1)} mm`
      : "—";
  const matrix =
    info.columns !== undefined && info.rows !== undefined ? `${info.columns} × ${info.rows}` : "—";
  const rescale =
    info.rescaleSlope !== undefined || info.rescaleIntercept !== undefined
      ? `${num(info.rescaleSlope ?? 1, 2)} / ${num(info.rescaleIntercept ?? 0, 2)}`
      : "—";
  const windowCW =
    info.windowCenter !== undefined && info.windowWidth !== undefined
      ? `${num(info.windowCenter, 0)} / ${num(info.windowWidth, 0)}`
      : "—";
  const bits =
    info.bitsStored !== undefined ? `${info.bitsStored} / ${info.bitsAllocated ?? "—"}` : "—";
  const signed =
    info.pixelRepresentation === undefined
      ? "—"
      : info.pixelRepresentation === 1
        ? t("viewer.info.signed")
        : t("viewer.info.unsigned");

  return (
    <div style={panel}>
      <div style={title}>{t("viewer.info.title")}</div>
      <Row label={t("field.modality")} value={info.modality || "—"} />
      <Row label={t("viewer.info.matrix")} value={matrix} />
      <Row label={t("viewer.info.pixelSpacing")} value={pixelSpacing} />
      <Row label={t("viewer.info.sliceThickness")} value={info.sliceThickness !== undefined ? `${num(info.sliceThickness, 2)} mm` : "—"} />
      <Row label={t("viewer.info.fov")} value={fov} />
      <div style={divider} />
      <Row label={t("viewer.info.rescale")} value={rescale} />
      <Row label={t("viewer.info.window")} value={windowCW} />
      <Row label={t("viewer.info.bits")} value={bits} />
      <Row label={t("viewer.info.pixelRep")} value={signed} />
      <Row label={t("viewer.info.photometric")} value={info.photometricInterpretation || "—"} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={row}>
      <span style={rowLabel}>{label}</span>
      <span style={rowValue}>{value}</span>
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 220,
  flex: "none",
  alignSelf: "stretch",
  padding: "10px 12px",
  background: "#f7f9fb",
  border: "1px solid #e1e7ee",
  borderRadius: 6,
  fontSize: 12,
};
const title: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#33404d" };
const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  padding: "3px 0",
  lineHeight: 1.3,
};
const rowLabel: React.CSSProperties = { color: "#6b7785", flex: "none" };
const rowValue: React.CSSProperties = {
  color: "#1a2530",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  wordBreak: "break-word",
};
const divider: React.CSSProperties = { height: 1, background: "#e1e7ee", margin: "6px 0" };

import type { Series } from "./api";

/** シリーズ表の見出しに出す名前。説明が無ければシリーズ番号、どちらも無ければ null（見出しは「シリーズ」だけ）。 */
export function seriesHeadingName(series: Series | null): string | null {
  if (!series) return null;
  const description = series.seriesDescription?.trim();
  if (description) return description;
  return series.seriesNumber != null ? `#${series.seriesNumber}` : null;
}

/**
 * フレーム軸（Shot × Frame）のシリーズのうち、超音波（心エコー等）のシネか。
 *
 * XA 用の操作（DSA・XA 解析・QLV・TIMI・IVUS）は X 線血管造影のためのもので、US のシネには出さない。
 * 判定は「軸が shot」かつ「US の SOP クラス」。血管内 US（IVUS）は軸が pullback なので含まれない
 * （同じ US Multi-frame の SOP クラスを使うので、SOP クラスだけでは IVUS と区別できない）。
 */
const US_SOP_CLASSES: ReadonlySet<string> = new Set([
  "1.2.840.10008.5.1.4.1.1.3.1", // US Multi-frame Image Storage
  "1.2.840.10008.5.1.4.1.1.6.1", // US Image Storage
]);

export function isUsCine(
  zAxisKind: string | undefined,
  instances: ReadonlyArray<{ sopClassUid?: string | null }>,
): boolean {
  if (zAxisKind !== "shot") return false;
  return instances.some((i) => !!i.sopClassUid && US_SOP_CLASSES.has(i.sopClassUid));
}

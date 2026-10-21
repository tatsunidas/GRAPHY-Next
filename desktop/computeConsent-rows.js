// 同意画面の「送るデータ」の行の組み立て（純関数）。画面（computeConsent-view.js）と単体テストの両方が使う。
// 対話の 1 回（detail.items が無い）は今までと同じ平らな行。一括（組あり）は組ごとにまとめ、合計も出す。
(function (root) {
  function buildRows(detail) {
    const batch = Array.isArray(detail.items);
    if (!batch) {
      return {
        batch: false,
        itemCount: 1,
        datasetCount: detail.datasets.length,
        totalBytes: detail.datasets.reduce((a, d) => a + d.bytes, 0),
        rows: detail.datasets.map((d) => ({ key: null, noInput: false, d })),
        refused: [],
      };
    }
    const rows = [];
    for (const it of detail.items) {
      if (it.datasets.length === 0) {
        rows.push({ key: it.key, noInput: true, d: null });
        continue;
      }
      it.datasets.forEach((d, i) => rows.push({ key: i === 0 ? it.key : "", noInput: false, d }));
    }
    return {
      batch: true,
      itemCount: detail.items.length,
      datasetCount: detail.datasets.length,
      totalBytes: detail.datasets.reduce((a, d) => a + d.bytes, 0),
      rows,
      refused: (detail.refused || []).map((r) => ({ key: r.key, reason: r.reason })),
    };
  }

  const api = { buildRows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.graphyConsentRows = api;
})(typeof window !== "undefined" ? window : globalThis);

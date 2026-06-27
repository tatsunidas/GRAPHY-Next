import { useEffect, useState } from "react";
import { fetchStudies, type Study } from "./api";

export function StudyList() {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStudies()
      .then(setStudies)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>スタディ一覧</h2>

      {error && <div style={{ color: "#b00020" }}>取得に失敗しました: {error}</div>}
      {!error && !studies && <div>読み込み中…</div>}
      {studies && studies.length === 0 && (
        <div style={{ color: "#666" }}>スタディがありません（受信/取り込み後に表示されます）。</div>
      )}

      {studies && studies.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
              <Th>患者ID</Th>
              <Th>患者名</Th>
              <Th>Study Instance UID</Th>
              <Th>枚数</Th>
            </tr>
          </thead>
          <tbody>
            {studies.map((s) => (
              <tr key={s.studyInstanceUid} style={{ borderBottom: "1px solid #eee" }}>
                <Td>{s.patientId || "—"}</Td>
                <Td>{s.patientName || "—"}</Td>
                <Td mono>{s.studyInstanceUid}</Td>
                <Td>{s.numberOfInstances}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "6px 10px", color: "#666", fontWeight: 600 }}>{children}</th>;
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        padding: "6px 10px",
        fontFamily: mono ? "ui-monospace, monospace" : "inherit",
        fontSize: mono ? 13 : "inherit",
      }}
    >
      {children}
    </td>
  );
}

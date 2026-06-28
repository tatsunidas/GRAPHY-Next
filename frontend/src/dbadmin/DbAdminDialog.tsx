import { useEffect, useState } from "react";
import {
  fetchPatients,
  fetchStats,
  savePatient,
  deletePatient,
  type Patient,
  type Stats,
} from "./dbAdminApi";
import { fetchSettings } from "../settings/settingsApi";
import { VBarChart, HBarChart, PieChart, formatBytes } from "./charts";

type Tab = "patients" | "stats";

export function DbAdminDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("patients");
  const [confirmDelete, setConfirmDelete] = useState(true);

  useEffect(() => {
    if (!open) return;
    fetchSettings()
      .then((s) => setConfirmDelete(s["data.confirmBeforeDelete"] !== "false"))
      .catch(() => setConfirmDelete(true));
  }, [open]);

  if (!open) return null;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>DB テーブル管理</span>
          <button style={closeBtn} onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <div style={tabs}>
          <TabBtn active={tab === "patients"} onClick={() => setTab("patients")}>
            患者
          </TabBtn>
          <TabBtn active={tab === "stats"} onClick={() => setTab("stats")}>
            統計
          </TabBtn>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
          {tab === "patients" ? <PatientsTab confirmDelete={confirmDelete} /> : <StatsTab />}
        </div>
      </div>
    </div>
  );
}

function PatientsTab({ confirmDelete }: { confirmDelete: boolean }) {
  const [q, setQ] = useState("");
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Patient | null>(null);

  const reload = (query: string) => {
    setError(null);
    fetchPatients(query)
      .then(setPatients)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(() => reload(""), []);

  const onDelete = async (p: Patient) => {
    if (confirmDelete && !window.confirm(`患者「${p.patientName || p.patientId}」を削除します。よろしいですか？`)) {
      return;
    }
    try {
      await deletePatient(p.patientId);
      reload(q);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && reload(q)}
          placeholder="患者ID / 患者名で検索"
          style={input}
        />
        <button onClick={() => reload(q)} style={btn}>
          検索
        </button>
      </div>

      {error && <div style={{ color: "#b00020", marginBottom: 8 }}>{error}</div>}
      {!patients && <div>読み込み中…</div>}
      {patients && patients.length === 0 && <div style={{ color: "#666" }}>患者がいません。</div>}

      {patients && patients.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
              <Th>患者ID</Th>
              <Th>患者名</Th>
              <Th>生年月日</Th>
              <Th>性別</Th>
              <Th>検査数</Th>
              <Th>枚数</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <tr key={p.patientId} style={{ borderBottom: "1px solid #eee" }}>
                <Td>{p.patientId}</Td>
                <Td>{p.patientName || "—"}</Td>
                <Td>{formatDate(p.patientBirthDate)}</Td>
                <Td>{p.patientSex || "—"}</Td>
                <Td>{p.numberOfStudies}</Td>
                <Td>{p.numberOfInstances}</Td>
                <Td>
                  <button onClick={() => setEditing(p)} style={smallBtn}>
                    編集
                  </button>
                  <button onClick={() => onDelete(p)} style={{ ...smallBtn, color: "#b00020" }}>
                    削除
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <PatientEditForm
          patient={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload(q);
          }}
        />
      )}
    </div>
  );
}

function PatientEditForm({
  patient,
  onClose,
  onSaved,
}: {
  patient: Patient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(patient.patientName ?? "");
  const [birth, setBirth] = useState(patient.patientBirthDate ?? "");
  const [sex, setSex] = useState(patient.patientSex ?? "");
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await savePatient(patient.patientId, {
        patientName: name,
        patientBirthDate: birth,
        patientSex: sex,
        newPatientId: newId,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...editBox }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px" }}>患者情報の編集</h3>
        <p style={{ fontSize: 12, color: "#8a98a6", marginTop: 0 }}>
          設定により、該当患者の全 DICOM ファイルのタグも書き換わります。
        </p>
        <Row label="患者名">
          <input value={name} onChange={(e) => setName(e.target.value)} style={input} />
        </Row>
        <Row label="生年月日 (YYYYMMDD)">
          <input value={birth} onChange={(e) => setBirth(e.target.value)} style={input} placeholder="19800101" />
        </Row>
        <Row label="性別">
          <select value={sex} onChange={(e) => setSex(e.target.value)} style={input}>
            <option value="">—</option>
            <option value="M">M</option>
            <option value="F">F</option>
            <option value="O">O</option>
          </select>
        </Row>
        <Row label="患者ID変更 (任意)">
          <input value={newId} onChange={(e) => setNewId(e.target.value)} style={input} placeholder={patient.patientId} />
        </Row>
        {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btn}>
            キャンセル
          </button>
          <button onClick={save} disabled={saving} style={{ ...btn, background: "#0b5cad", color: "#fff" }}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <div style={{ color: "#b00020" }}>{error}</div>;
  if (!stats) return <div>読み込み中…</div>;

  const toData = (b: { key: string; value: number }[]) => b.map((x) => ({ label: x.key, value: x.value }));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
      <Card title="時系列スタディ数">
        <VBarChart data={toData(stats.studyCountByMonth)} />
      </Card>
      <Card title="モダリティ割合（スタディ数）">
        <PieChart data={toData(stats.studyCountByModality)} />
      </Card>
      <Card title="モダリティ別 画像枚数">
        <HBarChart data={toData(stats.instanceCountByModality)} />
      </Card>
      <Card title="モダリティ別 データ容量">
        <HBarChart data={toData(stats.volumeBytesByModality)} formatValue={formatBytes} />
      </Card>
    </div>
  );
}

// --- 小物 ---
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #eef1f4", borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "8px 0" }}>
      <div style={{ width: 150, fontSize: 13, color: "#445" }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        padding: "10px 16px",
        cursor: "pointer",
        fontSize: 14,
        fontWeight: active ? 700 : 400,
        color: active ? "#0b5cad" : "#445",
        borderBottom: active ? "2px solid #0b5cad" : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}
function Th({ children }: { children?: React.ReactNode }) {
  return <th style={{ padding: "6px 10px", color: "#666", fontWeight: 600 }}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "6px 10px" }}>{children}</td>;
}
function formatDate(d: string | null): string {
  if (!d || d.length !== 8) return d || "—";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 860,
  maxWidth: "94vw",
  height: 560,
  maxHeight: "90vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const tabs: React.CSSProperties = { display: "flex", borderBottom: "1px solid #eee", padding: "0 8px" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 13 };
const input: React.CSSProperties = { padding: "6px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "6px 12px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const smallBtn: React.CSSProperties = { padding: "3px 8px", border: "1px solid #d7dde3", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, marginRight: 4 };
const editBox: React.CSSProperties = { width: 440, maxWidth: "92vw", background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.3)" };

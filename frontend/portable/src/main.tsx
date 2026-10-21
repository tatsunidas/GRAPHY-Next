import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { I18nProvider, useI18n } from "../../src/i18n/i18n";
import { loadFromServer, serverBase, startHeartbeat } from "./mediaSource";
import type { DicomDirModel } from "./dicomdir";
import { App } from "./App";
import { loadExportedLayouts } from "./data";
import { IcLock } from "./icons";
import "./style.css";

function Boot() {
  const { locale } = useI18n();
  const tx = (ja: string, en: string) => (locale === "ja" ? ja : en);
  const [model, setModel] = useState<DicomDirModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.getElementById("boot-guide")?.remove();
    const base = serverBase();
    if (!base) {
      setError(tx("START-VIEWER から開いてください。このページを直接開いても、画像は読み込めません。", "Please open this viewer with START-VIEWER. Opening this page directly cannot load images."));
      return;
    }
    loadExportedLayouts(base);
    const stop = startHeartbeat(base);
    loadFromServer(base).then(setModel).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (model) return <App model={model} />;
  return (
    <div className="pv-app">
      <div className="pv-msg">
        <div className="pv-card2" role="status">
          <h2>{error ? tx("媒体を開けませんでした", "Could not open the media") : tx("媒体を読み込んでいます", "Loading the media")}</h2>
          <p>{error ?? tx("DICOMDIR を確認して、シリーズの一覧を作っています", "Reading DICOMDIR and building the series list")}</p>
          {!error && <div className="pv-bar"><i style={{ width: "60%" }} /></div>}
          <p style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <IcLock />
            <span>{tx("データはこの PC の中だけで処理され、外へは送られません。", "Data is processed on this PC only and is never sent out.")}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Boot />
  </I18nProvider>,
);

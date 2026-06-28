import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "./log";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * 描画時の予期せぬエラーを捕捉してアプリ全体のクラッシュを防ぐ。
 * フォールバック文言は i18n コンテキスト不在でも安全なように日英併記。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error("UI render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", color: "#b00020" }}>
          <h2 style={{ marginTop: 0 }}>表示中にエラーが発生しました / An error occurred</h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#555", fontSize: 12 }}>
            {String(this.state.error.message)}
          </pre>
          <button onClick={() => location.reload()} style={{ marginTop: 8, padding: "6px 12px", cursor: "pointer" }}>
            再読み込み / Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

import { Component, StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import App from './App.tsx'
import { startFavSync } from './lib/favsync'
import { initPlatforms } from './lib/platforms'
import { FLAGS } from './config'

startFavSync()     // 로그인 시 즐겨찾기 서버 동기화(원격 모드에서만 동작)
initPlatforms()    // 원격에서 전체 플랫폼 로드(정적 시드 위에 교체 — 승인된 새 플랫폼 반영)

/* 최상위 오류 방어벽 — 렌더 중 예외가 나도 백지 대신 복구 안내를 보여준다 */
class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: "80px auto", padding: "0 20px", textAlign: "center", fontFamily: "sans-serif" }}>
        <h2>문제가 발생했어요</h2>
        <p style={{ opacity: .75 }}>일시적인 오류일 수 있어요. 새로고침하면 대부분 해결됩니다.</p>
        <p>
          <button onClick={() => location.reload()} style={{ padding: "10px 18px", marginRight: 8, cursor: "pointer" }}>새로고침</button>
          <button onClick={() => { location.href = import.meta.env.BASE_URL; }} style={{ padding: "10px 18px", cursor: "pointer" }}>홈으로</button>
        </p>
        {FLAGS.contactEmail && (
          <p style={{ fontSize: 13, opacity: .6 }}>
            반복되면 <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent("[세모플] 오류 제보")}&body=${encodeURIComponent(String(this.state.err))}`}>오류 제보</a>를 부탁드려요.
          </p>
        )}
        <details style={{ fontSize: 12, opacity: .5, textAlign: "left" }}><summary>기술 정보</summary><pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.err)}</pre></details>
      </div>
    );
  }
}
window.addEventListener("unhandledrejection", (e) => console.warn("[semopl] unhandled:", e.reason));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import App from './App.tsx'
import { startFavSync } from './lib/favsync'
import { initPlatforms } from './lib/platforms'

startFavSync()     // 로그인 시 즐겨찾기 서버 동기화(원격 모드에서만 동작)
initPlatforms()    // 원격에서 전체 플랫폼 로드(정적 시드 위에 교체 — 승인된 새 플랫폼 반영)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

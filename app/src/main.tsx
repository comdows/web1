import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import App from './App.tsx'
import { startFavSync } from './lib/favsync'

startFavSync() // 로그인 시 즐겨찾기 서버 동기화(원격 모드에서만 동작)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

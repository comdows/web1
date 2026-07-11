import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { SITE_BASE } from './site.config.mjs'

// 서빙 base는 site.config.mjs가 단일 결정(GitHub Pages 기본 /web1/ ↔ 커스텀 도메인 /).
// 로컬 dev(localhost:5173)에서도 동일 base로 동작.
export default defineConfig({
  base: SITE_BASE,
  plugins: [react()],
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { SITE_BASE } from './site.config.mjs'

// 서빙 base는 site.config.mjs가 단일 결정(GitHub Pages 기본 /semopl/ ↔ 커스텀 도메인 /).
// 로컬 dev(localhost:5173)에서도 동일 base로 동작.
export default defineConfig({
  base: SITE_BASE,
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // 874KB 단일 index 청크 분해: 런타임(react)·정적 데이터(platforms.json 등)를 분리해
        // 코드 변경 시 데이터 청크 캐시가 살아남게 한다(재방문 로드 개선). 이름은 안정 캐싱 목적.
        codeSplitting: {
          groups: [
            // driver.js(투어)는 실행 시점에 동적 import — vendor(부트 필수)에 합쳐지지 않게 먼저 분리
            { name: "tour", test: /node_modules[\\/]driver\.js/ },
            { name: "vendor", test: /node_modules/ },
            // articles(가이드 본문)는 제외 — 부트 필수가 아니라 lazy guide 청크에 실린다(월간 증분이 부트 페이로드를 키우지 않게)
            { name: "data", test: /src[\\/]data[\\/](?!articles).*\.json$/ },
          ],
        },
      },
    },
  },
})

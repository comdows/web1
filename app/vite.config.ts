import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages는 https://comdows.github.io/web1/ 하위에 서빙되므로 base를 맞춘다.
// 로컬 dev(localhost:5173/web1/)에서도 동일 base로 동작.
export default defineConfig({
  base: '/web1/',
  plugins: [react()],
})

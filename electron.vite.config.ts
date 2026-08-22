import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()],
    server: {
      watch: {
        // 忽略编辑器原子写产生的临时目录（.foo.ts.<pid>.*.tmpdir），避免 Windows EBUSY 崩溃
        ignored: [/[\\/]\.[^\\/]+\.\d+\.[0-9a-f-]+\.tmpdir[\\/]/]
      }
    }
  }
})

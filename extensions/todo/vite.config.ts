import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

/**
 * 待办子应用构建：把 app/（Vue 源码）编译为经典 iife 脚本，
 * 产物（todo.html / todo.js / todo.css）输出到扩展目录根，
 * 随 .oix 打包、经 app://extensions/<id>/todo.html 由 App 子窗口 iframe 加载。
 * 与 obox 主项目的构建完全独立。
 */
export default defineConfig({
  root: resolve(__dirname, 'app'),
  // 相对路径：产物从 app://extensions/<id>/ 任意子路径加载都正确
  base: './',
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'app/todo.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'todo.js',
        chunkFileNames: 'todo.js',
        assetFileNames: 'todo.[ext]'
      }
    }
  }
})

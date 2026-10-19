import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // 两个 main 入口（ADR-0026 / EH-A2）：
        // - index：现有主进程入口（package.json 的 main 指向 out/main/index.js），路径与产物名不变；
        // - extension-host：**扩展宿主进程**入口，由 utilityProcess.fork() 拉起，产物 out/main/extension-host.js。
        //   入口源文件属于 EH-A3（src/extension-host/index.ts），本卡只负责把它挂成第二个 main 产物。
        input: {
          index: resolve('src/main/index.ts'),
          'extension-host': resolve('src/extension-host/index.ts')
        }
      }
    }
  },
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

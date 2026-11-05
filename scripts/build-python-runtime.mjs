/**
 * 构建「Python 运行时扩展」（change「开发运行时」的配套脚本）。
 *
 * 产物：`release/python<version>-<pythonVersion>.oix` —— 一个普通用户扩展包：
 *   manifest.json   (author=obox, name=python<version>)
 *   runtime.json    ({ "language": "python", "version": "<pythonVersion>" })
 *   index.js        (空入口，只为让宿主能加载)
 *   python/         (完整 CPython embeddable + pip + 预装库)
 *
 * 做法与 PyCharm 的内置解释器同类：用一个**自带 site-packages 的完整发行版**，
 * 而不是依赖目标机器安装 Python。
 *
 * 用法：
 *   node scripts/build-python-runtime.mjs                 # 默认 3.11.9 + numpy/pandas/matplotlib
 *   node scripts/build-python-runtime.mjs --version 3.11.9 --tag 3.11
 *
 * 依赖网络（python.org + PyPI）；Windows x64 下运行。产物放 `release/`（已 gitignore）。
 */
import AdmZip from 'adm-zip'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback
}

const pythonVersion = argOf('version', '3.11.9')
const tag = argOf('tag', pythonVersion.split('.').slice(0, 2).join('.'))
const libs = argOf('libs', 'numpy pandas matplotlib').split(/\s+/).filter(Boolean)
const work = join(repo, '.build', `python-runtime-${pythonVersion}`)
const extDir = join(repo, '.build', `python${tag}-ext`)
const outDir = join(repo, 'release')
const outFile = join(outDir, `python${tag}-${pythonVersion}.oix`)

const run = (file, argv, cwd) => execFileSync(file, argv, { cwd, stdio: 'inherit' })

console.log(`[runtime] python ${pythonVersion} / tag ${tag} / libs ${libs.join(', ')}`)
rmSync(work, { recursive: true, force: true })
rmSync(extDir, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(extDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

// 1) 下载 embeddable 发行版
const zipUrl = `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`
const zipPath = join(work, 'python-embed.zip')
console.log(`[runtime] 下载 ${zipUrl}`)
run('powershell', [
  '-NoProfile',
  '-Command',
  `Invoke-WebRequest -Uri '${zipUrl}' -OutFile '${zipPath}'`
])
run('powershell', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -Path '${zipPath}' -DestinationPath '${work}' -Force`
])

// 2) 打开 site-packages（embeddable 默认不带）
const pth = join(work, `python${pythonVersion.split('.').slice(0, 2).join('')}._pth`)
writeFileSync(
  pth,
  `python${pythonVersion.split('.').slice(0, 2).join('')}.zip\r\n.\r\nLib\\site-packages\r\nimport site\r\n`
)
mkdirSync(join(work, 'Lib', 'site-packages'), { recursive: true })

// 3) pip + 预装库
const py = join(work, 'python.exe')
const getPip = join(work, 'get-pip.py')
console.log('[runtime] 安装 pip')
run('powershell', [
  '-NoProfile',
  '-Command',
  `Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile '${getPip}'`
])
run(py, [getPip, '--no-warn-script-location'])
console.log(`[runtime] 安装 ${libs.join(', ')}`)
run(py, [
  '-m',
  'pip',
  'install',
  '--no-warn-script-location',
  '--disable-pip-version-check',
  ...libs
])
run(py, ['-c', `import ${libs.map((l) => l.replace(/-/g, '_')).join(', ')}; print('imports ok')`])

// 4) 组装扩展目录
writeFileSync(
  join(extDir, 'manifest.json'),
  JSON.stringify(
    {
      name: `python${tag}`,
      displayName: `Python ${tag} 运行时`,
      description: `内置 Python ${pythonVersion}（预装 ${libs.join(' / ')}），供 api.python 使用`,
      version: pythonVersion,
      author: 'obox',
      apiVersion: 4,
      main: './index.js',
      activationEvents: ['onStartupFinished']
    },
    null,
    2
  )
)
writeFileSync(
  join(extDir, 'runtime.json'),
  JSON.stringify({ language: 'python', version: pythonVersion })
)
writeFileSync(
  join(extDir, 'index.js'),
  `export default function plugin(api) {\n  api.log?.info?.('Python ${pythonVersion} runtime ready (${libs.join(' / ')} preinstalled)')\n}\n`
)
cpSync(work, join(extDir, 'python'), { recursive: true })

// 5) 打成 .oix（adm-zip 保证条目用 `/`，installer 按 zip 规范解析）
if (existsSync(outFile)) rmSync(outFile, { force: true })
const zip = new AdmZip()
zip.addLocalFolder(extDir)
zip.writeZip(outFile)
console.log(`[runtime] 产物：${outFile}`)

import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/vendor',
      'skills/**',
      'extensions/**',
      // 仓库级独立 Node 脚本（如 scripts/validate-manifest.mjs）：纯 JS、不带 TS 类型标注，
      // 且要能被整份复制到**没有 obox 源码**的扩展仓库里直接跑（见 ADR-0020 决策 3、ADR-0023 决策 5）。
      // 它不参与 TS 编译，要求 `explicit-function-return-type` 只会逼出仓库专属的豁免注释。
      'scripts/**/*.mjs',
      // 临时 TS 探针（spec/设计/变异脚本等开发中间产物）都放这里；与 .gitignore 的 `/tmp/` 保持一致。
      // 否则临时探针会把 `npm run lint` 刷成一片 warning，从而污染"lint 必须 0"的门槛结论。
      'tmp/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  eslintConfigPrettier
)

# Scripts

`skills/obox-ext-dev/scripts/` 下的开发工具脚本（Node.js，跨平台，无依赖）。

## create-extension.mjs — 扩展脚手架

在当前项目 `src/renderer/src/extensions/<id>/` 生成新内置扩展骨架（manifest.json + index.ts + 视图组件模板）。

```bash
node skills/obox-ext-dev/scripts/create-extension.mjs my-hello \
  --title "你好" \
  --desc "示例扩展"
```

参数：

| 参数 | 说明 |
|---|---|
| `<id>` | 扩展 id（必填），匹配 `^[a-z0-9][a-z0-9._-]*$` |
| `--title` | 显示名（默认 = id） |
| `--desc` | 简介 |

目录已存在时中止，不覆盖。生成后按 `references/guides.md` 编辑 manifest 与入口。

## validate-manifest.mjs — manifest 校验

校验扩展 manifest 字段，规则与宿主 `src/renderer/src/core/manifest.ts` 一致。

```bash
# 校验单个/多个 manifest
node skills/obox-ext-dev/scripts/validate-manifest.mjs src/renderer/src/extensions/app/manifest.json

# 校验全部内置扩展
node skills/obox-ext-dev/scripts/validate-manifest.mjs --all
```

退出码：`0` = 通过（warning 允许）；`1` = 存在 error；`2` = 用法错误。

适用于开发期快速检查或 CI 门禁（配合 `npm run typecheck && npm run lint`）。

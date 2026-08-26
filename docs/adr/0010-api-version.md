# 扩展 API 版本（apiVersion）：单 int 版本号，高版本 obox 兼容低版本扩展

obox 在根 `package.json` 声明 `apiVersion`（单个非负整数，当前 `1`）；扩展在 manifest 声明 `apiVersion` 表示其要求的 obox API 版本。校验规则：缺失视为 `0`（兼容所有）；`apiVersion <= obox 的 apiVersion` 通过；`apiVersion > obox 的 apiVersion` 校验 error、拒绝加载。

## 背景与问题

1. 扩展系统演进中，obox 的扩展 API（`ExtensionActivationApi`、贡献点、宿主能力）会随版本变化；扩展需要声明自己依赖的 API 版本，避免在新旧宿主间因 API 不匹配而运行异常。
2. 要求"扩展版本必须与 obox 的 api 版本匹配"，同时"高版本的 api 兼容低版本的 api"——即版本号语义必须是**向后兼容的单向门槛**，而非精确相等。

## 决策

1. **单 int 版本号**：`apiVersion` 用单个非负整数（`1`、`2` …），不用 semver 字符串——版本门槛比较只需整数大小，语义直观。
2. **单源**：obox 当前 API 版本单源定义在根 `package.json` 的 `apiVersion` 字段，宿主校验逻辑（`core/manifest.ts`）经 Vite JSON import 读取，避免多处维护。
3. **匹配规则**：`manifest.apiVersion <= obox 的 apiVersion` → 通过；`>` → **error**（"需要 obox API vN 或更高"），扩展 `isValid=false` 不加载、管理列表标红；**缺失视为 `0`**（老扩展不受影响）；非整数/负数 → error。
4. **递增策略**：`apiVersion` 仅在**破坏性 API 签名变更**（删改 `ExtensionActivationApi`、贡献点 schema 等）时递增；纯新增能力不递增（高版本 obox 兼容低版本扩展）。
5. 扩展声明 `apiVersion` 是**可选**的（缺失=0），对现有扩展零影响；内置扩展暂不强制填写。

## 备选与权衡

- semver 字符串（`1.0.0`）：比较需解析、`^`/`~` 语义对扩展场景过度设计 → 否定，单 int 足够。
- 精确相等匹配（扩展版本必须 == obox 版本）：违背"高版本兼容低版本"需求，升级 obox 会误伤全部旧扩展 → 否定，用 `<=` 门槛。
- apiVersion 独立文件/常量模块维护：根 `package.json` 已是版本信息的自然归属，JSON import 在 electron-vite 下零配置 → 采用单源 package.json。

Status: accepted

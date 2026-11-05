# `.oix` 平台规则（用户扩展）

> 适用于**用户扩展**（`.oix` 安装包）。系统扩展随 obox 安装包分发、按应用自身架构构建，**不适用本规则**。

## 1. 平台标识与产物名

| 层级          | `manifest.platforms`   | 产物文件名                       | 说明                     |
| ------------- | ---------------------- | -------------------------------- | ------------------------ |
| 通用          | `["universal"]` 或缺省 | `<name>-<version>.oix`           | 任意 OS / 架构可装       |
| Windows 通用  | `["win32"]`            | `<name>-<version>-win.oix`       | 只限 Windows，不区分架构 |
| Windows x64   | `["win32-x64"]`        | `<name>-<version>-win-x64.oix`   | 含 x64 原生二进制        |
| Windows arm64 | `["win32-arm64"]`      | `<name>-<version>-win-arm64.oix` | 含 arm64 原生二进制      |

未来只加表项、不改规则：`linux-x64`、`linux-arm64`、`darwin-arm64` …（先补 `KNOWN_PLATFORMS`、
文件名后缀映射、本文档，再发版）。

**规则来源**：`src/main/oixPlatform.ts`（安装器与发布脚本共用同一份实现），单测
`test/oix-platform.test.ts` 是规则的可执行版本。

## 2. 清单与元数据

```jsonc
// manifest.json（架构相关包必须声明；通用包不要写 platforms）
{
  "name": "python3.11",
  "author": "obox",
  "version": "3.11.9",
  "platforms": ["win32-x64"],
  "python": { "arch": "x64", "python": "3.11" } // 复用现有安装期架构校验
}
```

- `platforms` 缺省 = `["universal"]`；非法值（未知标识 / 非字符串）⇒ 安装报
  `invalid-manifest`，**不静默当通用包**；
- 只声明 `platforms` 而不声明 `python.arch` 也可以（例如带普通 node 原生模块的扩展）；
- 内置运行时（`runtime.json` 标记）同样由 `manifest.platforms` 决定平台。

## 3. 安装器行为

1. 读包内 `manifest.platforms`，与宿主 `platform + arch` 比对；
2. 不匹配 → 错误码 **`platform-mismatch`**，文案带双方平台：
   `此包支持 win32-arm64，当前设备为 win32-x64，请安装对应平台的包`；
3. 同版本内置运行时仍受 `runtime-version-conflict` 约束（见运行时包文档）；
4. 「设置 → 开发运行时」列表展示已装运行时的平台标签。

## 4. CI 与发布

扩展仓库只放**源码与 CI**（不入库任何运行时二进制）：

```
<extension-repo>/
├── manifest.json  runtime.json  index.js
├── scripts/build-runtime.mjs        # 下载对应架构运行时 → 装预装库 → 打包 .oix
└── .github/workflows/build-oix.yml  # 矩阵：win32-x64 / win32-arm64
```

- `push tag v*`：矩阵两架构各出一个 `.oix`，命名按第 1 节，随 Release 上传并附 `SHA256SUMS.txt`；
- `workflow_dispatch`：只出 Actions artifact，不发版（用于验证）；
- 通用扩展（pet / rdp / webapp / todo / obox-updater）：`platforms` 缺省即可，文件名不带后缀。

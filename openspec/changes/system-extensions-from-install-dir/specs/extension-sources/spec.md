# Spec Delta

## Purpose

定义 obox 扩展的**来源模型**：系统扩展随安装包分发在安装目录、用户扩展在 userData；两者的目录命名、id 规则、扫描顺序、同 id 遮蔽与数据位置。目标是让"扩展"成为唯一的界面组织方式，同时保证系统扩展随应用升级、用户扩展可独立装卸。

## ADDED Requirements

### Requirement: 两个扩展根与扫描顺序

系统 MUST 先扫描 `<安装目录>\extensions\`，再扫描 `<userData>\extensions\`；两个根都按"目录名即扩展 id"解析。

#### Scenario: 两个根都有扩展

- **WHEN** 安装目录下有 `settings`、userData 下有 `pet.chenzhi`
- **THEN** 两者都被列出，`settings` 来源标注为「系统」、`pet.chenzhi` 标注为「用户」

#### Scenario: 系统根为空

- **WHEN** 安装目录下没有 `extensions` 目录
- **THEN** 应用仍正常启动，只列出用户扩展，且不报错

### Requirement: 目录命名与 id 规则

系统扩展的目录名 MUST 为 `<name>`、id MUST 等于该目录名；用户扩展的目录名 MUST 为 `<name>.<author>`、id MUST 等于该目录名。系统扩展的清单 `author` MUST 为 `obox`。

#### Scenario: 用户扩展 id 带作者

- **WHEN** 用户目录下存在 `pet.chenzhi/manifest.json`（name=pet、author=chenzhi）
- **THEN** 该扩展的 id 为 `pet.chenzhi`，且 `app://extensions/pet.chenzhi/…` 能取到它的文件

#### Scenario: 目录名与清单不一致

- **WHEN** 用户目录名是 `pet.chenzhi` 但清单的 name/author 推不出同名 id
- **THEN** 该扩展被判为清单无效并给出可读原因，不参与激活

### Requirement: 同 id 时系统扩展优先

两个根出现相同 id 时，系统扩展 MUST 生效；用户目录中的同 id 扩展 MUST 被忽略，并在扩展管理器中标注「已被系统扩展遮蔽」。

#### Scenario: 用户装了同名扩展

- **WHEN** 系统提供 `settings`，用户目录里也有 `settings`
- **THEN** 生效的是系统那份；管理器里用户那份显示「已遮蔽」，不可启用

### Requirement: 数据目录按 id 放在 userData

所有扩展（含系统扩展）的数据 MUST 位于 `<userData>\extensions\<id>\data`；系统扩展的代码目录只读，MUST NOT 向其写入任何数据。

#### Scenario: 系统扩展写数据

- **WHEN** 系统扩展调用 `api.fs.writeFile('a.json', …)`
- **THEN** 文件落在 `<userData>\extensions\<id>\data\a.json`，安装目录下不产生任何文件

### Requirement: 系统扩展不可卸载、不可禁用

系统扩展 MUST NOT 被卸载或禁用；扩展管理器 MUST 不提供这两个操作，调用底层接口时 MUST 被拒绝并给出可读原因。

#### Scenario: 尝试卸载系统扩展

- **WHEN** 对系统扩展 id 调用卸载
- **THEN** 返回失败并提示「系统扩展不可卸载」，磁盘与运行状态均不变

### Requirement: 系统扩展随安装包分发

系统扩展 MUST 由安装包写入 `<安装目录>\extensions\<name>\`；应用升级时该目录整体替换，用户扩展目录 MUST NOT 被安装包触碰。

#### Scenario: 升级应用

- **WHEN** 用户从 A 版升级到 B 版
- **THEN** 系统扩展变为 B 版权本，用户扩展目录内容与数据保持不变

### Requirement: 旧命名不再被识别

旧的下划线目录名（如 `pet_chenzhi`）MUST NOT 被当作扩展加载。

#### Scenario: 残留旧目录

- **WHEN** userData 下同时存在 `pet_chenzhi`（旧）与 `pet.chenzhi`（新）
- **THEN** 只加载 `pet.chenzhi`，旧目录被跳过且不报错

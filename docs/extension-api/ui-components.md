# 组件样式库（`app://obox/ui.css`）

> **本文件是 obox 组件样式库的唯一真相**：组件清单、命名与状态约定、注入方式、可复制片段。
> 实现是 `src/page-runtime/ui.css`（随安装包分发的**预编译**产物，经 `app://obox` 提供）。

## 定位与边界

- **纯 CSS**：不注入脚本、不监听事件、不接管 DOM。弹窗开合、下拉定位、Tabs 切换、Toast 消失都由页面自己控制，库只决定"长什么样"。
- **只消费主题 token**：所有颜色/边框/阴影/字体取自 `--bg`、`--fg`、`--accent`…（25 个主题 token）。
  因此**切主题即时生效**，不需要重载样式表；库内不写任何十六进制色值。
- **不污染页面**：全部选择器带 `obox-` 前缀，不写裸元素选择器（`button {}` / `select {}`）与全局重置。
- 库自己只新增 `--obox-*` 尺寸/圆角/层级变量，**不新增主题 token**。

## 注入方式

**推荐**：用页面运行时，它默认注入且幂等。

```html
<script type="module">
  import { startPageContext } from 'app://obox/page.js'

  startPageContext({
    onChange: (ctx) => {
      /* token/colorScheme/词条都由运行时处理 */
    }
  })
</script>
```

**不用运行时**（例如极简静态页）就自己写 link：

```html
<link rel="stylesheet" href="app://obox/ui.css" />
```

- `startPageContext({ disableUiCss: true })` 可关闭自动注入（此时自己写 link，或完全不用库）。
- 页面已经手写过带 `data-obox-ui` 的 `<link>` 时，运行时不会重复注入。

## 命名与状态约定

- class：`obox-组件` + 变体/尺寸修饰 `--primary` / `--sm`；元素位用 `__`（`obox-btn__icon`）。
- 状态**用语义属性**，不用 `is-*` 私有类，这样可访问性与样式同一来源：

| 状态   | 写法                                      | 例子                                             |
| ------ | ----------------------------------------- | ------------------------------------------------ |
| 禁用   | `aria-disabled="true"`                    | `<button class="obox-btn" aria-disabled="true">` |
| 加载   | `data-loading="true"`（按钮内自动出转圈） | `<button class="obox-btn" data-loading="true">`  |
| 错误   | `aria-invalid="true"`                     | `<input class="obox-input" aria-invalid="true">` |
| 选中   | `aria-selected="true"`                    | tabs / list / tree / segmented / pagination      |
| 展开   | `aria-expanded="true/false"`              | tree 节点                                        |
| 当前项 | `aria-current="page" / "step"`            | breadcrumb / pagination / steps                  |
| 只读   | `readonly`                                | `<input class="obox-input" readonly>`            |

尺寸：`--sm` / 默认 / `--lg`（控件高度 24 / 30 / 36px）。块级按钮：`--block`。

## 组件清单

> 每一类都支持禁用态；下表列出最常用的变体，完整规则见 `src/page-runtime/ui.css`。

### 布局

| class                                                             | 说明                                     |
| ----------------------------------------------------------------- | ---------------------------------------- |
| `obox-layout` + `__sider` / `__header` / `__content` / `__footer` | 标准两栏/三栏骨架                        |
| `obox-row`（+ `--gap-sm` / `--gap-lg` / `--nowrap`）              | flex 行                                  |
| `obox-col--1..12`                                                 | 12 栅格列（1/2/3/4/6/8/9/12 有专用宽度） |
| `obox-divider`（+ `--vertical` / `--with-text`）                  | 分隔线                                   |

### 排版

`obox-title`（`--h1`～`--h4`）、`obox-text`（`--secondary` / `--success` / `--warning` / `--danger` / `--disabled` / `--sm` / `--accent`）、`obox-muted`、`obox-link`、`obox-code`、`obox-kbd`、`obox-truncate`。

### 按钮

`obox-btn` + 变体 `--primary` / `--danger` / `--ghost` / `--dashed` / `--text` / `--link` + 尺寸 `--sm` / `--lg` + `--block` / `--icon`；图标位 `obox-btn__icon`；按钮组 `obox-btn-group`。

```html
<button class="obox-btn obox-btn--sm">禁用</button>
<button class="obox-btn obox-btn--sm obox-btn--danger">卸载</button>
<button class="obox-btn obox-btn--primary" data-loading="true">安装中…</button>
```

### 表单

| class                                                         | 说明                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `obox-form-item`（+ `--inline` / `--required` / `--invalid`） | 表单项容器；`__label` / `__help` / `__error`          |
| `obox-input`（`--sm` / `--lg`）                               | 输入框；`readonly` / `aria-invalid` / `aria-disabled` |
| `obox-input-group` + `__prefix` / `__suffix`                  | 带前后缀的输入框                                      |
| `obox-textarea`                                               | 文本域                                                |
| `obox-select`（`--sm` / `--lg`）                              | 原生 select 的统一样式                                |
| `obox-checkbox` / `obox-radio` / `obox-switch`                | 复选 / 单选 / 开关（`<label>` 包 `<input>`）          |
| `obox-number` + `__step`                                      | 数字输入（带步进按钮位）                              |

```html
<label class="obox-form-item obox-form-item--inline obox-form-item--required">
  <span class="obox-form-item__label">代理地址</span>
  <input class="obox-input" value="http://127.0.0.1:7890" />
</label>
```

### 数据展示

`obox-card`（`__header` / `__body` / `__footer`，`--flat` / `--bordered`）、`obox-list` + `obox-list__item`（`--compact` / `--divided`）、`obox-table`（`--bordered` / `--striped` / `--hover` / `--compact`，`obox-table__num` 数字右对齐）、`obox-tag`（`--success` / `--warning` / `--danger` / `--info`）、`obox-badge`（`--dot`）、`obox-avatar`（`--sm` / `--lg` / `--square`）、`obox-progress` + `obox-progress__bar`（`--success` / `--warning` / `--danger`）、`obox-stat`（`__value` / `__label`）、`obox-desc`（`__term` / `__detail`）、`obox-empty`（`__icon` / `__text` / `__actions`）、`obox-skeleton`（`--text` / `--circle` / `--rect`）。

### 反馈

`obox-alert`（`--info` / `--success` / `--warning` / `--danger`，`__icon` / `__body` / `__close`）、`obox-spinner`（`--lg`）、`obox-modal__mask` / `__panel`（`--sm` / `--lg`）/ `__header` / `__body` / `__footer`、`obox-drawer`（`--left` / `--lg`）、`obox-tooltip`、`obox-popover`。

```html
<!-- 显隐由页面自己控制；库只给外观 -->
<div class="obox-modal__mask">
  <div class="obox-modal__panel" role="dialog" aria-modal="true" aria-label="确认">
    <div class="obox-modal__header">确认卸载？</div>
    <div class="obox-modal__body">该操作不可撤销。</div>
    <div class="obox-modal__footer">
      <button class="obox-btn">取消</button>
      <button class="obox-btn obox-btn--danger">卸载</button>
    </div>
  </div>
</div>
```

### 导航

`obox-tabs` + `obox-tabs__item`（`--card`）、`obox-breadcrumb`（`__item` / `__sep`）、`obox-pagination` + `__item`、`obox-steps`（`--vertical`）+ `__step`、`obox-tree` + `obox-tree__node` / `obox-tree__children`、`obox-segmented` + `__item`、`obox-menu` + `obox-menu__item`（`--danger`）。

## 常见用法与坑

1. **想用库的部分组件**：直接加 class 即可，不需要额外引入；不写 `obox-base` 也没问题（它只提供 `box-sizing` 与字体基线）。
2. **覆盖库样式**：`ui.css` 由运行时注入到 `head` **末尾**，与页面样式同特异性时**库胜出**。要覆盖就提高特异性（例如 `.panel .obox-form-item--inline`）或把自己的 `<style>` 放到注入之后。
3. **不要用裸元素选择器改外观**：页面自己的 `button { }` 会同时命中库组件，排查时非常难看出是谁覆盖了谁。
4. **深色/浅色都验一遍**：颜色来自 token，浅色主题下对比度问题只会在切换后才暴露。
5. **弹窗类没有 JS**：`obox-modal__mask` 只是外观；`role="dialog"` / `aria-modal` / 焦点管理由页面自己写（参考 `api-reference.md` 的 `ui` 模态框能力，能用宿主模态框时优先用）。
6. **首帧**：运行时会先写默认暗色 token 再注入样式，页面不会闪白；不用运行时的页面请自己保证 token 已定义。

## 与系统扩展的关系

`app`、`settings`、`ext-manager` 三个系统扩展页都使用本库，它们的 `page.css` 只保留布局与页面专有样式。
新增组件时请先加到这里（以及 `src/page-runtime/ui.css`），不要先在某个页面里写一份——那份样式很快就会与库漂移
（门禁：`test/ui-css.test.ts` 与 `test/system-extensions-independence.test.ts`）。

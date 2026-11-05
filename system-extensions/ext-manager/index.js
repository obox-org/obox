/**
 * 系统扩展 `ext-manager` 的入口。
 *
 * 这个扩展的 UI 是磁盘上的 HTML 页面（`index.html`），页面通过 `window.obox` 桥调用公共 API；
 * 入口本身只负责声明"激活成功"——贡献点（导航项）来自 manifest，页面由壳子装载。
 */
export default function plugin(api) {
  api.log?.info?.('ext-manager 系统扩展已激活')
}

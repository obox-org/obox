/**
 * 系统扩展 `app` 的入口：首页 UI 在磁盘页面里（`index.html`），这里只确认激活。
 */
export default function plugin(api) {
  api.log?.info?.('app 系统扩展已激活')
}

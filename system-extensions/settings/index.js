/**
 * 系统扩展 `settings` 的入口：设置界面在磁盘页面里（`index.html`），这里只确认激活。
 */
export default function plugin(api) {
  api.log?.info?.('settings 系统扩展已激活')
}

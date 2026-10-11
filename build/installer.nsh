; 自定义 NSIS 脚本（electron-builder `nsis.include`）
; 卸载时清理"开机自启"（ADR-0019 决策 15）：
;   1. HKCU\...\Run 里的启动项（值与写入时的 name 一致，见 src/main/autoStartCore.ts）
;   2. HKCU\...\Explorer\StartupApproved\Run 里的同名状态（任务管理器"启动应用"里的启用/禁用记录）
; 不清理会留下指向已删除 obox.exe 的无效条目。
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.obox.app"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.obox.app"
!macroend

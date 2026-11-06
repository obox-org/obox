; 自定义 NSIS 脚本（electron-builder `nsis.include`）
;
; 两件事：
; 1. **卸载时清理"开机自启"**（ADR-0019 决策 15）：
;    HKCU\...\Run 里的启动项（值与写入时的 name 一致，见 src/main/autoStartCore.ts）与
;    HKCU\...\Explorer\StartupApproved\Run 里的同名状态（任务管理器"启动应用"里的启用/禁用记录）。
;    不清理会留下指向已删除 obox.exe 的无效条目。
; 2. **升级时保住手动安装的运行时扩展**（obox 2.3 起）：运行时包（目录根带 runtime.json）由用户
;    手动装进 `<安装目录>/extensions`，而 electron-builder 的卸载器在升级时会 `RMDir /r $INSTDIR`
;    （见 node_modules/app-builder-lib/templates/nsis/uninstaller.nsh:160-187）⇒ 不备份就会**每次升级
;    丢一份 100MB 解释器**。
;
;    做法：安装器 `.onInit`（customInit，在 uninstallOldVersion 之前）把旧 `extensions/` 整个备份到
;    %TEMP%，安装结束后（customInstall）**只把带 runtime.json 的子目录搬回**——系统扩展
;    （app / settings / ext-manager）必须用新安装包里的那一份，旧版不能被覆盖回去。
;
;    为什么备份/恢复都放在**新**安装器里：旧版本的卸载器由旧构建生成，改不到；新安装器在调用
;    uninstallOldVersion **之前**就备份（.onInit 早于 install section），因此**从任何旧版本升级都覆盖**
;    （包括 2.2.0 → 2.3.0 的第一次）。

; ---------------------------------------------------------------------------------------------
; 1. 卸载：开机自启清理
; ---------------------------------------------------------------------------------------------
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.obox.app"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.obox.app"
!macroend

; ---------------------------------------------------------------------------------------------
; 2. 升级：备份旧 extensions/（只留 runtime.json 的那些，装完再搬回）
; ---------------------------------------------------------------------------------------------
!macro customInit
  ; 先清掉上一次可能残留的备份（幂等；崩溃留下的陈旧备份不该被恢复）
  RMDir /r "$TEMP\obox-runtime-preserve"

  ; 旧安装位置：与 electron-builder 的 uninstallOldVersion 同源（注册表 InstallLocation）
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R9 != ""
  ${andIf} ${FileExists} "$R9\extensions"
    CreateDirectory "$TEMP\obox-runtime-preserve"
    nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$R9\extensions" "$TEMP\obox-runtime-preserve" /E /NFL /NDL /NJH /NJS /NP'
    ; 哨兵文件：customInstall 用它判断"本次确实是升级且备份成功"（空目录无法用 IfFileExists 判断）
    FileOpen $0 "$TEMP\obox-runtime-preserve\.preserve" w
    FileClose $0
  ${endif}
!macroend

; ---------------------------------------------------------------------------------------------
; 3. 安装结束：把备份里的运行时子目录搬回新安装目录
; ---------------------------------------------------------------------------------------------
!macro customInstall
  ${if} ${FileExists} "$TEMP\obox-runtime-preserve\.preserve"
    FindFirst $0 $1 "$TEMP\obox-runtime-preserve\*.*"
    oboxRuntimeRestoreLoop:
      StrCmp $1 "" oboxRuntimeRestoreDone
      StrCmp $1 "." oboxRuntimeRestoreNext
      StrCmp $1 ".." oboxRuntimeRestoreNext
      ${if} ${FileExists} "$TEMP\obox-runtime-preserve\$1\runtime.json"
        nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$TEMP\obox-runtime-preserve\$1" "$INSTDIR\extensions\$1" /E /NFL /NDL /NJH /NJS /NP'
      ${endif}
    oboxRuntimeRestoreNext:
      FindNext $0 $1
      Goto oboxRuntimeRestoreLoop
    oboxRuntimeRestoreDone:
    FindClose $0
    RMDir /r "$TEMP\obox-runtime-preserve"
  ${endif}
!macroend

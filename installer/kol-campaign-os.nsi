; KOL Campaign OS - Windows installer
; Per-user install (no admin): %LOCALAPPDATA%\KOL-Campaign-OS
; Bundles Node + MariaDB; registers a logon scheduled task for auto-start.
;
; Build: makensis /DVERSION=1.0.0 /DOUTDIR=<dist> installer\kol-campaign-os.nsi

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "FileFunc.nsh"
${Using:StrFunc} StrRep

!ifndef VERSION
  !define VERSION "0.0.0-dev"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\dist"
!endif

Name "KOL Campaign OS"
OutFile "${OUTDIR}\KOL-Campaign-OS-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\KOL-Campaign-OS"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!define APP_NAME "KOL Campaign OS"
!define TASK_NAME "KOL-Campaign-OS"
!define REG_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\KOL-Campaign-OS"
!define REG_APP "Software\KOL-Campaign-OS"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "服务已在后台启动。之后每次开机都会自动运行，浏览器打开 http://localhost:5001 即可使用。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "打开工作台 (http://localhost:5001)"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenWorkbench
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var DbPort

Function OpenWorkbench
  ExecShell "open" "http://localhost:5001"
FunctionEnd

; $0 = port -> sets $1 = 1 if listening, else 0
Function PortInUse
  nsExec::ExecToStack 'powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort $0 -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}"'
  Pop $1 ; return code: 0 = in use
  ${If} $1 == 0
    StrCpy $1 "1"
  ${Else}
    StrCpy $1 "0"
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  DetailPrint "复制程序文件..."
  File /r "..\dist\app\*.*"

  ; --- pick a free DB port (3306 -> 3307 -> 3308) ---
  StrCpy $DbPort "3306"
  ${ForEach} $R0 3306 3308 + 1
    StrCpy $0 $R0
    Call PortInUse
    ${If} $1 == "0"
      StrCpy $DbPort $R0
      ${ExitFor}
    ${EndIf}
  ${Next}
  DetailPrint "数据库端口: $DbPort"

  ; --- .env (keep existing on upgrade) ---
  ${IfNot} ${FileExists} "$INSTDIR\.env"
    FileOpen $0 "$INSTDIR\.env" w
    FileWrite $0 "PORT=5001$\r$\n"
    FileWrite $0 "DB_HOST=127.0.0.1$\r$\n"
    FileWrite $0 "DB_PORT=$DbPort$\r$\n"
    FileWrite $0 "DB_USER=kol_user$\r$\n"
    FileWrite $0 "DB_PASSWORD=kol_password$\r$\n"
    FileWrite $0 "DB_NAME=kol_campaign_os$\r$\n"
    FileWrite $0 "# APP_ACCESS_PASSWORD=$\r$\n"
    FileClose $0
  ${EndIf}

  ; --- data\my.ini (forward-slash paths) ---
  CreateDirectory "$INSTDIR\data"
  ${StrRep} $R1 "$INSTDIR" "\" "/"
  FileOpen $0 "$INSTDIR\data\my.ini" w
  FileWrite $0 "[mysqld]$\r$\n"
  FileWrite $0 "datadir=$R1/data/mariadb$\r$\n"
  FileWrite $0 "port=$DbPort$\r$\n"
  FileWrite $0 "bind-address=127.0.0.1$\r$\n"
  FileWrite $0 "character-set-server=utf8mb4$\r$\n"
  FileWrite $0 "collation-server=utf8mb4_unicode_ci$\r$\n"
  FileWrite $0 "innodb_buffer_pool_size=128M$\r$\n"
  FileWrite $0 "skip-name-resolve$\r$\n"
  FileClose $0

  ; --- remember port for the uninstaller ---
  WriteRegStr HKCU ${REG_APP} "DBPort" "$DbPort"

  ${IfNot} ${FileExists} "$INSTDIR\logs"
    CreateDirectory "$INSTDIR\logs"
  ${EndIf}

  ; --- register logon scheduled task (per-user, no admin) ---
  DetailPrint "注册开机自启..."
  nsExec::ExecToLog 'schtasks /create /tn "${TASK_NAME}" /sc onlogon /rl limited /f /tr "wscript.exe \"$INSTDIR\scripts\start-hidden.vbs\""'
  Pop $0
  ${If} $0 != 0
    DetailPrint "警告：计划任务注册失败（可在安装目录手动运行 scripts\start-service.bat）"
  ${EndIf}

  ; --- start the app now (detached, hidden) ---
  DetailPrint "启动应用服务..."
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\scripts\start-hidden.vbs"'

  ; --- wait for the app health endpoint (max ~3 min; first run includes DB migrations) ---
  DetailPrint "等待服务就绪（首次启动含数据库迁移，可能需要 1-3 分钟）..."
  StrCpy $R2 0
  wait_app:
    IntOp $R2 $R2 + 1
    ${If} $R2 > 36
      DetailPrint "警告：服务 3 分钟内未就绪。请稍后手动打开 http://localhost:5001"
      Goto app_done
    ${EndIf}
    Sleep 5000
    nsExec::ExecToStack 'powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -Uri http://localhost:5001/api/health -TimeoutSec 4).StatusCode -eq 200 | Out-Null; exit 0}catch{exit 1}"'
    Pop $0
    ${If} $0 != 0
      Goto wait_app
    ${EndIf}
  app_done:
  DetailPrint "服务已就绪: http://localhost:5001"

  ; --- uninstaller + registry entry ---
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU ${REG_UNINST} "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU ${REG_UNINST} "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU ${REG_UNINST} "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU ${REG_UNINST} "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  ; --- stop the app (PID listening on 5001) ---
  nsExec::ExecToLog 'powershell -NoProfile -Command "$$c=Get-NetTCPConnection -LocalPort 5001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($$c){Stop-Process -Id $$c.OwningProcess -Force -ErrorAction SilentlyContinue}"'

  ; --- stop MariaDB gracefully ---
  ReadRegStr $DbPort HKCU ${REG_APP} "DBPort"
  ${If} $DbPort == ""
    StrCpy $DbPort "3306"
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\mariadb\bin\mariadb-admin.exe" --protocol=TCP -h127.0.0.1 -P$DbPort -uroot shutdown'
  Sleep 3000

  ; --- remove scheduled task ---
  nsExec::ExecToLog 'schtasks /delete /tn "${TASK_NAME}" /f'

  ; --- data retention choice ---
  MessageBox MB_YESNO|MB_ICONQUESTION "是否保留数据库数据（$INSTDIR\data）？$\r$\n$\r$\n选「是」保留数据，重装后数据仍在；选「否」彻底删除所有数据。" IDYES keep_data
    Delete "$INSTDIR\data\*.*"
    RMDir /r "$INSTDIR\data"
  keep_data:

  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\mariadb"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\client"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\logs"
  Delete "$INSTDIR\.env"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU ${REG_UNINST}
  DeleteRegKey HKCU ${REG_APP}
SectionEnd

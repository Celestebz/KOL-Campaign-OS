@echo off
rem Registers KOL Campaign OS to start automatically at user logon,
rem adds a LAN firewall rule for port 5001, and schedules the daily DB backup.
rem Right-click and "Run as administrator" (needed for the firewall rule).

chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Please right-click this file and choose "Run as administrator".
    pause
    exit /b 1
)

echo [1/3] Registering logon task "KOL-Campaign-OS"...
schtasks /create /tn "KOL-Campaign-OS" /tr "wscript.exe \"%CD%\scripts\start-hidden.vbs\"" /sc ONLOGON /rl HIGHEST /f
if %errorlevel% neq 0 (
    echo [ERROR] Failed to register the scheduled task.
    pause
    exit /b 1
)

echo [2/3] Registering daily backup task "KOL-Campaign-OS-Backup" (12:30)...
schtasks /create /tn "KOL-Campaign-OS-Backup" /tr "\"%CD%\scripts\backup-db.bat\"" /sc DAILY /st 12:30 /f
if %errorlevel% neq 0 (
    echo [WARN] Failed to register the backup task. You can retry later.
)

echo [3/3] Adding firewall rule for TCP port 5001 (LAN access)...
netsh advfirewall firewall add rule name="KOL-Campaign-OS" dir=in action=allow protocol=TCP localport=5001 >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Firewall rule was not added. Team members may not be able to access this machine.
)

echo.
echo Done. KOL Campaign OS will start automatically when you sign in.
echo Your bookmark: http://localhost:5001
echo Team bookmark: http://^<this machine's LAN IP^>:5001
echo.
echo Starting the service now in the background...
start "" wscript.exe "%CD%\scripts\start-hidden.vbs"
echo.
pause

@echo off
rem Removes the KOL Campaign OS auto-start task, backup task and firewall rule.
rem Right-click and "Run as administrator".

chcp 65001 >nul

net session >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Please right-click this file and choose "Run as administrator".
    pause
    exit /b 1
)

echo [1/3] Removing scheduled task "KOL-Campaign-OS"...
schtasks /delete /tn "KOL-Campaign-OS" /f >nul 2>nul
if %errorlevel% neq 0 echo [INFO] Task not found or already removed.

echo [2/3] Removing scheduled task "KOL-Campaign-OS-Backup"...
schtasks /delete /tn "KOL-Campaign-OS-Backup" /f >nul 2>nul
if %errorlevel% neq 0 echo [INFO] Task not found or already removed.

echo [3/3] Removing firewall rule "KOL-Campaign-OS"...
netsh advfirewall firewall delete rule name="KOL-Campaign-OS" >nul 2>nul
if %errorlevel% neq 0 echo [INFO] Firewall rule not found or already removed.

echo.
echo Auto-start has been disabled. The currently running server (if any) keeps
echo running until you sign out or run 停止.bat.
echo.
pause

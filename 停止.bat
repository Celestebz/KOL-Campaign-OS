@echo off
chcp 65001 >nul
title Stop KOL Campaign OS

echo ==========================================
echo        Stopping KOL Campaign OS...
echo ==========================================
echo.

echo [1/2] Releasing ports 5001 and 3000...
powershell -Command "$ports = 5001,3000; $processes = Get-NetTCPConnection -LocalPort $ports -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique; if ($processes) { $processes | ForEach-Object { Write-Host 'Stopping process ID:' $_; Stop-Process -Id $_ -Force } } else { Write-Host 'No process found on target ports.' }"

echo.
echo [2/2] Cleaning remaining Node.js processes...
taskkill /F /IM node.exe >nul 2>nul

echo.
echo KOL Campaign OS has been stopped.
timeout /t 3 >nul
exit

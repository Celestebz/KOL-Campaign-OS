@echo off
rem Daily MySQL backup for KOL Campaign OS.
rem Dumps the database via the Docker container into backups\daily\ and keeps 14 days.

chcp 65001 >nul
cd /d "%~dp0\.."

if not exist backups\daily mkdir backups\daily

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%i"
set "OUT=backups\daily\kol-%STAMP%.sql"

docker exec kol-campaign-os-mysql mysqldump -ukol_user -pkol_password --single-transaction --databases kol_campaign_os > "%OUT%" 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] mysqldump failed. Is the MySQL container running?
    if exist "%OUT%" del "%OUT%"
    exit /b 1
)

rem Delete the file if the dump came out empty (e.g. wrong credentials).
for %%F in ("%OUT%") do if %%~zF lss 1024 (
    echo [ERROR] Backup file looks empty: %OUT%
    del "%OUT%"
    exit /b 1
)

echo [OK] Backup written to %OUT%

rem Keep only the last 14 days.
forfiles /p backups\daily /m kol-*.sql /d -14 /c "cmd /c del @path" 2>nul

exit /b 0

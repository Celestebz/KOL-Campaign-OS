@echo off
rem KOL Campaign OS background service launcher (installed edition).
rem Started by the "KOL-Campaign-OS" scheduled task at user logon via start-hidden.vbs.
rem Starts the bundled MariaDB (if not already running), then the Node server.
rem All output goes to logs\service-<date>.log. No interactive prompts here.

chcp 65001 >nul
cd /d "%~dp0\.."

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "STAMP=%%i"
set "LOG=logs\service-%STAMP%.log"

echo [%DATE% %TIME%] === KOL Campaign OS service starting === >> "%LOG%"

rem NOTE: do NOT set NODE_ENV=production here. server\database.js refuses to
rem auto-run pending migrations when NODE_ENV=production.

rem Load DB port chosen at install time (default 3306).
set "DB_PORT=3306"
for /f "tokens=2 delims==" %%i in ('findstr /B "DB_PORT=" .env 2^>nul') do set "DB_PORT=%%i"

rem 1. Start bundled MariaDB if its port is not already listening.
netstat -ano | findstr /C:":%DB_PORT% " | findstr /C:"LISTENING" >nul
if %errorlevel% equ 0 (
    echo [INFO] Port %DB_PORT% already listening; MariaDB assumed running. >> "%LOG%"
    goto MariaDBUp
)
if not exist "data\mariadb\mysql\user.frm" if not exist "data\mariadb\mysql\global_priv.MAD" (
    echo [INFO] Initializing MariaDB data directory... >> "%LOG%"
    "mariadb\bin\mariadb-install-db.exe" --datadir="%CD%\data\mariadb" >> "%LOG%" 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] mariadb-install-db failed. >> "%LOG%"
        exit /b 1
    )
)
echo [INFO] Starting bundled MariaDB on port %DB_PORT% ... >> "%LOG%"
start "" /min "mariadb\bin\mysqld.exe" --defaults-file="%CD%\data\my.ini"
:MariaDBUp

rem 2. Wait until MariaDB answers (max ~2 minutes).
set /a TRIES=0
:WaitMariaDB
"mariadb\bin\mariadb-admin.exe" --socket= --protocol=TCP -h127.0.0.1 -P%DB_PORT% -uroot ping >nul 2>nul
if %errorlevel% equ 0 goto MariaDBReady
set /a TRIES+=1
if %TRIES% geq 24 (
    echo [ERROR] MariaDB not ready after 2 minutes. >> "%LOG%"
    exit /b 1
)
timeout /t 5 /nobreak >nul
goto WaitMariaDB
:MariaDBReady
echo [INFO] MariaDB is ready. >> "%LOG%"

rem 3. Make sure app database and user exist (idempotent).
"mariadb\bin\mariadb.exe" --protocol=TCP -h127.0.0.1 -P%DB_PORT% -uroot < "scripts\init-db.sql" >> "%LOG%" 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] init-db.sql failed. >> "%LOG%"
    exit /b 1
)

rem 4. Avoid a duplicate app instance.
netstat -ano | findstr /C:":5001 " | findstr /C:"LISTENING" >nul
if %errorlevel% equ 0 (
    echo [INFO] Port 5001 is already listening; service already running. Exiting. >> "%LOG%"
    exit /b 0
)

rem 5. Start the Node server (blocks here; logon task keeps it alive in background).
echo [INFO] Launching node server\index.js ... >> "%LOG%"
"node\node.exe" server\index.js >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Server process exited with code %errorlevel%. >> "%LOG%"

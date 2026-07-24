@echo off
rem KOL Campaign OS background service launcher (production mode).
rem Started by the "KOL-Campaign-OS" scheduled task at user logon via start-hidden.vbs.
rem All output goes to logs\service-<date>.log. No interactive prompts here.

chcp 65001 >nul
cd /d "%~dp0\.."

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "STAMP=%%i"
set "LOG=logs\service-%STAMP%.log"

echo [%DATE% %TIME%] === KOL Campaign OS service starting === >> "%LOG%"

rem NOTE: do NOT set NODE_ENV=production here. server\database.js refuses to
rem auto-run pending migrations when NODE_ENV=production.

rem 0. Docker CLI present?
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] docker not found in PATH. Install Docker Desktop. >> "%LOG%"
    exit /b 1
)

rem 1. Wait for the Docker engine (Docker Desktop may still be booting after logon).
set /a DTRIES=0
:WaitDocker
docker info >nul 2>nul
if %errorlevel% equ 0 goto DockerReady
set /a DTRIES+=1
if %DTRIES% geq 36 (
    echo [ERROR] Docker engine not ready after 3 minutes. >> "%LOG%"
    exit /b 1
)
timeout /t 5 /nobreak >nul
goto WaitDocker
:DockerReady
echo [INFO] Docker engine is ready. >> "%LOG%"

rem 2. Start the MySQL container.
docker compose up -d mysql >> "%LOG%" 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] docker compose up -d mysql failed. >> "%LOG%"
    exit /b 1
)

rem 3. Wait until MySQL reports healthy (max ~2 minutes).
set /a TRIES=0
:WaitMySQL
docker inspect --format "{{.State.Health.Status}}" kol-campaign-os-mysql 2>nul | findstr /C:"healthy" >nul
if %errorlevel% equ 0 goto MySQLReady
set /a TRIES+=1
if %TRIES% geq 24 (
    echo [ERROR] MySQL container not healthy after 2 minutes. >> "%LOG%"
    exit /b 1
)
timeout /t 5 /nobreak >nul
goto WaitMySQL
:MySQLReady
echo [INFO] MySQL container is healthy. >> "%LOG%"

rem 4. Frontend build must exist (production mode serves client\build).
if not exist "client\build\index.html" (
    echo [ERROR] client\build\index.html missing. Run "npm run build" once, then restart. >> "%LOG%"
    exit /b 1
)

rem 5. Avoid a duplicate instance.
netstat -ano | findstr /C:":5001 " | findstr /C:"LISTENING" >nul
if %errorlevel% equ 0 (
    echo [INFO] Port 5001 is already listening; service already running. Exiting. >> "%LOG%"
    exit /b 0
)

rem 6. Start the server (blocks here; logon task keeps it alive in background).
echo [INFO] Launching node server\index.js ... >> "%LOG%"
node server\index.js >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Server process exited with code %errorlevel%. >> "%LOG%"

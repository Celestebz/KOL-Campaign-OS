@echo off
chcp 65001 >nul
title KOL Campaign OS

echo ==========================================
echo        Starting KOL Campaign OS...
echo ==========================================
echo.

cd /d "%~dp0"

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] npm was not found. Please install Node.js first.
    pause
    exit /b 1
)

if not exist "node_modules" goto :InstallDependencies
if not exist "server\node_modules" goto :InstallDependencies
if not exist "client\node_modules" goto :InstallDependencies

goto :StartService

:InstallDependencies
echo [INFO] Dependencies are missing. Installing packages...
echo.
call npm run install-all
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Dependency installation failed.
    pause
    exit /b %errorlevel%
)
echo.
echo [OK] Dependencies installed.
echo.

:StartDatabase
echo [INFO] Starting MySQL container (if not running)...
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Docker was not found. Please make sure MySQL is running on localhost:3306 manually.
    goto :StartService
)
docker compose up -d mysql
if %errorlevel% neq 0 (
    echo [WARN] Failed to start MySQL container. Please check Docker Desktop and ensure MySQL is running on localhost:3306.
    goto :StartService
)
echo [OK] MySQL container is ready.
echo.

:StartService
echo Frontend: http://localhost:3000
echo Backend:  http://localhost:5001
echo.
call npm run dev

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to start KOL Campaign OS.
    pause
)

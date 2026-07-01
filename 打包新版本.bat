@echo off
chcp 65001 >nul
title Build KOL Campaign OS

echo ==========================================
echo        Building KOL Campaign OS...
echo ==========================================
echo.

cd /d "%~dp0"

echo [1/4] Building frontend...
cd client
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed.
    pause
    exit /b %errorlevel%
)
cd ..

echo [2/4] Packaging backend...
call npx pkg server/index.js --targets node18-win-x64 --output dist/KOL-Campaign-OS.exe --config package.json
if %errorlevel% neq 0 (
    echo [ERROR] Backend package failed.
    pause
    exit /b %errorlevel%
)

echo [3/4] Copying frontend assets...
if exist "dist\client_build" rmdir /s /q "dist\client_build"
xcopy /E /I /Y "client\build" "dist\client_build"

if exist "server\node_modules\sqlite3\build\Release\node_sqlite3.node" (
    copy /Y "server\node_modules\sqlite3\build\Release\node_sqlite3.node" "dist\node_sqlite3.node"
)

echo [4/4] Creating zip package...
for /f "usebackq delims=" %%i in (`powershell -Command "Get-Date -Format 'yyMMdd'"`) do set DATE_TAG=%%i
set "ZIP_NAME=KOL-Campaign-OS_%DATE_TAG%.zip"

if exist "%ZIP_NAME%" del "%ZIP_NAME%"
powershell -Command "Compress-Archive -Path 'dist\*' -DestinationPath '%ZIP_NAME%' -Force"

echo.
echo Build complete: %ZIP_NAME%
echo.
pause

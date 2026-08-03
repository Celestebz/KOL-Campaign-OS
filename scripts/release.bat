@echo off
rem Build the installer from the current working tree and publish it to GitHub Releases.
rem Requires: gh CLI authenticated (gh auth login). Extra args are passed to gh release create.
rem Usage: scripts\release.bat [--notes "..."]
setlocal
cd /d "%~dp0\.."

for /f %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
echo [release] version: %VERSION%

call scripts\build-installer.bat
if errorlevel 1 (
    echo [release] build failed.
    exit /b 1
)

where gh >nul 2>nul
if errorlevel 1 (
    echo [release] gh CLI not found. Install https://cli.github.com/ and run: gh auth login
    echo [release] installer is ready at: dist\KOL-Campaign-OS-Setup-%VERSION%.exe
    exit /b 1
)

git tag "v%VERSION%" >nul 2>nul
gh release create "v%VERSION%" "dist\KOL-Campaign-OS-Setup-%VERSION%.exe" ^
    --title "KOL Campaign OS v%VERSION%" ^
    --notes "Windows 安装包。安装后浏览器打开 http://localhost:5001 即可使用，开机自动后台运行。卸载可在「设置 > 应用」中完成，可选保留数据。" %*
if errorlevel 1 (
    echo [release] release create failed ^(tag may already exist^). Trying upload --clobber ...
    gh release upload "v%VERSION%" "dist\KOL-Campaign-OS-Setup-%VERSION%.exe" --clobber
)

echo [release] done.

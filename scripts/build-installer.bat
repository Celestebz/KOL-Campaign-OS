@echo off
rem Builds dist\KOL-Campaign-OS-Setup-<version>.exe from the CURRENT working tree.
rem Make sure you are on the branch/commit you want to ship (e.g. latest main).
node "%~dp0build-installer.js" %*

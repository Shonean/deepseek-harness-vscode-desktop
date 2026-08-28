@echo off
setlocal
rem ============================================================
rem DeepSeek Harness - Windows portable packaging (electron-builder)
rem Run from a normal PowerShell / CMD where npm works normally.
rem Needs network once (installs electron-builder via npx).
rem ============================================================
cd /d "%~dp0.."

echo === DeepSeek Harness Windows packaging ===
echo.

rem --- Pre-flight: close running instances and stale output -----------------
rem A running app (or its kernel child / electron-builder helper) locks the
rem packaged node_modules and makes electron-builder fail with EBUSY/EPERM.
rem Kill them all, strip read-only attrs, and clear the old output with retries.
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>&1
taskkill /IM electron.exe /F >nul 2>&1
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM app-builder.exe /F >nul 2>&1
taskkill /IM 7za.exe /F >nul 2>&1
taskkill /IM signtool.exe /F >nul 2>&1
if exist "release" attrib -r "release\*.*" /s /d >nul 2>&1
if exist "release" rmdir /S /Q "release" >nul 2>&1
if exist "release" rmdir /S /Q "release" >nul 2>&1
if exist "release" (
  echo [pre-flight] WARNING: could not clear old release folder. Close any app
  echo              using it, or delete it manually, then retry.
) else (
  echo [pre-flight] closed running instances and cleared old release folder.
)

if not exist "dist\main.js" (
  echo ERROR: apps\desktop\dist is not built. Run first:
  echo   corepack pnpm --filter @deepseek-ai/dsh-desktop build
  exit /b 1
)
if not exist "media\logo.ico" (
  echo ERROR: media\logo.ico is missing.
  exit /b 1
)
if not exist "D:\electron\dist\electron.exe" (
  echo WARN: D:\electron\dist not found - electron-builder will download Electron.
  echo       If it is slow, set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
)

rem Use a clean npm cache so a previously corrupted cache cannot break the install.
set "npm_config_cache=%TEMP%\dsh-eb-cache"

echo [1/3] Installing electron-builder (npx, ~1-2 min)...
call npx --yes electron-builder@26.15.3 --config electron-builder.yml --win portable
if errorlevel 1 goto :fail

echo.
echo [2/3] Packaging finished.
echo.
echo ============================================================
echo DONE. Your app is:
echo   %CD%\release\DeepSeek-Harness-0.1.0-rc.0.exe
echo.
echo Copy it to your Desktop and double-click to run.
echo (Single self-contained exe, official DeepSeek Harness icon embedded.)
echo ============================================================
endlocal
exit /b 0

:fail
echo.
echo Packaging FAILED. Common fixes:
echo  1. npm config get registry   (should be https://registry.npmmirror.com)
echo  2. Delete %TEMP%\dsh-eb-cache and retry
echo  3. Ensure pnpm is on PATH:   D:\npm-global
echo     (electron-builder reads the workspace via "pnpm list --json")
echo  4. Run with the log visible: call npx electron-builder ... --win portable
exit /b 1

@echo off
REM ===========================================================================
REM  WeldView 3D Studio - 一键构建
REM  用法：scripts\build.bat            构建 exe + 安装包
REM        scripts\build.bat exe        仅构建 exe
REM ===========================================================================
setlocal
cd /d "%~dp0.."

if /i "%~1"=="exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build.ps1" -SkipInstaller
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build.ps1"
)

set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
    echo.
    echo [失败] 构建未通过，退出码 %RC%
)
pause
exit /b %RC%

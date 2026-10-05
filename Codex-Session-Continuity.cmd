@echo off
setlocal
set "CONTINUITY_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%CONTINUITY_PWSH%" (
  where pwsh.exe >nul 2>nul
  if errorlevel 1 (
    echo PowerShell 7 is required. See README.md.
    pause
    exit /b 1
  )
  set "CONTINUITY_PWSH=pwsh.exe"
)
"%CONTINUITY_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manual-switch.ps1" %*
set "CONTINUITY_EXIT=%ERRORLEVEL%"
if not "%CONTINUITY_EXIT%"=="0" pause
exit /b %CONTINUITY_EXIT%

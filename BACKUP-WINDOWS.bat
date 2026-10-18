@echo off
title ShalaSign Backup
REM Makes a dated backup of ALL your ShalaSign data onto your Desktop.
set DATA=%USERPROFILE%\ShalaSignData
for /f %%i in ('powershell -command "Get-Date -Format yyyy-MM-dd_HHmm"') do set STAMP=%%i
set DEST=%USERPROFILE%\Desktop\ShalaSign-backup-%STAMP%.zip

if not exist "%DATA%" (
  echo No data folder found yet at %DATA% - run the app at least once first.
  pause
  exit /b
)

powershell -command "Compress-Archive -Path '%DATA%' -DestinationPath '%DEST%' -Force"
echo Backup saved to: %DEST%
echo Keep a copy somewhere safe (another drive, Google Drive, etc.).
pause

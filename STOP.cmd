@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0scripts\stop-background.ps1"
pause

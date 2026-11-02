@echo off
cd /d "%~dp0"
node --env-file-if-exists=.env "%~dp0scripts\background.mjs"
pause

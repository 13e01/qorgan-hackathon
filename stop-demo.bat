@echo off
rem QORGAN: stops the sensor, server and broker windows started from THIS folder
rem (by start-demo.bat or by double-clicking start-sensor/start-qorgan/start-broker.bat).
rem Other programs and "npm run dev" typed by hand are not touched.
rem Data is already saved in the database; the website will show the sensor as offline.
rem ASCII only and CRLF line endings on purpose: cmd.exe misreads UTF-8 text in .bat files.
setlocal EnableExtensions
cd /d "%~dp0"
echo This stops the QORGAN demo: sensor, server, broker.
echo Data is kept in the database.
echo Press any key to continue, or close this window to cancel.
pause >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-demo.ps1" -Root "%~dp0."
if errorlevel 1 echo Could not stop everything - close the remaining windows by hand.
echo.
echo Done.
pause
exit /b 0

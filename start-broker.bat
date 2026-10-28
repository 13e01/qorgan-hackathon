@echo off
rem QORGAN: local MQTT broker (listens only on this computer, 127.0.0.1).
rem ASCII only and CRLF line endings on purpose: cmd.exe misreads UTF-8 text in .bat files.
rem Stop: Ctrl+C in this window, then Y. Or just close the window.
setlocal EnableExtensions
title QORGAN-broker
cd /d "%~dp0"

echo ==================================================================
echo  QORGAN - MQTT broker for the Python sensor
echo  Stop: press Ctrl+C in this window, then Y.
echo ==================================================================

call :read_env MQTT_PORT 1883
set "MPORT=%ENV_VALUE%"

echo [1/4] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 goto no_node
where npm >nul 2>nul
if errorlevel 1 goto no_node

echo [2/4] Checking that the broker is not already running on port %MPORT%...
call :port_busy %MPORT%
if "%PORT_BUSY%"=="1" goto already_running

echo [3/4] Checking dependencies...
if exist "node_modules\aedes\" goto deps_ok
echo       First start: installing dependencies with npm install - needs internet.
call npm install
if errorlevel 1 goto fail_install
:deps_ok

echo [4/4] Preparing settings file .env...
call npm run setup
if errorlevel 1 goto fail_setup

echo.
echo Broker is starting on 127.0.0.1:%MPORT%. Keep this window open during the demo.
call npm run mqtt:broker
echo.
echo MQTT broker has stopped.
pause
exit /b 0

:already_running
echo.
echo Port %MPORT% is already in use - most likely the QORGAN broker is ALREADY RUNNING
echo in another window. A second copy is not started. Nothing else to do here.
pause
exit /b 0

:no_node
echo.
echo ERROR: Node.js was not found.
echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
pause
exit /b 1

:fail_install
echo.
echo ERROR: npm install failed. Check the internet connection and run this file again.
pause
exit /b 1

:fail_setup
echo.
echo ERROR: could not prepare the .env settings file. See the message above.
pause
exit /b 1

rem ---- helpers ----------------------------------------------------------------
:read_env
set "ENV_VALUE=%~2"
if not exist ".env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="%~1" set "ENV_VALUE=%%B"
exit /b 0

:port_busy
set "PORT_BUSY=0"
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul 2>nul
if not errorlevel 1 set "PORT_BUSY=1"
exit /b 0

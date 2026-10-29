@echo off
rem QORGAN: one-click demo launcher.
rem Checks everything, then opens three windows (broker, server, sensor) and the website.
rem Each window stops on its own: Ctrl+C then Y, or Q + Enter in the sensor window.
rem stop-demo.bat closes all three windows at once.
rem ASCII only and CRLF line endings on purpose: cmd.exe misreads UTF-8 text in .bat files.
setlocal EnableExtensions
title QORGAN-launcher
cd /d "%~dp0"

echo ==================================================================
echo  QORGAN - one-click demo launcher
echo ==================================================================
echo.

echo [1/7] Node.js...
where node >nul 2>nul
if errorlevel 1 goto no_node
where npm >nul 2>nul
if errorlevel 1 goto no_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto old_node
echo       OK

echo [2/7] Dependencies...
if not exist "node_modules\fastify\" goto install
if not exist "node_modules\aedes\" goto install
goto deps_ok
:install
echo       First start: npm install - needs internet, takes a few minutes.
call npm install
if errorlevel 1 goto fail
:deps_ok
echo       OK

echo [3/7] Settings file .env...
call npm run setup >nul
if errorlevel 1 goto fail
echo       OK
call :read_env PORT 3000
set "QPORT=%ENV_VALUE%"
call :read_env MQTT_PORT 1883
set "MPORT=%ENV_VALUE%"

echo [4/7] Python sensor environment...
call "%~dp0start-sensor.bat" PREPARE
if errorlevel 1 goto fail

echo [5/7] QORGAN server on port %QPORT%...
set "REUSED=0"
call :port_busy %QPORT%
if "%PORT_BUSY%"=="1" goto server_running
start "QORGAN-server" cmd /c call "%~dp0start-qorgan.bat"
echo       started in a new window: QORGAN-server. The build takes up to a minute...
goto server_wait
:server_running
set "REUSED=1"
echo       port %QPORT% is busy - checking that it is QORGAN, a second copy is not started
:server_wait
set /a WAITED=0
:server_loop
curl.exe -fs "http://127.0.0.1:%QPORT%/api/health" >nul 2>nul
if not errorlevel 1 goto server_ready
set /a WAITED+=2
if %WAITED% GEQ 240 goto server_timeout
ping -n 3 127.0.0.1 >nul
goto server_loop
:server_ready
if not "%REUSED%"=="1" goto server_ok
call :same_build %QPORT%
if "%BUILD_OK%"=="0" goto server_stale
:server_ok
echo       OK - QORGAN answers on http://localhost:%QPORT%/

echo [6/7] MQTT broker on port %MPORT%...
call :port_busy %MPORT%
if "%PORT_BUSY%"=="1" goto broker_ready
start "QORGAN-broker" cmd /c call "%~dp0start-broker.bat"
echo       started in a new window: QORGAN-broker
set /a WAITED=0
:broker_loop
call :port_busy %MPORT%
if "%PORT_BUSY%"=="1" goto broker_ready
set /a WAITED+=2
if %WAITED% GEQ 120 goto broker_timeout
ping -n 3 127.0.0.1 >nul
goto broker_loop
:broker_ready
echo       OK - broker listens on 127.0.0.1:%MPORT%

echo [7/7] Python sensor...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-demo.ps1" -Root "%~dp0." -Check sensor
if not errorlevel 1 goto sensor_running
start "QORGAN-sensor" cmd /c call "%~dp0start-sensor.bat"
echo       started in a new window: QORGAN-sensor
goto sensor_done
:sensor_running
echo       already running - not started again
:sensor_done

start "" "http://localhost:%QPORT%/#/simulator"
echo.
echo ==================================================================
echo  READY. The website is open: http://localhost:%QPORT%/#/simulator
echo.
echo  1. Sign in as operator. Login and password are in the .env file:
echo     SEED_OPERATOR_USERNAME and SEED_OPERATOR_PASSWORD.
echo  2. In the block "Prepare a clean demo" press "Start a new clean run".
echo  3. In the QORGAN-sensor window type D and press Enter: danger rise.
echo.
echo  Stop everything: run stop-demo.bat, or close the three windows.
echo ==================================================================
pause
exit /b 0

:server_stale
echo.
echo ERROR: port %QPORT% is used by a QORGAN copy that serves a DIFFERENT website build.
echo It was started from another folder, or it is an old server that kept an older build.
echo The browser would show a black screen.
echo Stop that copy: run stop-demo.bat in its folder, or close the window where
echo "npm run dev" or "npm start" is running. Then run this file again.
pause
exit /b 1

:server_timeout
echo.
echo ERROR: QORGAN did not answer within 4 minutes.
echo Look at the QORGAN-server window - the reason is written there.
pause
exit /b 1

:broker_timeout
echo.
echo ERROR: the MQTT broker did not start within 2 minutes.
echo Look at the QORGAN-broker window - the reason is written there.
pause
exit /b 1

:no_node
echo.
echo ERROR: Node.js was not found. Install Node.js 24 LTS from https://nodejs.org/ and run again.
pause
exit /b 1

:old_node
echo.
echo ERROR: Node.js is too old. QORGAN needs Node.js 24 or newer - https://nodejs.org/
node --version
pause
exit /b 1

:fail
echo.
echo ERROR: preparation failed - see the message above. Fix it and run start-demo.bat again.
pause
exit /b 1

rem ---- helpers ----------------------------------------------------------------
:read_env
set "ENV_VALUE=%~2"
if not exist ".env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="%~1" set "ENV_VALUE=%%B"
exit /b 0

rem :same_build PORT  - BUILD_OK=0 if the server on PORT serves a different index.html than apps\web\dist of THIS folder
rem (a copy from another folder, or an old server that remembered an older build). The browser would show a black screen.
:same_build
set "BUILD_OK=1"
if not exist "apps\web\dist\index.html" exit /b 0
curl.exe -fs "http://127.0.0.1:%~1/" -o "%TEMP%\qorgan-served-index.html" >nul 2>nul
if errorlevel 1 exit /b 0
fc /b "%TEMP%\qorgan-served-index.html" "apps\web\dist\index.html" >nul 2>nul
if errorlevel 1 set "BUILD_OK=0"
exit /b 0

:port_busy
set "PORT_BUSY=0"
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul 2>nul
if not errorlevel 1 set "PORT_BUSY=1"
exit /b 0

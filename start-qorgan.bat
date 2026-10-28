@echo off
rem QORGAN: server + website on http://localhost:3000 (production build).
rem ASCII only and CRLF line endings on purpose: cmd.exe misreads UTF-8 text in .bat files.
rem Stop: Ctrl+C in this window, then Y. Or just close the window.
setlocal EnableExtensions
title QORGAN-server
cd /d "%~dp0"

echo ==================================================================
echo  QORGAN - server and website
echo  Stop: press Ctrl+C in this window, then Y.
echo ==================================================================

call :read_env PORT 3000
set "QPORT=%ENV_VALUE%"

echo [1/5] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 goto no_node
where npm >nul 2>nul
if errorlevel 1 goto no_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto old_node

echo [2/5] Checking that QORGAN is not already running on port %QPORT%...
call :port_busy %QPORT%
if "%PORT_BUSY%"=="1" goto already_running

echo [3/5] Checking dependencies...
if exist "node_modules\fastify\" goto deps_ok
echo       First start: installing dependencies with npm install - needs internet, takes a few minutes.
call npm install
if errorlevel 1 goto fail_install
:deps_ok

echo [4/5] Preparing settings file .env...
call npm run setup
if errorlevel 1 goto fail_setup

echo [5/5] Building the website...
call npm run build
if errorlevel 1 goto fail_build

echo.
echo ==================================================================
echo  QORGAN is starting. Open in the browser: http://localhost:%QPORT%
echo  Stop: press Ctrl+C in this window, then Y.
echo ==================================================================
call npm start
echo.
echo QORGAN server has stopped.
pause
exit /b 0

:already_running
curl.exe -fs "http://127.0.0.1:%QPORT%/api/health" >nul 2>nul
if errorlevel 1 goto port_taken
echo.
echo QORGAN is ALREADY RUNNING on port %QPORT% - a second copy is not started.
rem The production server also serves the website; under "npm run dev" it is served by Vite on 5173.
curl.exe -fs "http://127.0.0.1:%QPORT%/" >nul 2>nul
if errorlevel 1 goto already_dev
echo Opening http://localhost:%QPORT%/ in the browser.
start "" "http://localhost:%QPORT%/"
pause
exit /b 0

:already_dev
echo It was started with "npm run dev": the website is http://localhost:5173/
start "" "http://localhost:5173/"
pause
exit /b 0

:port_taken
echo.
echo ERROR: port %QPORT% is used by another program, not by QORGAN.
echo Close that program, or change PORT in the .env file, then run this file again.
pause
exit /b 1

:no_node
echo.
echo ERROR: Node.js was not found.
echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
pause
exit /b 1

:old_node
echo.
echo ERROR: Node.js is too old. QORGAN needs Node.js 24 or newer - https://nodejs.org/
node --version
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

:fail_build
echo.
echo ERROR: the website build failed. See the message above.
pause
exit /b 1

rem ---- helpers ----------------------------------------------------------------
rem :read_env KEY DEFAULT  - value of KEY from .env (or DEFAULT) into ENV_VALUE
:read_env
set "ENV_VALUE=%~2"
if not exist ".env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="%~1" set "ENV_VALUE=%%B"
exit /b 0

rem :port_busy PORT  - PORT_BUSY=1 if a program listens on PORT
:port_busy
set "PORT_BUSY=0"
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul 2>nul
if not errorlevel 1 set "PORT_BUSY=1"
exit /b 0

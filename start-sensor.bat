@echo off
rem QORGAN: Python water level sensor, sends readings over MQTT.
rem Usage:  start-sensor.bat            start in NORMAL mode
rem         start-sensor.bat DANGER     modes: NORMAL, RISING, DANGER, FALLING
rem         start-sensor.bat PREPARE    only prepare the Python environment and exit
rem ASCII only and CRLF line endings on purpose: cmd.exe misreads UTF-8 text in .bat files.
rem Stop: type Q and press Enter (or Ctrl+C, then Y).
setlocal EnableExtensions
cd /d "%~dp0"

set "VENV_PY=sensors\python\.venv\Scripts\python.exe"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=NORMAL"
if /i "%MODE%"=="NORMAL" goto mode_ok
if /i "%MODE%"=="RISING" goto mode_ok
if /i "%MODE%"=="DANGER" goto mode_ok
if /i "%MODE%"=="FALLING" goto mode_ok
if /i "%MODE%"=="PREPARE" goto mode_ok
echo ERROR: unknown mode "%MODE%". Use NORMAL, RISING, DANGER or FALLING.
pause
exit /b 1
:mode_ok

echo [1/3] Checking Python environment...
if exist "%VENV_PY%" goto venv_ok
set "PYEXE="
where py >nul 2>nul
if not errorlevel 1 set "PYEXE=py -3"
if defined PYEXE goto have_python
where python >nul 2>nul
if not errorlevel 1 set "PYEXE=python"
if not defined PYEXE goto no_python
:have_python
echo       First start: creating Python environment and installing paho-mqtt - needs internet, once.
%PYEXE% -m venv sensors\python\.venv
if errorlevel 1 goto fail_venv
"%VENV_PY%" -m pip install --disable-pip-version-check -r sensors\python\requirements.txt
if errorlevel 1 goto fail_venv
:venv_ok
"%VENV_PY%" -c "import paho.mqtt.client" >nul 2>nul
if not errorlevel 1 goto paho_ok
echo       Installing paho-mqtt into the Python environment - needs internet...
"%VENV_PY%" -m pip install --disable-pip-version-check -r sensors\python\requirements.txt
if errorlevel 1 goto fail_venv
:paho_ok
if /i "%MODE%"=="PREPARE" goto prepared

title QORGAN-sensor
echo [2/3] Checking settings file .env...
if not exist ".env" goto no_env

echo [3/3] Starting the sensor in %MODE% mode...
echo       Keys in this window: N normal, R rising, D danger, F falling, Q quit - letter, then Enter.
echo.
"%VENV_PY%" sensors\python\sensor.py --mode %MODE%
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" echo Sensor stopped.
if "%CODE%"=="3" echo The sensor is ALREADY RUNNING in another window - use that window.
if not "%CODE%"=="0" if not "%CODE%"=="3" echo Sensor finished with an error, code %CODE%. See the messages above.
pause
exit /b %CODE%

:prepared
echo       Python environment is ready.
exit /b 0

:no_python
echo.
echo ERROR: Python was not found.
echo Install Python 3 from https://www.python.org/downloads/
echo During installation tick "Add python.exe to PATH". Then run this file again.
pause
exit /b 1

:fail_venv
echo.
echo ERROR: could not prepare the Python environment. Check the internet connection and run again.
echo If it keeps failing, delete the folder sensors\python\.venv and run this file again.
pause
exit /b 1

:no_env
echo.
echo ERROR: settings file .env is missing. Run start-qorgan.bat first - it creates .env.
pause
exit /b 1

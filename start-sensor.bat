@echo off
rem QORGAN: запуск программного датчика уровня воды (Python, MQTT).
rem Использование: start-sensor.bat            (режим NORMAL)
rem                start-sensor.bat DANGER     (режимы: NORMAL, RISING, DANGER, FALLING)
chcp 65001 >nul
cd /d "%~dp0"

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE (
  where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
  echo.
  echo Python не найден.
  echo Установите Python 3 с https://www.python.org/downloads/ ^(при установке отметьте "Add python.exe to PATH"^),
  echo затем снова запустите start-sensor.bat.
  pause
  exit /b 1
)

if not exist "sensors\python\.venv\Scripts\python.exe" (
  echo Первый запуск: создаю окружение Python и устанавливаю библиотеку paho-mqtt ^(нужен интернет, один раз^)...
  %PYEXE% -m venv sensors\python\.venv
  if errorlevel 1 goto fail
  "sensors\python\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r sensors\python\requirements.txt
  if errorlevel 1 goto fail
)

if not exist ".env" (
  echo Нет файла настроек .env. Сначала выполните: npm run setup  ^(или запустите start-qorgan.bat^)
  pause
  exit /b 1
)

set "MODE=%~1"
if "%MODE%"=="" set "MODE=NORMAL"
"sensors\python\.venv\Scripts\python.exe" sensors\python\sensor.py --mode %MODE%
pause
exit /b 0

:fail
echo.
echo Не удалось подготовить окружение Python. Проверьте подключение к интернету и запустите снова.
pause
exit /b 1

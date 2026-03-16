@echo off
echo ============================================
echo   VideoDown - Instalacion
echo ============================================
echo.

REM Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado.
    echo Descargalo en: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js encontrado

REM Check yt-dlp
yt-dlp --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [INFO] yt-dlp no encontrado. Intentando instalar con pip...
    pip install yt-dlp >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] No se pudo instalar yt-dlp automaticamente.
        echo Por favor instala manualmente:
        echo   1. pip install yt-dlp
        echo   o
        echo   2. Descarga yt-dlp.exe de https://github.com/yt-dlp/yt-dlp/releases
        echo      y ponlo en la misma carpeta que este proyecto.
        pause
        exit /b 1
    )
)
echo [OK] yt-dlp encontrado

REM Check ffmpeg
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [AVISO] ffmpeg no encontrado. Se recomienda para mezclar audio+video.
    echo Descargalo en: https://ffmpeg.org/download.html
    echo y agrega la carpeta bin a tu PATH.
    echo (Puedes continuar sin el, pero algunas calidades pueden fallar)
    echo.
)

echo.
echo Instalando dependencias npm...
npm install
if %errorlevel% neq 0 (
    echo [ERROR] Fallo npm install
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Instalacion completada!
echo   Ejecuta: iniciar.bat
echo ============================================
pause

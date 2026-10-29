@echo off
cd /d "C:\path\to\Downloader\server"
set ALLOWED_ORIGIN=https://your-project.vercel.app
:loop
node server.js
timeout /t 5
goto loop

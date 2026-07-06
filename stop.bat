@echo off
echo Stopping IPTV Web Player Server on port 8080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)
echo IPTV Web Player Server stopped.
pause

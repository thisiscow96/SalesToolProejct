@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Removing postgresql_18.exe from Git history...
git filter-branch --force --index-filter "git rm --cached --ignore-unmatch postgresql_18.exe" --prune-empty HEAD

if %ERRORLEVEL% equ 0 (
    echo.
    echo Done. Now run: git push --force
) else (
    echo Filter-branch failed. Try: git filter-branch --force --index-filter "git rm -rf --cached --ignore-unmatch postgresql_18.exe" --prune-empty HEAD
)
pause

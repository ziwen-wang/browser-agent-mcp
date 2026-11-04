@echo off
setlocal
cd /d "%~dp0"

chcp 65001 >nul
echo ========================================
echo  Browser Agent MCP ^| Pairing setup
echo ========================================
echo First load the extension folder in Chrome or Edge.
echo Copy its ID from chrome://extensions or edge://extensions.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or later, then try again.
  pause
  exit /b 1
)

node "mcp-server\setup.mjs"
if errorlevel 1 (
  echo.
  echo The setup wizard could not finish. Review the error above and try again.
  pause
  exit /b 1
)

echo.
echo Installing Browser Agent skill for Codex...
node "mcp-server\install-skill.mjs"
if errorlevel 1 echo Skill was not installed. You can retry with: node mcp-server\install-skill.mjs

echo.
echo ========================================
echo  Next
echo ========================================
echo 1. Paste the pairing token above into the extension Settings and save.
echo 2. Restart or reload the MCP Host you selected. Restart Codex to load the skill.
echo 3. Return to the browser, confirm it is connected, and authorize the current site.
echo.
pause

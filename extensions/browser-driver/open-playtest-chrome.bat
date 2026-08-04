@echo off
REM Launches a separate, debuggable Chrome window (its own fresh profile, not your normal
REM Chrome profile/history/logins) with the Playtest Table file already open. Claude's driver
REM attaches to this exact window over the debug port, so clicks from both of you land on the
REM same live page. Leave this window open for the whole session.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%~dp0.chrome-profile" ^
  --no-first-run --no-default-browser-check ^
  "file:///C:/Users/djaenike/OneDrive%%20-%%20Archaea%%20Energy/Desktop/Claude%%20Projects/scryfall-mcp/extensions/playtest-table.html"

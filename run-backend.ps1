# Starts the MyDJ backend and KEEPS IT RUNNING. Leave this window open during your
# party — the app talks to it for downloads/analysis. Loads backend\.env automatically
# (so ANTHROPIC_API_KEY for AI Polish is picked up without setting it here).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$py = Join-Path $root "backend\venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Host "venv not found at $py — see README setup." -ForegroundColor Red; exit 1 }
Write-Host "MyDJ backend -> http://localhost:8000   (keep this window open; Ctrl+C to stop)" -ForegroundColor Cyan
# --host 0.0.0.0: reachable from phones on the same Wi-Fi (party session).
& $py -m uvicorn main:app --app-dir (Join-Path $root "backend") --host 0.0.0.0 --port 8000

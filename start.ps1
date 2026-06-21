# One-shot launcher: opens the backend in its OWN window (so it stays up independently
# of anything else) and runs the frontend dev server here. Run from the project root:
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
$root = $PSScriptRoot
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$root\run-backend.ps1`""
Start-Sleep -Seconds 2
Write-Host "Frontend -> http://localhost:5173" -ForegroundColor Cyan
npm run dev --prefix (Join-Path $root "frontend")

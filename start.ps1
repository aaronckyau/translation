$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '請先在開發主機安裝 Node.js 22.12 或以上。' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw '套件安裝失敗。' } }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env.local'))) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination (Join-Path $PSScriptRoot '.env.local'); Write-Host '已建立 .env.local。請填寫 GEMINI_API_KEY 後重新啟動。' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '建置失敗。' }
& npm.cmd start

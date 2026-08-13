param(
    [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutputRoot = Join-Path $ProjectRoot $OutputDirectory
$Version = (Get-Content (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json).version
$Archive = Join-Path $OutputRoot "kol-campaign-os-linux-$Version.tar.gz"

Push-Location $ProjectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    if (Test-Path $Archive) { Remove-Item -LiteralPath $Archive }

    tar.exe -czf $Archive `
        --exclude=server/node_modules `
        --exclude=server/coverage `
        --exclude=server/scratch_*.js `
        server client/build skills deploy package.json
    if ($LASTEXITCODE -ne 0) { throw "Release archive creation failed." }

    Write-Host "Created $Archive"
} finally {
    Pop-Location
}

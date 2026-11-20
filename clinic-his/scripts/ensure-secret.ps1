# Ensure a stable CLINIC_DOC_SECRET for local development.
# The secret is stored in clinic-his/data/.doc_secret (data/ is gitignored).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
$secretPath = Join-Path $dataDir ".doc_secret"

if (Test-Path -LiteralPath $secretPath) {
    exit 0
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$hex = -join ($bytes | ForEach-Object { $_.ToString("x2") })
[System.IO.File]::WriteAllText($secretPath, $hex, (New-Object System.Text.UTF8Encoding($false)))
exit 0

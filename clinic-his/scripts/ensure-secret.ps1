# Ensure stable local secrets for development.
# Secrets are stored in clinic-his/data/ (data/ is gitignored).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
$docSecretPath = Join-Path $dataDir ".doc_secret"
$patientSaltPath = Join-Path $dataDir ".patient_hash_salt"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function New-HexSecret([string]$secretPath) {
    if (Test-Path -LiteralPath $secretPath) {
        return
    }
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $hex = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    [System.IO.File]::WriteAllText($secretPath, $hex, (New-Object System.Text.UTF8Encoding($false)))
}

New-HexSecret $docSecretPath
New-HexSecret $patientSaltPath
exit 0

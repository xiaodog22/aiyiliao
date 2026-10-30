# ensure-utf8bom.ps1 - keep deploy scripts UTF-8 WITH BOM (this file is pure ASCII on purpose)
# Why: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI (GBK on this box).
# Chinese chars then get split into stray quotes and the whole script fails with
# ParserError before a single line runs. Fixing the BOM is not enough long term
# (an editor may strip it again), so every .bat calls this first.
param([string]$Dir)

if (-not $Dir) { exit 0 }

$targets = @('orchestrator.ps1', 'deploy-common.ps1', 'gui.ps1')
foreach ($n in $targets) {
    $p = Join-Path $Dir $n
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $b = [System.IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { continue }
    $o = New-Object 'byte[]' ($b.Length + 3)
    $o[0] = 0xEF
    $o[1] = 0xBB
    $o[2] = 0xBF
    [Array]::Copy($b, 0, $o, 3, $b.Length)
    [System.IO.File]::WriteAllBytes($p, $o)
    Write-Host ('[bom] repaired: ' + $n)
}
exit 0

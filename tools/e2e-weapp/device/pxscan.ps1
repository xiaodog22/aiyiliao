# pxscan.ps1 —— 按颜色扫描截图里的横向色带，输出设备像素坐标（用于精确定位点击目标）
#
# 为什么需要它：小程序页面在 uiautomator 里只是一个 FrameLayout（无节点树），
# 只能按坐标点。而截图是 1080x2400、看图器会缩放，肉眼量的坐标必然带换算误差
# （D-20「热区偏下 46px」就是这么来的）。这里直接从像素算，绕开肉眼。
#
# 用法：
#   powershell -File pxscan.ps1 -Image <png> -X0 100 -X1 200 -Mode blue [-Step 2]
# 输出：每行一段 "band  y0-y1  center=<cy>  px=<命中数>"
param(
  [Parameter(Mandatory=$true)][string]$Image,
  [int]$X0 = 100,
  [int]$X1 = 200,
  [ValidateSet('blue','green','red','dark','white')][string]$Mode = 'blue',
  [int]$Step = 2,
  [int]$MinPx = 6
)

Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Image).Path)
$h = $bmp.Height
$rows = New-Object 'int[]' $h

for ($y = 0; $y -lt $h; $y++) {
  $hit = 0
  for ($x = $X0; $x -lt $X1; $x += $Step) {
    $c = $bmp.GetPixel($x, $y)
    switch ($Mode) {
      'blue'  { if ($c.B -gt 150 -and $c.R -lt 130 -and $c.G -lt 170 -and ($c.B - $c.R) -gt 60) { $hit++ } }
      'green' { if ($c.G -gt 140 -and $c.R -lt 140 -and ($c.G - $c.B) -gt 30) { $hit++ } }
      'red'   { if ($c.R -gt 150 -and $c.G -lt 120 -and $c.B -lt 120) { $hit++ } }
      'dark'  { if ($c.R -lt 90 -and $c.G -lt 90 -and $c.B -lt 90) { $hit++ } }
      'white' { if ($c.R -gt 225 -and $c.G -gt 225 -and $c.B -gt 225) { $hit++ } }
    }
    if ($hit -ge $MinPx) { break }
  }
  $rows[$y] = $hit
}
$bmp.Dispose()

# 合并连续命中行为色带
$start = -1
for ($y = 0; $y -le $h; $y++) {
  $on = ($y -lt $h) -and ($rows[$y] -ge $MinPx)
  if ($on -and $start -lt 0) { $start = $y }
  elseif (-not $on -and $start -ge 0) {
    $cy = [int](($start + $y - 1) / 2)
    Write-Output ("band  {0}-{1}  center={2}  h={3}" -f $start, ($y - 1), $cy, ($y - $start))
    $start = -1
  }
}

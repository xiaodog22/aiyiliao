# ocr.ps1 —— 用 Windows 内置 OCR 读截图文字，输出设备像素坐标（供点击定位）
#
# 为什么要它：小程序页面在 uiautomator 里没有节点树，看图的缩放比例每次还不一样
# （实测同一张 1080x2400 截图，在某次渲染里 1 单位≈2.08 设备像素，另一次≈2.25），
# 所以肉眼量的坐标会系统性偏移。这里让 OCR 直接在原始像素上给框。
#
# 用法：
#   powershell -File ocr.ps1 -Image <png> [-Filter 隐私]
# 输出：每行 "text  center=(cx,cy)  box=(x,y,w,h)"
param(
  [Parameter(Mandatory=$true)][string]$Image,
  [string]$Filter = ''
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT IAsyncOperation -> Task
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$path = (Resolve-Path $Image).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language 'zh-Hans'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { Write-Error 'OCR 引擎不可用（缺中文语言包）'; exit 2 }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

foreach ($line in $result.Lines) {
  foreach ($w in $line.Words) {
    if ($Filter -and $w.Text -notlike "*$Filter*") { continue }
    $r = $w.BoundingRect
    $cx = [int]($r.X + $r.Width / 2)
    $cy = [int]($r.Y + $r.Height / 2)
    Write-Output ("{0}`tcenter=({1},{2})`tbox=({3},{4},{5},{6})" -f $w.Text, $cx, $cy, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
  }
}
$stream.Dispose()

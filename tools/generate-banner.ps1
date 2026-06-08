# Generates assets/banner.png — a gradient hero banner for the README.
# Uses .NET System.Drawing (Windows PowerShell 5.1).
Add-Type -AssemblyName System.Drawing

$root      = Split-Path -Parent $PSScriptRoot
$assetsDir = Join-Path $root 'assets'
if (-not (Test-Path $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir | Out-Null }

$W = 1280; $H = 360; $R = 30

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x,           $y,           $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y,           $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d,   0, 90)
    $p.AddArc($x,           $y + $h - $d, $d, $d,  90, 90)
    $p.CloseFigure()
    return $p
}

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded gradient background.
$bgPath = New-RoundedPath 0 0 $W $H $R
$rect   = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$c1     = [System.Drawing.Color]::FromArgb(255, 124, 92, 255)   # #7C5CFF
$c2     = [System.Drawing.Color]::FromArgb(255, 58, 160, 255)   # #3AA0FF
$brush  = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 25)
$g.FillPath($brush, $bgPath)

# Clip everything else to the rounded card.
$g.SetClip($bgPath)

# Soft translucent orbs for depth.
function Fill-Circle([int]$cx, [int]$cy, [int]$r, [int]$a) {
    $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, 255, 255, 255))
    $g.FillEllipse($b, ($cx - $r), ($cy - $r), ($r * 2), ($r * 2)); $b.Dispose()
}
Fill-Circle 1120 70 170 28
Fill-Circle 980 320 120 22
Fill-Circle 120 300 90 16

# Equalizer bars across the bottom (decorative).
$barBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(45, 255, 255, 255))
for ($i = 0; $i -lt 64; $i++) {
    $x = 12 + $i * 20
    $hgt = 26 + [Math]::Abs([Math]::Sin($i * 0.45) * 78) + [Math]::Abs([Math]::Sin($i * 0.17) * 26)
    $g.FillRectangle($barBrush, $x, ($H - $hgt - 8), 11, $hgt)
}
$barBrush.Dispose()

# Speaker glyph (white) on the left.
$ox = 92; $oy = 150; $scale = 1.55
function P([float]$x, [float]$y) { New-Object System.Drawing.PointF(($ox + $x * $scale), ($oy + $y * $scale)) }
$white = [System.Drawing.Brushes]::White
$pts = @((P 0 24), (P 22 24), (P 46 4), (P 46 64), (P 22 44), (P 0 44))
$g.FillPolygon($white, $pts)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White, 9)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
foreach ($rr in 18, 31, 44) {
    $g.DrawArc($pen, ($ox + (46 - $rr) * $scale), ($oy + (34 - $rr) * $scale), ($rr * 2 * $scale), ($rr * 2 * $scale), -42, 84)
}
$pen.Dispose()

# Text with soft shadow.
function Draw-Text([string]$text, [single]$size, [System.Drawing.FontStyle]$style, [int]$x, [int]$y) {
    $font  = New-Object System.Drawing.Font("Segoe UI", $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 0, 0, 20))
    $g.DrawString($text, $font, $shadow, ($x + 2), ($y + 2))
    $g.DrawString($text, $font, [System.Drawing.Brushes]::White, $x, $y)
    $font.Dispose(); $shadow.Dispose()
}

Draw-Text "Ultimate Media Controller" 52 ([System.Drawing.FontStyle]::Bold) 290 96
$sub = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
$subFont = New-Object System.Drawing.Font("Segoe UI", 23, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Volume Boost   |   Playback Speed   |   Bass / Mid / Treble EQ", $subFont, $sub, 292, 168)
$g.DrawString("Boost to 600%    -    0.1x to 16x speed    -    works on ANY website", $subFont, $sub, 292, 206)
$subFont.Dispose(); $sub.Dispose()

# Feature pills.
function Draw-Pill([string]$text, [int]$x, [int]$y) {
    $f = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sz = $g.MeasureString($text, $f)
    $w = [int]$sz.Width + 28
    $pill = New-RoundedPath $x $y $w 36 18
    $pb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(60, 255, 255, 255))
    $g.FillPath($pb, $pill)
    $g.DrawString($text, $f, [System.Drawing.Brushes]::White, ($x + 14), ($y + 7))
    $f.Dispose(); $pb.Dispose()
    return $x + $w + 12
}
$px = 292
$px = Draw-Pill "600% Boost" $px 256
$px = Draw-Pill "3-Band EQ" $px 256
$px = Draw-Pill "Speed 16x" $px 256
$px = Draw-Pill "Any Site" $px 256

$g.Dispose()
$bmp.Save((Join-Path $assetsDir 'banner.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote assets/banner.png"

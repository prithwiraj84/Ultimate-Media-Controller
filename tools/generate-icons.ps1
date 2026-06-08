# Generates icons/icon16.png, icon48.png, icon128.png for the extension.
# Uses .NET System.Drawing (available in Windows PowerShell 5.1).
Add-Type -AssemblyName System.Drawing

$root    = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'icons'
if (-not (Test-Path $iconDir)) { New-Item -ItemType Directory -Path $iconDir | Out-Null }

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

function Make-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # Work in a 128x128 design space, then scale to the target size.
    $f = $size / 128.0
    $g.ScaleTransform($f, $f)

    # Rounded gradient background.
    $bg = New-RoundedPath 4 4 120 120 26
    $rect  = New-Object System.Drawing.Rectangle(0, 0, 128, 128)
    $c1    = [System.Drawing.Color]::FromArgb(255, 124, 92, 255)   # #7C5CFF
    $c2    = [System.Drawing.Color]::FromArgb(255, 58, 160, 255)   # #3AA0FF
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
    $g.FillPath($brush, $bg)

    # Speaker silhouette (white).
    $white = [System.Drawing.Brushes]::White
    $pts = @(
        (New-Object System.Drawing.PointF(30, 54)),
        (New-Object System.Drawing.PointF(50, 54)),
        (New-Object System.Drawing.PointF(72, 36)),
        (New-Object System.Drawing.PointF(72, 92)),
        (New-Object System.Drawing.PointF(50, 74)),
        (New-Object System.Drawing.PointF(30, 74))
    )
    $g.FillPolygon($white, $pts)

    # Sound waves (white arcs opening to the right).
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 7)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    foreach ($r in 16, 27, 38) {
        $g.DrawArc($pen, (72 - $r), (64 - $r), ($r * 2), ($r * 2), -42, 84)
    }

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $path"
}

Make-Icon 16  (Join-Path $iconDir 'icon16.png')
Make-Icon 48  (Join-Path $iconDir 'icon48.png')
Make-Icon 128 (Join-Path $iconDir 'icon128.png')
Write-Host "Done."

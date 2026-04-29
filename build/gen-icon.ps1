Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap(256, 256)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded blue square background
$rect = New-Object System.Drawing.Rectangle(8, 8, 240, 240)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 40
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(37,99,235), [System.Drawing.Color]::FromArgb(29,78,216), [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillPath($brush, $path)

# Lightning bolt
$bolt = New-Object System.Drawing.Drawing2D.GraphicsPath
$points = @(
    [System.Drawing.PointF]::new(148, 40),
    [System.Drawing.PointF]::new(88, 132),
    [System.Drawing.PointF]::new(128, 132),
    [System.Drawing.PointF]::new(108, 216),
    [System.Drawing.PointF]::new(168, 124),
    [System.Drawing.PointF]::new(128, 124),
    [System.Drawing.PointF]::new(148, 40)
)
$bolt.AddPolygon($points)
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillPath($whiteBrush, $bolt)

$bmp.Save((Join-Path $PSScriptRoot 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output 'Icon created successfully'

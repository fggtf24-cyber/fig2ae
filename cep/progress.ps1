# Fig2AE: the import progress window over After Effects (Windows).
# server.js starts it when an import from Figma begins. While the importer runs, After Effects is
# busy on its main thread: none of its own windows (ScriptUI, CEP panels) takes a click then
# (tested in AE 26.2). So this is a process of its own. It reads <Dir>\progress.json (written by the
# importer, Fig2AE.jsx) and writes <Dir>\cancel.txt: "stop" keeps what is built, "cancel" removes it.
# Closes itself when the import is over.
param([string]$Dir, [string]$Name64 = '')
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$name = ''
if ($Name64) { $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Name64)) }
$progFile = Join-Path $Dir 'progress.json'
$cancelFile = Join-Path $Dir 'cancel.txt'
$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$bg = [Drawing.Color]::FromArgb(35, 35, 35); $row = [Drawing.Color]::FromArgb(51, 51, 51)
$text = [Drawing.Color]::FromArgb(212, 212, 212); $muted = [Drawing.Color]::FromArgb(143, 143, 143)
$accent = [Drawing.Color]::FromArgb(45, 140, 235)
$font = New-Object Drawing.Font('Segoe UI', 9)

$f = New-Object Windows.Forms.Form
$f.Text = 'Fig2AE'
$f.FormBorderStyle = 'FixedToolWindow'
$f.ClientSize = New-Object Drawing.Size(380, 128)
$f.BackColor = $bg; $f.ForeColor = $text; $f.Font = $font
$f.TopMost = $true; $f.ShowInTaskbar = $true; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'Manual'
$scr = [Windows.Forms.Screen]::PrimaryScreen
try { $ae = Get-Process AfterFX | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($ae) { $scr = [Windows.Forms.Screen]::FromHandle($ae.MainWindowHandle) } } catch {}
$wa = $scr.WorkingArea
$f.Location = New-Object Drawing.Point(($wa.X + [int](($wa.Width - $f.Width) / 2)), ($wa.Y + [int]($wa.Height * 0.62)))

$title = New-Object Windows.Forms.Label
$title.Text = 'Importing from Figma' + $(if ($name) { ' · ' + $name } else { '' })
$title.AutoEllipsis = $true; $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 9.5)
$title.SetBounds(14, 12, 352, 20)
$f.Controls.Add($title)

$track = New-Object Windows.Forms.Panel
$track.BackColor = $row; $track.SetBounds(14, 40, 352, 6)
$fill = New-Object Windows.Forms.Panel
$fill.BackColor = $accent; $fill.SetBounds(0, 0, 0, 6)
$track.Controls.Add($fill)
$f.Controls.Add($track)

$info = New-Object Windows.Forms.Label
$info.Text = 'Waiting for After Effects…'; $info.ForeColor = $muted; $info.AutoEllipsis = $true
$info.SetBounds(14, 52, 352, 20)
$f.Controls.Add($info)

function New-Btn($label, $x, $tip) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $label; $b.FlatStyle = 'Flat'; $b.BackColor = $row; $b.ForeColor = $text
    $b.FlatAppearance.BorderSize = 0
    $b.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(64, 64, 64)
    $b.SetBounds($x, 86, 170, 28)
    (New-Object Windows.Forms.ToolTip).SetToolTip($b, $tip)
    $f.Controls.Add($b)
    return $b
}
$stop = New-Btn 'Stop — keep what is built' 14 'Stops the import. The layers built so far stay in After Effects.'
$cancel = New-Btn 'Cancel — remove all' 196 'Stops the import and removes everything it has added.'

function Send-Cancel($how, $msg) {
    try { [IO.File]::WriteAllText($cancelFile, $how) } catch {}
    $stop.Enabled = $false; $cancel.Enabled = $false
    $info.Text = $msg; $info.ForeColor = $text
}
$stop.Add_Click({ Send-Cancel 'stop' 'Stopping after the current layer…' })
$cancel.Add_Click({ Send-Cancel 'cancel' 'Cancelling — removing what was built…' })

# After the import: the fonts AE did not find, even by a similar name ("Family Style<TAB>stand-in").
# The window stays open with the list until it is closed.
$fontsShown = $false
function Show-MissingFonts($items, $renamed) {
    $script:fontsShown = $true
    $stop.Visible = $false; $cancel.Visible = $false; $track.Visible = $false
    $f.TopMost = $false
    $n = $items.Count; $r = $renamed.Count
    $orange = [Drawing.Color]::FromArgb(229, 177, 102); $green = [Drawing.Color]::FromArgb(110, 196, 150)
    if ($n -gt 0) {
        $title.Text = $(if ($n -eq 1) { '1 font is not installed' } else { "$n fonts are not installed" })
        $title.ForeColor = $orange
        $info.Text = 'After Effects used a stand-in. Install them, then press "Re-check missing fonts" in the Fig2AE panel.'
    } else {
        $title.Text = $(if ($r -eq 1) { '1 font was found under a similar name' } else { "$r fonts were found under a similar name" })
        $title.ForeColor = $green
        $info.Text = 'Figma calls them a little differently than this computer does. Check that the right font was picked.'
    }
    $info.ForeColor = $muted
    $info.SetBounds(14, 34, 352, 34); $info.AutoEllipsis = $false
    $list = New-Object Windows.Forms.Panel
    $list.BackColor = [Drawing.Color]::FromArgb(43, 43, 43); $list.AutoScroll = $true
    $rowH = 24
    $rows = $n + $r + $(if ($n -gt 0 -and $r -gt 0) { 2 } else { 0 })
    $h = [Math]::Min(9, $rows) * $rowH + 8
    $list.SetBounds(14, 72, 352, $h)
    $y = 4; $names = @()
    function Add-Head($t, $c) {
        $l = New-Object Windows.Forms.Label
        $l.Text = $t; $l.ForeColor = $c; $l.SetBounds(10, $script:y, 330, 20)
        $l.Font = New-Object Drawing.Font('Segoe UI', 8.25)
        $list.Controls.Add($l); $script:y += $rowH
    }
    function Add-Row($it, $arrow) {
        $parts = ([string]$it).Split("`t")
        $script:names += $parts[0]
        $a = New-Object Windows.Forms.Label
        $a.Text = $parts[0]; $a.ForeColor = $text; $a.AutoEllipsis = $true
        $a.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
        $a.SetBounds(10, $script:y, 196, 20)
        $b = New-Object Windows.Forms.Label
        $b.Text = $(if ($parts.Count -gt 1 -and $parts[1]) { $arrow + ' ' + $parts[1] } else { '' }); $b.ForeColor = $muted; $b.AutoEllipsis = $true
        $b.SetBounds(208, $script:y, 132, 20)
        $list.Controls.Add($a); $list.Controls.Add($b)
        $script:y += $rowH
    }
    $script:y = $y; $script:names = @()
    if ($n -gt 0 -and $r -gt 0) { Add-Head 'NOT INSTALLED — stand-in used' $orange }
    foreach ($it in $items) { Add-Row $it '→' }
    if ($n -gt 0 -and $r -gt 0) { Add-Head 'FOUND UNDER A SIMILAR NAME' $green }
    foreach ($it in $renamed) { Add-Row $it '=' }
    $names = $script:names
    $f.Controls.Add($list)
    $by = 72 + $h + 12
    $copy = New-Btn 'Copy names' 14 'Copies the font names, one per line'
    $close = New-Btn 'Close' 196 ''
    $copy.Top = $by; $close.Top = $by
    $copy.Add_Click({ try { [Windows.Forms.Clipboard]::SetText(($names -join "`r`n")); $copy.Text = 'Copied' } catch {} }.GetNewClosure())
    $close.Add_Click({ $f.Close() })
    $f.ClientSize = New-Object Drawing.Size(380, ($by + 28 + 14))
    $f.Text = 'Fig2AE · fonts'
    $f.Activate()
}

$seen = $false
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    $p = $null
    try { $p = [IO.File]::ReadAllText($progFile) | ConvertFrom-Json } catch {}
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($p -and $p.t -ge $started - 3000) {
        if ($p.state -eq 'running') {
            $script:seen = $true
            $tot = [Math]::Max(1, [int]$p.total)
            $k = [double]$p.n / $tot; if ($k -gt 1.0) { $k = 1.0 }       # [Math]::Min(1, x) picks the integer overload here
            $fill.Width = [int](352.0 * $k)
            if ($stop.Enabled) {
                $l = [string]$p.layer
                $info.Text = "$($p.n) / $($p.total) layers" + $(if ($l) { ' · ' + $l } else { '' })
            }
        } elseif ($p.state -eq 'done' -and ((($p.missing | Measure-Object).Count -gt 0) -or (($p.renamed | Measure-Object).Count -gt 0))) {
            # (@($null).Count is 1 in PowerShell 5.1: Measure-Object counts a missing key as 0)
            if (-not $script:fontsShown) { Show-MissingFonts @($p.missing | Where-Object { $_ }) @($p.renamed | Where-Object { $_ }) }
        } elseif ($script:seen -or $now - $started -gt 5000) { $f.Close() }
    }
    $script:ticks++
    if ($script:ticks % 10 -eq 0 -and -not (Get-Process AfterFX -ErrorAction SilentlyContinue)) { $f.Close() }
})
$ticks = 0
# The process is started hidden (node windowsHide + -WindowStyle Hidden): Windows may replace the first
# ShowWindow call of the process with SW_HIDE (STARTUPINFO) — whether that hits the console or this form
# depends on how it was started. So after showing, check and show it again until it really is visible.
Add-Type -Namespace F2A -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@
$f.Add_Shown({
    for ($i = 0; $i -lt 3 -and -not [F2A.Win]::IsWindowVisible($f.Handle); $i++) { [void][F2A.Win]::ShowWindow($f.Handle, 5) }
    [void][F2A.Win]::SetForegroundWindow($f.Handle)
    $timer.Start()
})
[System.Windows.Forms.Application]::Run($f)

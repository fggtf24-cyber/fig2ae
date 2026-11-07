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

# インストール手順書（docs/install.md）用に、Windows の初回の画面を撮る。release.yml の install-shots ジョブから呼ぶ。
#   使い方: powershell -File win.ps1 <インストーラ exe> <出力ディレクトリ>
# ブラウザで落とした状態（Zone.Identifier, ZoneId=3）を再現し、エクスプローラーから開いて次を撮る（英語表示）:
#   win-1-smartscreen       SmartScreen「Windows protected your PC」
#   win-2-smartscreen-more  「More info」を押した後（「Run anyway」が出る）
#   win-3-options           インストーラ: インストールの範囲
#   win-4-folder            インストーラ: インストール先
#   win-5-finish            インストーラ: 完了
#   win-6-launched          起動した画面
# 窓の範囲だけを切り抜く（ランナーの端末を写さない）。撮れなかった画面は report.txt に残し、終了コードは 0。
param([string]$Exe, [string]$Out)
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
function Log($m) { $l = "[$(Get-Date -f HH:mm:ss)] $m"; Write-Host $l; Add-Content "$Out/log.txt" $l }

function FindByName([string[]]$names) {
  foreach ($n in $names) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $n)
    $e = $AE::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
    if ($e) { return $e }
  }
  return $null
}
# 要素を含む最上位の窓
function TopWindowOf($e) {
  $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cur = $e
  while ($true) {
    $p = $w.GetParent($cur)
    if (-not $p -or $p -eq $AE::RootElement -or [System.Windows.Automation.Automation]::Compare($p, $AE::RootElement)) { return $cur }
    $cur = $p
  }
}
function Shot([string]$name, $element) {
  try {
    $r = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($element) {
      $b = (TopWindowOf $element).Current.BoundingRectangle
      if ($b.Width -gt 50 -and $b.Height -gt 50) { $r = New-Object System.Drawing.Rectangle([int]$b.X, [int]$b.Y, [int]$b.Width, [int]$b.Height) }
    }
    $bmp = New-Object System.Drawing.Bitmap $r.Width, $r.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
    $bmp.Save("$Out/$name.png"); Log "shot $name ($r)"
  } catch { Log "shot $name FAILED: $_" }
}
function Invoke-Element($e) {
  for ($i = 0; $i -lt 60 -and -not $e.Current.IsEnabled; $i++) { Start-Sleep 2 }
  try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Log "clicked '$($e.Current.Name)'"; return $true }
  catch { Log "invoke '$($e.Current.Name)' failed: $_"; return $false }
}
function WaitFor([string[]]$names, [int]$sec) {
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) { $e = FindByName $names; if ($e) { return $e }; Start-Sleep 2 }
  Log "not found: $($names -join ', ')"; return $null
}

# ランナーの端末などを最小化しておく
(New-Object -ComObject Shell.Application).MinimizeAll(); Start-Sleep 2

$dst = Join-Path "$env:USERPROFILE\Downloads" (Split-Path $Exe -Leaf)
New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
Copy-Item $Exe $dst -Force
Set-Content -Path $dst -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://github.com/"
Start-Process explorer.exe -ArgumentList "`"$dst`""

$more = WaitFor @("More info", "詳細情報") 40
if ($more) {
  Shot "win-1-smartscreen" $more
  Invoke-Element $more | Out-Null; Start-Sleep 3
  $run = WaitFor @("Run anyway", "実行") 10
  if ($run) { Shot "win-2-smartscreen-more" $run; Invoke-Element $run | Out-Null }
}

# NSIS の各ページ（Next → Install → Finish）
$nextNames = @("&Next >", "Next >", "次へ(&N) >"); $installNames = @("&Install", "Install", "インストール(&I)"); $finishNames = @("&Finish", "Finish", "完了(&F)")
$e = WaitFor $nextNames 60
if ($e) { Shot "win-3-options" $e; Invoke-Element $e | Out-Null; Start-Sleep 3 }
$e = WaitFor $installNames 30
if ($e) { Shot "win-4-folder" $e; Invoke-Element $e | Out-Null }
$e = WaitFor $finishNames 300
if ($e) { Start-Sleep 2; Shot "win-5-finish" $e; Invoke-Element $e | Out-Null }

# 完了画面の「Run GRAPHY-Next」で起動する。メイン画面が出るまで待つ。
$app = $null
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not $app) {
  Start-Sleep 5
  $app = Get-Process | Where-Object { $_.ProcessName -eq "GRAPHY-Next" -and $_.MainWindowTitle } | Select-Object -First 1
}
if ($app) {
  Start-Sleep 30
  $w = $AE::FromHandle($app.MainWindowHandle)
  Shot "win-6-launched" $w
} else { Log "app window not found" }

$names = "win-1-smartscreen", "win-2-smartscreen-more", "win-3-options", "win-4-folder", "win-5-finish", "win-6-launched"
$names | ForEach-Object { if (Test-Path "$Out/$_.png") { "$_ ok" } else { "$_ MISSING" } } | Tee-Object "$Out/report.txt"
Get-Process | Where-Object { $_.ProcessName -eq "GRAPHY-Next" } | Stop-Process -Force -ErrorAction SilentlyContinue
exit 0

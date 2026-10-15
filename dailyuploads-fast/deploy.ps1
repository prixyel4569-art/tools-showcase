#Requires -Version 5.1
<#
    dailyuploads-fast — 部署 / 自检

    零依赖工具。本脚本只做三件事：
      1. 确认 Node.js >= 18（需要内置 fetch）
      2. 语法检查
      3. 零参数跑一次，确认它是"干净地失败"而不是挂起或崩溃

    ⚠️ 本脚本**不会**发起任何下载 —— 自检用的是无参数调用。
       真要下载请自己带上 URL，见下方用法。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$target = Join-Path $Root 'dailyuploads-fast.mjs'
$script:Fail = 0
$script:Warn = 0

function Ok([string]$m)    { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:Warn++ }
function Bad([string]$m)   { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Fail++ }

Write-Host ""
Write-Host "dailyuploads-fast — 部署自检" -ForegroundColor White

# Node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Bad "未找到 node。请安装 Node.js >= 18: https://nodejs.org/"
    exit 1
}
$v = (& node --version 2>&1).ToString().Trim()
$major = 0
if ($v -match '^v(\d+)\.') { $major = [int]$Matches[1] }
if ($major -lt 18) { Bad "需要 Node >= 18（依赖内置 fetch），当前 $v" } else { Ok "node $v" }

# 文件
if (-not (Test-Path -LiteralPath $target)) { Bad "找不到 dailyuploads-fast.mjs"; exit 1 }
Ok "dailyuploads-fast.mjs 存在"

# 语法
& node --check $target 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "语法检查通过" } else { Bad "语法检查失败" }

# 零参数行为：应干净失败（不下载、不挂起、不崩）
if ($script:Fail -eq 0) {
    Write-Host ""
    Write-Host "  --- 零参数调用（不应发起任何下载）---" -ForegroundColor DarkGray
    $out = (& node $target 2>&1) -join "`n"
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        Bad "零参数却 exit 0 —— 应拒绝执行并提示用法"
    } elseif ($out -match '用法') {
        Ok "干净失败（exit=$code，且提示了用法）"
    } else {
        Warn2 "exit=$code 但没看到用法提示: $($out.Substring(0, [Math]::Min(80, $out.Length)))"
    }
}

# 7-Zip（可选）
if (Get-Command 7z -ErrorAction SilentlyContinue) {
    Ok "7-Zip 在 PATH 中，收尾会自动做归档校验"
} else {
    $z = @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe') |
         Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($z) { Ok "7-Zip: $z" }
    else { Warn2 "未找到 7-Zip（可选）。收尾时跳过归档校验，也可用 `$env:SEVENZ 指定" }
}

Write-Host ""
if ($script:Fail -eq 0) {
    Write-Host "就绪。" -ForegroundColor Green
    Write-Host ""
    Write-Host "用法:" -ForegroundColor White
    Write-Host '  node .\dailyuploads-fast.mjs "<分享URL>" [--out DIR] [--workers 4] [--chunk 2] [--url FILE] [--step 20]'
    Write-Host ""
    Write-Host "提示: --chunk 越小越快（吃突发限速窗口）。实测 2MB×4 ≈ 800 KB/s，8MB×4 ≈ 243 KB/s" -ForegroundColor DarkGray
    Write-Host "      中断后重跑同一条命令即自动续传" -ForegroundColor DarkGray
} else {
    Write-Host "有 $script:Fail 项失败。" -ForegroundColor Red
}
Write-Host ""
exit $(if ($script:Fail -gt 0) { 1 } else { 0 })

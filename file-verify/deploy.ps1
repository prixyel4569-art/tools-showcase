#Requires -Version 5.1
<#
    file-verify — 部署 / 自检

    零依赖工具。本脚本只做三件事：
      1. 确认 Node.js >= 18
      2. 语法检查
      3. 拿自己当被测文件跑一次，确认功能正常

    只读文件，不改动任何东西。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$target = Join-Path $Root 'file-verify.mjs'
$script:Fail = 0

function Ok([string]$m)    { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad([string]$m)   { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Fail++ }

Write-Host ""
Write-Host "file-verify — 部署自检" -ForegroundColor White

# Node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Bad "未找到 node。请安装 Node.js >= 18: https://nodejs.org/"
    exit 1
}
$v = (& node --version 2>&1).ToString().Trim()
$major = 0
if ($v -match '^v(\d+)\.') { $major = [int]$Matches[1] }
if ($major -lt 18) { Bad "需要 Node >= 18，当前 $v" } else { Ok "node $v" }

# 文件
if (-not (Test-Path -LiteralPath $target)) { Bad "找不到 file-verify.mjs"; exit 1 }
Ok "file-verify.mjs 存在"

# 语法
& node --check $target 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "语法检查通过" } else { Bad "语法检查失败" }

# 功能：拿自己当被测文件
if ($script:Fail -eq 0) {
    Write-Host ""
    Write-Host "  --- 拿脚本自身当被测文件跑一次 ---" -ForegroundColor DarkGray
    $out = & node $target $target 2>&1
    if ($LASTEXITCODE -eq 0 -and ($out -join "`n") -match '全零块') {
        Ok "功能正常（输出含空洞扫描结果）"
        $md5line = ($out | Where-Object { $_ -match '^\s+md5\s+' } | Select-Object -First 1)
        Ok "哈希输出: $($md5line.Trim())"
    } else {
        Bad "功能异常，退出码 $LASTEXITCODE"
        $out | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
    }
}

Write-Host ""
if ($script:Fail -eq 0) {
    Write-Host "就绪。" -ForegroundColor Green
    Write-Host ""
    Write-Host "用法:" -ForegroundColor White
    Write-Host '  node .\file-verify.mjs "<文件路径>" [期望字节数] [期望MD5]'
} else {
    Write-Host "有 $script:Fail 项失败。" -ForegroundColor Red
}
Write-Host ""
exit $(if ($script:Fail -gt 0) { 1 } else { 0 })

#Requires -Version 5.1
<#
    smoke — 部署 / 自检

    零依赖工具。本脚本做四件事：
      1. 确认 Node.js >= 18
      2. 检查 smoke.mjs 与 smoke.config.json 是否齐全
      3. 语法检查
      4. 直接跑一遍冒烟测试

    只读文件。注意：冒烟测试会**按配置执行被测工具**，
    所以配置里进 tiers.syntax 的工具不会被真的跑起来。
#>
[CmdletBinding()]
param(
    [switch]$Fast,
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$smoke  = Join-Path $Root 'smoke.mjs'
$config = Join-Path $Root 'smoke.config.json'
$script:Fail = 0

function Ok([string]$m)  { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Fail++ }

Write-Host ""
Write-Host "smoke — 部署自检" -ForegroundColor White

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
foreach ($pair in @(@('smoke.mjs', $smoke), @('smoke.config.json', $config))) {
    if (Test-Path -LiteralPath $pair[1]) { Ok "$($pair[0]) 存在" } else { Bad "缺失: $($pair[0])" }
}
if ($script:Fail -gt 0) { exit 1 }

# 语法
& node --check $smoke 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "语法检查通过" } else { Bad "语法检查失败" }

# 配置可解析
try {
    $cfg = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
    Ok "配置可解析（root=$($cfg.root)，tiers: $(($cfg.tiers.PSObject.Properties.Name) -join '/')）"
} catch {
    Bad "配置解析失败: $_"
}

# 跑冒烟
if ($script:Fail -eq 0) {
    Write-Host ""
    Write-Host "  --- 运行冒烟测试 ---" -ForegroundColor DarkGray
    $a = @($smoke)
    if ($Fast) { $a += '--fast' }
    if ($Json) { $a += '--json' }
    & node @a
    if ($LASTEXITCODE -eq 0) { Ok "冒烟测试通过" }
    elseif ($LASTEXITCODE -eq 1) { Bad "冒烟测试有 FAIL（见上方输出）" }
    else { Bad "冒烟测试退出码 $LASTEXITCODE" }
}

Write-Host ""
if ($script:Fail -eq 0) { Write-Host "就绪。" -ForegroundColor Green } else { Write-Host "有 $script:Fail 项失败。" -ForegroundColor Red }
Write-Host ""
exit $(if ($script:Fail -gt 0) { 1 } else { 0 })

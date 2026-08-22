# Windhawk Mod 介绍自动翻译 - 安装 / 更新脚本
# =====================================================
# 功能：
#   1. 复制 translate.js 到 Windhawk UI 的 webview 目录
#   2. 在 webview/index.html 中注入 translate.js 引用
#   3. 修改扩展 extension.js 的 CSP，放行翻译 API 域名
# 重复运行安全（幂等），Windhawk 升级后重新运行本脚本即可恢复功能。
#
# 用法（右键"使用 PowerShell 运行"，或）：
#   powershell -ExecutionPolicy Bypass -File install.ps1
# 需要管理员权限（自动请求提权）。

$ErrorActionPreference = 'Stop'

# 当前脚本所在目录（含 translate.js）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Windhawk 安装路径（可按需修改）
$whRoot = 'C:\Program Files\Windhawk'
$src = Join-Path $whRoot 'UI\resources\app\extensions\windhawk'
$webviewDir = Join-Path $src 'webview'
$extJs = Join-Path $src 'dist\extension.js'

# ---- 自动提权（非管理员时重启自己） ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '需要管理员权限，正在请求提权...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    exit
}

Write-Host '=== Windhawk Mod 介绍自动翻译 安装脚本 ===' -ForegroundColor Cyan

# ---- 检查 ----
if (-not (Test-Path $extJs))  { Write-Error "未找到 extension.js: $extJs （请确认 Windhawk 安装路径）"; exit 1 }
if (-not (Test-Path (Join-Path $webviewDir 'index.html'))) { Write-Error "未找到 webview/index.html"; exit 1 }
if (-not (Test-Path (Join-Path $scriptDir 'translate.js'))) { Write-Error "未找到 translate.js（与脚本同目录）"; exit 1 }

# ---- 备份 ----
$bak = Join-Path $scriptDir 'backup'
New-Item -ItemType Directory -Force -Path $bak | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $extJs (Join-Path $bak "extension.js.$stamp.bak") -Force
Copy-Item (Join-Path $webviewDir 'index.html') (Join-Path $bak "index.html.$stamp.bak") -Force
Write-Host "已备份原文件到 backup\$stamp" -ForegroundColor Gray

# ---- 1. 复制 translate.js ----
Copy-Item (Join-Path $scriptDir 'translate.js') (Join-Path $webviewDir 'translate.js') -Force
Write-Host '[1/3] translate.js 已部署' -ForegroundColor Green

# ---- 2. 注入 index.html ----
$idx = Join-Path $webviewDir 'index.html'
$t = [System.IO.File]::ReadAllText($idx)
if ($t.Contains('translate.js')) {
    Write-Host '[2/3] index.html 已包含 translate.js，跳过' -ForegroundColor Gray
} else {
    $t = $t.Replace('</body>', '<script src="translate.js"></script>' + [char]10 + '</body>')
    [System.IO.File]::WriteAllText($idx, $t)
    Write-Host '[2/3] index.html 注入完成' -ForegroundColor Green
}

# ---- 3. 修改 extension.js 的 CSP（幂等；https: 通配支持任意 AI API 域名） ----
$t2 = [System.IO.File]::ReadAllText($extJs)
$oldCsp = 'connect-src ${a.cspSource} https://mods.windhawk.net https://ramensoftware.com'
$oldList = ' https://translate.googleapis.com https://cn.bing.com https://www.bing.com https://edge.microsoft.com https://api-edge.cognitive.microsofttranslator.com https://api.mymemory.translated.net'
$newCsp = $oldCsp + ' https:'
if ($t2.Contains($newCsp)) {
    Write-Host '[3/3] extension.js CSP 已放行翻译域名，跳过' -ForegroundColor Gray
} elseif ($t2.Contains($oldCsp + $oldList)) {
    $t2 = $t2.Replace($oldCsp + $oldList, $newCsp)
    [System.IO.File]::WriteAllText($extJs, $t2)
    Write-Host '[3/3] extension.js CSP 已更新（收拢为 https:）' -ForegroundColor Green
} elseif ($t2.Contains($oldCsp)) {
    $t2 = $t2.Replace($oldCsp, $newCsp)
    [System.IO.File]::WriteAllText($extJs, $t2)
    Write-Host '[3/3] extension.js CSP 修改完成' -ForegroundColor Green
} else {
    Write-Warning '[3/3] 未找到预期的 CSP 片段，可能 Windhawk 版本已改变代码结构，请检查'
}

Write-Host ''
Write-Host '安装完成！请完全退出 Windhawk 后重新打开，进入 Mod 详情页即可看到自动翻译。' -ForegroundColor Cyan
Write-Host 'Windhawk 升级后重新运行本脚本即可。' -ForegroundColor Cyan

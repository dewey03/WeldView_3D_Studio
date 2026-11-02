<#
.SYNOPSIS
    构建 WeldView 3D Studio 桌面端与安装包。

.DESCRIPTION
    阶段一：dotnet publish 产出单文件 exe 到 dist\publish\
    阶段二：调用 Inno Setup 编译安装包到 dist\

.PARAMETER SkipInstaller
    只构建 exe，不生成安装包。

.PARAMETER Configuration
    构建配置，默认 Release。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipInstaller
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DesktopProj = Join-Path $RepoRoot 'desktop\WeldView.Desktop.csproj'
$PublishDir = Join-Path $RepoRoot 'dist\publish'
$SetupScript = Join-Path $RepoRoot 'installer\WeldView_Setup.iss'

function Write-Stage([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- 前置检查
Write-Stage '检查构建环境'

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    throw '未找到 dotnet SDK。请安装 .NET 8 SDK：https://dotnet.microsoft.com/download'
}
Write-Host ("  dotnet : " + (& dotnet --version))

# ---------------------------------------------------------------- 构建 exe
Write-Stage "编译桌面端 ($Configuration)"

if (Test-Path $PublishDir) { Remove-Item $PublishDir -Recurse -Force }

& dotnet publish $DesktopProj `
    -c $Configuration `
    -r win-x64 `
    --self-contained false `
    -p:PublishSingleFile=true `
    -p:EnableCompressionInSingleFile=true `
    -o $PublishDir

if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败，退出码 $LASTEXITCODE" }

$exe = Join-Path $PublishDir 'WeldView_3D_Studio.exe'
if (-not (Test-Path $exe)) { throw "未生成 $exe" }
Write-Host ("  产物   : " + $exe + "  (" + [math]::Round((Get-Item $exe).Length / 1MB, 1) + " MB)")

# ---------------------------------------------------------------- 打包安装器
if ($SkipInstaller) {
    Write-Stage '已跳过安装包构建 (-SkipInstaller)'
    return
}

Write-Stage '编译安装包'

$iscc = $null
foreach ($candidate in @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe')) {
    if (Test-Path $candidate) { $iscc = $candidate; break }
}
if (-not $iscc) {
    $iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue)?.Source
}
if (-not $iscc) {
    Write-Warning '未找到 Inno Setup 6 的 ISCC.exe，跳过安装包构建。'
    Write-Warning '下载：https://jrsoftware.org/isdl.php'
    return
}
Write-Host ("  ISCC   : " + $iscc)

& $iscc $SetupScript
if ($LASTEXITCODE -ne 0) { throw "ISCC 编译失败，退出码 $LASTEXITCODE" }

$setup = Get-ChildItem (Join-Path $RepoRoot 'dist') -Filter '*Setup*.exe' |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($setup) {
    Write-Stage '构建完成'
    Write-Host ("  安装包 : " + $setup.FullName + "  (" + [math]::Round($setup.Length / 1MB, 1) + " MB)") -ForegroundColor Green
}

param(
    [string]$SteamRoot
)

$ErrorActionPreference = "Stop"

function Get-SteamRoot {
    param([string]$Provided)

    if ($Provided -and (Test-Path -LiteralPath $Provided)) {
        return (Resolve-Path -LiteralPath $Provided).Path
    }

    if ($env:Steam -and (Test-Path -LiteralPath $env:Steam)) {
        return (Resolve-Path -LiteralPath $env:Steam).Path
    }

    foreach ($path in @("HKCU:\Software\Valve\Steam", "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam", "HKLM:\SOFTWARE\Valve\Steam")) {
        try {
            $installPath = (Get-ItemProperty -LiteralPath $path -ErrorAction Stop).SteamPath
            if ($installPath -and (Test-Path -LiteralPath $installPath)) {
                return (Resolve-Path -LiteralPath $installPath).Path
            }
        } catch {}
    }

    $fallback = Join-Path ${env:ProgramFiles(x86)} "Steam"
    if ($fallback -and (Test-Path -LiteralPath $fallback)) {
        return (Resolve-Path -LiteralPath $fallback).Path
    }

    throw "Steam folder not found."
}

function Add-EnabledPlugin {
    param(
        [object]$Config,
        [string]$PluginName
    )

    if (-not $Config.plugins) {
        $Config | Add-Member -MemberType NoteProperty -Name plugins -Value ([pscustomobject]@{})
    }

    if (-not $Config.plugins.enabledPlugins) {
        $Config.plugins | Add-Member -MemberType NoteProperty -Name enabledPlugins -Value @() -Force
    }

    $nested = @($Config.plugins.enabledPlugins)
    if ($nested -notcontains $PluginName) {
        $Config.plugins.enabledPlugins = @($nested + $PluginName)
    }

    $flatName = "plugins.enabledPlugins"
    $flat = @()
    if ($Config.PSObject.Properties.Name -contains $flatName) {
        $flat = @($Config.$flatName)
    }

    if ($flat -notcontains $PluginName) {
        $Config | Add-Member -MemberType NoteProperty -Name $flatName -Value @($flat + $PluginName) -Force
    }
}

$pluginName = "HubcapPlugin"
$source = Join-Path $PSScriptRoot $pluginName
if (-not (Test-Path -LiteralPath $source)) {
    if ((Split-Path -Leaf $PSScriptRoot) -eq $pluginName) {
        $source = $PSScriptRoot
    } else {
        throw "Could not find $pluginName folder next to install.ps1"
    }
}

$steam = Get-SteamRoot -Provided $SteamRoot
$pluginsDir = Join-Path $steam "millennium\plugins"
$target = Join-Path $pluginsDir $pluginName
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $target -Recurse

$configPath = Join-Path $steam "millennium\config\config.json"
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Add-EnabledPlugin -Config $config -PluginName $pluginName
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
}

Write-Host "Installed and enabled $pluginName at $target"

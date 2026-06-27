param(
    [string]$AppId,
    [string]$Artifact = "lua",
    [switch]$CheckOnly,
    [switch]$CheckLua,
    [switch]$DeleteLua,
    [switch]$StatusOnly,
    [switch]$UserStats,
    [switch]$CheckManifest,
    [switch]$DeleteManifest
)

$ErrorActionPreference = "Stop"

function Write-JsonAndExit {
    param(
        [hashtable]$Payload,
        [int]$Code = 0
    )

    $Payload | ConvertTo-Json -Compress -Depth 6
    exit $Code
}

function Get-SteamRoot {
    if ($env:Steam -and (Test-Path -LiteralPath $env:Steam)) {
        return (Resolve-Path -LiteralPath $env:Steam).Path
    }

    $registryPaths = @(
        "HKCU:\Software\Valve\Steam",
        "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam",
        "HKLM:\SOFTWARE\Valve\Steam"
    )

    foreach ($path in $registryPaths) {
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

    throw "Steam folder not found. Set the Steam environment variable or install HubcapTool under Steam\config\hubcaptools."
}

function Read-HubcapConfig {
    param([string]$ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "HubcapTool config.yaml not found at $ConfigPath"
    }

    $config = @{
        HubcapApiKey = $null
        HubcapLuaDir = $null
    }

    foreach ($line in Get-Content -LiteralPath $ConfigPath) {
        if ($line -match '^\s*(HubcapApiKey|HubcapLuaDir)\s*:\s*(.*?)\s*$') {
            $value = $Matches[2].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $config[$Matches[1]] = $value
        }
    }

    if ([string]::IsNullOrWhiteSpace($config.HubcapApiKey)) {
        throw "HubcapApiKey is missing in $ConfigPath"
    }

    if ([string]::IsNullOrWhiteSpace($config.HubcapLuaDir)) {
        throw "HubcapLuaDir is missing in $ConfigPath"
    }

    return $config
}

function Get-LuaFiles {
    param([string]$Directory)

    if (-not (Test-Path -LiteralPath $Directory)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter "*.lua")
}

function Get-ManifestFiles {
    param([string]$Directory)

    if (-not (Test-Path -LiteralPath $Directory)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter "*.manifest")
}

function Remove-IfExists {
    param([string]$Path)

    if ($Path -and (Test-Path -LiteralPath $Path)) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Remove-EmptyDirectory {
    param([string]$Path)

    if ($Path -and (Test-Path -LiteralPath $Path)) {
        $hasChildren = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue).Count -gt 0
        if (-not $hasChildren) {
            Remove-Item -LiteralPath $Path -Force
        }
    }
}

function Get-HttpErrorMessage {
    param([object]$ErrorRecord)

    $statusCode = $null
    $responseText = $null

    try {
        if ($ErrorRecord.Exception.Response) {
            $statusCode = [int]$ErrorRecord.Exception.Response.StatusCode
            $stream = $ErrorRecord.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = [System.IO.StreamReader]::new($stream)
                $responseText = $reader.ReadToEnd()
                $reader.Dispose()
            }
        }
    } catch {}

    if (-not $statusCode -and $ErrorRecord.Exception.Response.StatusCode.value__) {
        $statusCode = [int]$ErrorRecord.Exception.Response.StatusCode.value__
    }

    switch ($statusCode) {
        401 { return "Invalid Hubcap API key or unauthorized access." }
        403 { return "Hubcap rejected this request. Check that your API key has access." }
        404 { return "Hubcap does not have this file for this app yet." }
        429 { return "Hubcap rate limit or daily limit reached. Try again later." }
        500 { return "Hubcap server error. Try again later." }
        502 { return "Hubcap gateway error. Try again later." }
        503 { return "Hubcap service unavailable. Try again later." }
        504 { return "Hubcap request timed out. Try again later." }
    }

    if ($responseText) {
        try {
            $json = $responseText | ConvertFrom-Json
            foreach ($field in @("detail", "error", "message")) {
                if ($json.$field) {
                    return "Hubcap error: $($json.$field)"
                }
            }
        } catch {}
    }

    return $ErrorRecord.Exception.Message
}

try {
    $steamRoot = Get-SteamRoot
    $configPath = Join-Path $steamRoot "config\hubcaptools\config.yaml"
    $config = Read-HubcapConfig -ConfigPath $configPath
    $luaDir = [Environment]::ExpandEnvironmentVariables($config.HubcapLuaDir)

    if ($CheckOnly) {
        Write-JsonAndExit @{
            success = $true
            steamRoot = $steamRoot
            configPath = $configPath
            luaDir = $luaDir
            hasApiKey = $true
        }
    }

    if ($UserStats) {
        $statsUrl = "https://hubcapmanifest.com/api/v1/user/stats"

        try {
            $payload = Invoke-RestMethod -Uri $statsUrl -Headers @{ Authorization = "Bearer $($config.HubcapApiKey)" } -Method Get

            Write-JsonAndExit @{
                success = $true
                username = $payload.username
                dailyUsage = $payload.daily_usage
                dailyLimit = $payload.daily_limit
                roleDailyLimit = $payload.role_daily_limit
                apiKeyUsageCount = $payload.api_key_usage_count
                apiKeyExpiresAt = $payload.api_key_expires_at
                autoUpdateEnabled = $payload.auto_update_enabled
                canMakeRequests = $payload.can_make_requests
                timestamp = $payload.timestamp
            }
        } catch {
            throw (Get-HttpErrorMessage -ErrorRecord $_)
        }
    }

    if ($AppId -notmatch '^\d+$') {
        throw "Invalid Steam app id: $AppId"
    }

    if ($StatusOnly) {
        $statusUrl = "https://hubcapmanifest.com/api/v1/status/$AppId"

        try {
            $response = Invoke-WebRequest -Uri $statusUrl -Headers @{ Authorization = "Bearer $($config.HubcapApiKey)" } -UseBasicParsing -Method Get
            $payload = $response.Content | ConvertFrom-Json
            $available = $payload.status -eq "available" -and $payload.manifest_file_exists -eq $true -and $payload.update_in_progress -ne $true

            Write-JsonAndExit @{
                success = $true
                appId = $AppId
                available = $available
                status = $payload.status
                gameName = $payload.game_name
                manifestFileExists = $payload.manifest_file_exists
                updateInProgress = $payload.update_in_progress
                needsUpdate = $payload.needs_update
                updateReason = $payload.update_reason
                fileSize = $payload.file_size
                fileModified = $payload.file_modified
                message = $payload.message
            }
        } catch {
            throw (Get-HttpErrorMessage -ErrorRecord $_)
        }
    }

    New-Item -ItemType Directory -Force -Path $luaDir | Out-Null
    $directLuaPath = Join-Path $luaDir "$AppId.lua"
    $manifestDir = Join-Path $steamRoot "depotcache"
    $manifestMarkerPath = Join-Path (Join-Path $steamRoot "config") "hubcapplugin-manifest-$AppId.txt"
    $legacyManifestMarkerPath = Join-Path $manifestDir ".hubcapmanifest-$AppId"

    if ($CheckLua) {
        Write-JsonAndExit @{
            success = $true
            appId = $AppId
            exists = Test-Path -LiteralPath $directLuaPath
            luaDir = $luaDir
            luaFiles = @($directLuaPath)
        }
    }

    if ($DeleteLua) {
        $existed = Test-Path -LiteralPath $directLuaPath
        $removedLuaFiles = @()

        if ($existed) {
            Remove-Item -LiteralPath $directLuaPath -Force
            $removedLuaFiles += $directLuaPath
        }

        if (Test-Path -LiteralPath $manifestMarkerPath) {
            Remove-Item -LiteralPath $manifestMarkerPath -Force
        }

        if (Test-Path -LiteralPath $legacyManifestMarkerPath) {
            Remove-Item -LiteralPath $legacyManifestMarkerPath -Force
        }

        Write-JsonAndExit @{
            success = $true
            appId = $AppId
            removed = $existed
            exists = $false
            luaDir = $luaDir
            manifestDir = $manifestDir
            luaFiles = $removedLuaFiles
            manifestFiles = @()
        }
    }

    if ($CheckManifest) {
        Write-JsonAndExit @{
            success = $true
            appId = $AppId
            exists = (Test-Path -LiteralPath $manifestMarkerPath) -or (Test-Path -LiteralPath $legacyManifestMarkerPath)
            manifestDir = $manifestDir
            markerPath = $manifestMarkerPath
        }
    }

    if ($DeleteManifest) {
        $markerToRead = if (Test-Path -LiteralPath $manifestMarkerPath) { $manifestMarkerPath } elseif (Test-Path -LiteralPath $legacyManifestMarkerPath) { $legacyManifestMarkerPath } else { $manifestMarkerPath }
        $existed = Test-Path -LiteralPath $markerToRead
        $removedFiles = @()

        if ($existed) {
            foreach ($line in Get-Content -LiteralPath $markerToRead) {
                if ($line -match '^file=(.+)$') {
                    $path = $Matches[1]
                    if ($path -and (Test-Path -LiteralPath $path)) {
                        Remove-Item -LiteralPath $path -Force
                        $removedFiles += $path
                    }
                }
            }

            Remove-Item -LiteralPath $markerToRead -Force
        }

        if (Test-Path -LiteralPath $legacyManifestMarkerPath) {
            Remove-Item -LiteralPath $legacyManifestMarkerPath -Force
        }

        Write-JsonAndExit @{
            success = $true
            appId = $AppId
            removed = $existed
            exists = $false
            manifestDir = $manifestDir
            markerPath = $manifestMarkerPath
            manifestFiles = $removedFiles
        }
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $artifactName = "bundle"
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "HubcapPlugin"
    $downloadDir = Join-Path $tempRoot "$AppId-$artifactName-$timestamp-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $rawDownload = Join-Path $downloadDir "$AppId-$artifactName.download"
    $zipPath = Join-Path $downloadDir "$AppId-$artifactName.zip"
    $extractDir = Join-Path $downloadDir "extracted"
    $url = "https://hubcapmanifest.com/api/v1/manifest/$AppId"

    try {
        Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $($config.HubcapApiKey)" } -OutFile $rawDownload -UseBasicParsing
    } catch {
        throw (Get-HttpErrorMessage -ErrorRecord $_)
    }

    $bytes = [System.IO.File]::ReadAllBytes($rawDownload)
    $isZip = $bytes.Length -ge 4 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B
    $copiedLuaFiles = @()

    if (-not $isZip) {
        throw "Hubcap manifest response was not a ZIP file."
    }

    Move-Item -LiteralPath $rawDownload -Destination $zipPath -Force
    New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    foreach ($file in Get-LuaFiles -Directory $extractDir) {
        $destination = Join-Path $luaDir $file.Name
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        $copiedLuaFiles += $destination
    }

    $copiedManifestFiles = @()
    foreach ($file in Get-ManifestFiles -Directory $extractDir) {
        $destination = Join-Path $manifestDir $file.Name
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        $copiedManifestFiles += $destination
    }

    if ($copiedLuaFiles.Count -eq 0) {
        throw "Downloaded ZIP did not contain a .lua file."
    }

    if ($copiedManifestFiles.Count -eq 0) {
        throw "Downloaded ZIP did not contain a .manifest file."
    }

    Remove-IfExists -Path $manifestMarkerPath
    Remove-IfExists -Path $legacyManifestMarkerPath
    Remove-IfExists -Path $downloadDir
    Remove-EmptyDirectory -Path $tempRoot

    Write-JsonAndExit @{
        success = $true
        appId = $AppId
        kind = "bundle"
        luaDir = $luaDir
        manifestDir = $manifestDir
        luaFiles = $copiedLuaFiles
        manifestFiles = $copiedManifestFiles
    }
} catch {
    Remove-IfExists -Path $downloadDir
    Remove-EmptyDirectory -Path $tempRoot
    Write-JsonAndExit @{
        success = $false
        error = $_.Exception.Message
    } 1
}

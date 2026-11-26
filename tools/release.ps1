#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$ScratchParent = [System.IO.Path]::GetTempPath()
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination = [System.IO.Directory]::CreateDirectory($OutputDirectory).FullName
$scratchBase = [System.IO.Directory]::CreateDirectory($ScratchParent).FullName
$scratchName = 'frameledger-release-' + [guid]::NewGuid().ToString('N')
$scratch = [System.IO.Directory]::CreateDirectory((Join-Path $scratchBase $scratchName)).FullName
$npmBin = if ($IsWindows) { 'npm.cmd' } else { 'npm' }

function Assert-Exit([int]$Code, [string]$Action) {
    if ($Code -ne 0) { throw "$Action failed (exit $Code)." }
}

function Save-VerifiedFile([string]$Source, [string]$Target) {
    $candidate = Join-Path (Split-Path -Parent $Target) ('.frameledger-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::Copy($Source, $candidate)
        if ((Get-FileHash -LiteralPath $candidate).Hash -ne (Get-FileHash -LiteralPath $Source).Hash) {
            throw "Copy verification failed at $Target"
        }
        [System.IO.File]::Move($candidate, $Target, $true)
    } finally {
        if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
    }
}

try {
    $revision = git -C $project rev-parse --verify HEAD
    Assert-Exit $LASTEXITCODE 'Read Git revision'
    $sourceZip = Join-Path $scratch 'source.zip'
    git -C $project archive --format=zip --output=$sourceZip $revision
    Assert-Exit $LASTEXITCODE 'Export source'
    $tree = Join-Path $scratch 'source'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($sourceZip, $tree)
    $sourceArchive = [System.IO.Compression.ZipFile]::OpenRead($sourceZip)
    try {
        [string[]]$paths = foreach ($entry in $sourceArchive.Entries) {
            if ($entry.Name) { [string]$entry.FullName }
        }
    } finally {
        $sourceArchive.Dispose()
    }
    $version = (Get-Content -Raw -LiteralPath (Join-Path $tree 'package.json') | ConvertFrom-Json).version
    Push-Location $tree
    try {
        & $npmBin run verify
        Assert-Exit $LASTEXITCODE 'Build and verify clean snapshot'
    } finally { Pop-Location }

    $bundle = Join-Path $tree 'development-history.bundle'
    $branch = git -C $project symbolic-ref --quiet HEAD
    $refs = @('HEAD')
    if ($LASTEXITCODE -eq 0) { $refs += $branch }
    git -C $project bundle create $bundle @refs
    Assert-Exit $LASTEXITCODE 'Bundle local development history'
    $head = git bundle list-heads $bundle HEAD
    Assert-Exit $LASTEXITCODE 'Read bundled head'
    if (($head -split '\s+')[0] -ne $revision) { throw 'The checkout moved during packaging.' }
    git -C $project bundle verify $bundle
    Assert-Exit $LASTEXITCODE 'Verify Git history'

    $paths += 'dist/FrameLedger.html', 'dist/engine.mjs', 'development-history.bundle'
    [Array]::Sort($paths, [StringComparer]::Ordinal)
    $timestamp = [DateTimeOffset]::Parse((git -C $project show -s --format=%cI $revision)).ToUniversalTime()
    Assert-Exit $LASTEXITCODE 'Read commit timestamp'
    $prefix = "FrameLedger-$version"
    $archivePath = Join-Path $scratch "$prefix.zip"
    $archive = [System.IO.Compression.ZipFile]::Open($archivePath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in $paths) {
            $entry = $archive.CreateEntry("$prefix/$relative", [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $timestamp
            $inputStream = [System.IO.File]::OpenRead((Join-Path $tree $relative))
            try {
                $outputStream = $entry.Open()
                try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
    } finally { $archive.Dispose() }
    $unpacked = Join-Path $scratch 'unpacked'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $unpacked)
    $check = Join-Path $unpacked $prefix
    foreach ($relative in $paths) {
        if ((Get-FileHash -LiteralPath (Join-Path $tree $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $check $relative)).Hash) {
            throw "Release entry differs from its source: $relative"
        }
    }
    Push-Location $check
    try {
        node tools/test-js.mjs
        Assert-Exit $LASTEXITCODE 'Test unpacked distribution'
    } finally { Pop-Location }
    Save-VerifiedFile $archivePath (Join-Path $destination "$prefix.zip")
    Save-VerifiedFile (Join-Path $check 'dist/FrameLedger.html') (Join-Path $destination 'FrameLedger.html')
    Write-Output "$prefix @ $revision ($($paths.Count) verified entries)"
} finally {
    $resolved = (Resolve-Path -LiteralPath $scratch).Path
    if ([System.IO.Path]::GetDirectoryName($resolved) -ne $scratchBase -or
        [System.IO.Path]::GetFileName($resolved) -ne $scratchName) { throw 'Unexpected scratch directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

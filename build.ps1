[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-ExternalStep {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Label,

        [Parameter(Mandatory = $true)]
        [string] $Command,

        [string[]] $Arguments = @()
    )

    Write-Host ''
    Write-Host $Label -ForegroundColor Black -BackgroundColor White
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "failed($exitCode): $Label"
    }
}

function Move-VsixArtifacts {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Destination
    )

    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination | Out-Null
    }

    $vsixFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.vsix' -File)
    if ($vsixFiles.Count -eq 0) {
        throw 'No .vsix files were created.'
    }

    Write-Host ''
    Write-Host 'Move .vsix files to build/' -ForegroundColor Black -BackgroundColor White
    foreach ($file in $vsixFiles) {
        Move-Item -LiteralPath $file.FullName -Destination $Destination -Force
    }
}

Push-Location -LiteralPath $PSScriptRoot
try {
    Invoke-ExternalStep -Label 'npm ci --ignore-scripts' -Command 'npm' -Arguments @('ci', '--ignore-scripts')
    Invoke-ExternalStep -Label 'npm audit --audit-level=moderate' -Command 'npm' -Arguments @('audit', '--audit-level=moderate')
    Invoke-ExternalStep -Label 'npm run check' -Command 'npm' -Arguments @('run', 'check')
    Invoke-ExternalStep -Label 'npm run build' -Command 'npm' -Arguments @('run', 'build')
    Invoke-ExternalStep -Label 'npm run package' -Command 'npm' -Arguments @('run', 'package')
    Invoke-ExternalStep -Label 'npx vsce ls --tree' -Command 'npx' -Arguments @('vsce', 'ls', '--tree')
    Move-VsixArtifacts -Destination (Join-Path -Path $PSScriptRoot -ChildPath 'build')

    Write-Host ''
    Write-Host 'all done!' -ForegroundColor Black -BackgroundColor Green
}
catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor White -BackgroundColor DarkRed
    exit 1
}
finally {
    Pop-Location
}
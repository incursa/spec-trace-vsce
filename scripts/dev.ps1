param(
	[switch]$Watch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repoRoot

function Invoke-NpmRun {
	param(
		[Parameter(Mandatory = $true)]
		[string]$ScriptName
	)

	& npm run $ScriptName
	if ($LASTEXITCODE -ne 0) {
		exit $LASTEXITCODE
	}
}

if (-not $Watch) {
	Invoke-NpmRun -ScriptName 'run-in-browser'
	exit 0
}

$shellCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $shellCommand) {
	$shellCommand = Get-Command powershell -ErrorAction Stop
}

$quotedRepoRoot = $repoRoot.Replace("'", "''")
$watchCommand = "Set-Location -LiteralPath '$quotedRepoRoot'; npm run watch-web"
$watchProcess = Start-Process `
	-FilePath $shellCommand.Source `
	-ArgumentList @('-NoExit', '-Command', $watchCommand) `
	-WorkingDirectory $repoRoot `
	-PassThru

try {
	Invoke-NpmRun -ScriptName 'run-in-browser'
} finally {
	if ($watchProcess -and -not $watchProcess.HasExited) {
		Stop-Process -Id $watchProcess.Id -ErrorAction SilentlyContinue
	}
}

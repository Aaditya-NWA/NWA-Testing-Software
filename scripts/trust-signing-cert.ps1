# trust-signing-cert.ps1 — run ONCE on each operator machine, before the first
# install. Takes under a minute.
#
# Needs: nwa-codesign.cer (the PUBLIC half — never the .pfx) next to this
# script, or passed with -CerPath.
#
# Must be run as Administrator: it writes to the machine-wide trust stores, so
# that Windows trusts installers signed with our certificate.
#
# Two stores, and both are needed:
#   Root             — makes the certificate itself trusted.
#   TrustedPublisher — makes software signed by it install without prompting.
#
# This does NOT weaken the machine generally. It trusts exactly one certificate
# — ours — and nothing else that certificate has not signed.

param(
    [string]$CerPath = (Join-Path $PSScriptRoot "nwa-codesign.cer")
)

$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal] `
          [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Output "This must run as Administrator."
    Write-Output "Right-click PowerShell -> Run as administrator, then run it again."
    exit 1
}

if (-not (Test-Path $CerPath)) {
    Write-Output "Certificate not found: $CerPath"
    Write-Output "Put nwa-codesign.cer beside this script, or pass -CerPath <path>."
    exit 1
}

$c = Import-Certificate -FilePath $CerPath -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath $CerPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

Write-Output ""
Write-Output "Trusted on this machine."
Write-Output "  Subject    : $($c.Subject)"
Write-Output "  Thumbprint : $($c.Thumbprint)"
Write-Output ""
Write-Output "You can now run the NWA Testing Software installer without a"
Write-Output "SmartScreen warning. This step is not needed again on this machine,"
Write-Output "including for future updates."

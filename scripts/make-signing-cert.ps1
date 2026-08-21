# make-signing-cert.ps1 — creates the self-signed code-signing certificate.
#
# Run this ONCE, on one machine, and keep the outputs. Running it again makes a
# DIFFERENT certificate, which every machine would then have to trust all over
# again.
#
# What it produces, in .\certs\ (gitignored):
#   nwa-codesign.pfx  — the private half. Signs installers. SECRET.
#   nwa-codesign.cer  — the public half. Safe to send. This is the file each
#                       operator machine imports once, in trust-signing-cert.ps1.
#
# What this buys: Windows SmartScreen stops warning on the installer, on the
# machines that trust the certificate. It is NOT a commercial certificate and
# is not trusted anywhere else — which is fine for three known machines, and
# is the free option.

param(
    [string]$Subject  = "CN=NWA Testing Software",
    [string]$OutDir   = (Join-Path $PSScriptRoot "..\certs"),
    [int]   $Years    = 5,
    [string]$Password
)

$ErrorActionPreference = "Stop"

if (-not $Password) {
    $secure = Read-Host "Password to protect the .pfx with" -AsSecureString
} else {
    $secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears($Years) `
    -CertStoreLocation "Cert:\CurrentUser\My"

$pfx = Join-Path $OutDir "nwa-codesign.pfx"
$cer = Join-Path $OutDir "nwa-codesign.cer"

Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate   -Cert $cert -FilePath $cer                    | Out-Null

Write-Output ""
Write-Output "Certificate created."
Write-Output "  Thumbprint : $($cert.Thumbprint)"
Write-Output "  Expires    : $($cert.NotAfter)"
Write-Output "  Private    : $pfx   (SECRET — never commit, never email)"
Write-Output "  Public     : $cer   (send this to each operator machine)"
Write-Output ""
Write-Output "Next:"
Write-Output "  1. Put the thumbprint in src-tauri/tauri.conf.json as"
Write-Output "     bundle.windows.certificateThumbprint, OR set the env var"
Write-Output "     TAURI_WINDOWS_CERTIFICATE_THUMBPRINT before 'npm run build'."
Write-Output "  2. Run scripts/trust-signing-cert.ps1 once on each of the three"
Write-Output "     operator machines, with nwa-codesign.cer beside it."
Write-Output ""
Write-Output "For GitHub Actions signing, add these repository secrets:"
Write-Output "  WINDOWS_CERTIFICATE          = base64 of the .pfx"
Write-Output "  WINDOWS_CERTIFICATE_PASSWORD = the password you just chose"
Write-Output ""
Write-Output "To produce that base64:"
Write-Output "  [Convert]::ToBase64String([IO.File]::ReadAllBytes('$pfx')) | Set-Clipboard"

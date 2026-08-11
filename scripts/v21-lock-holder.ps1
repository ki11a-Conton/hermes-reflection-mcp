param(
  [Parameter(Mandatory = $true)]
  [string]$LockPath,
  [Parameter(Mandatory = $true)]
  [string]$Token
)

$stream = [System.IO.File]::Open(
  $LockPath,
  [System.IO.FileMode]::Create,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  $payload = [System.Text.Encoding]::UTF8.GetBytes(
    (@{ schema_version = 1; pid = $PID; token = $Token } | ConvertTo-Json -Compress)
  )
  $stream.Write($payload, 0, $payload.Length)
  $stream.Flush($true)
  [Console]::Out.WriteLine("READY")
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally {
  $stream.Dispose()
}

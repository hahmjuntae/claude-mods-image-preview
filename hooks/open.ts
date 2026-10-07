// IDE MCP 서버에 openFile 한 번 보내는 웹소켓 클라이언트, 명령줄 따옴표 깨짐 방지로 큰따옴표 없음
const IDE_SCRIPT = [
  '& { param($port, $lock, $file)',
  "$ErrorActionPreference = 'Stop';",
  '$token = (Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json).authToken;',
  '$ws = New-Object System.Net.WebSockets.ClientWebSocket;',
  "$ws.Options.AddSubProtocol('mcp');",
  "$ws.Options.SetRequestHeader('x-claude-code-ide-authorization', $token);",
  '$none = [Threading.CancellationToken]::None;',
  "if (-not $ws.ConnectAsync([Uri]('ws://127.0.0.1:' + $port), $none).Wait(3000)) { exit 1 };",
  '$buffer = New-Object byte[] 65536;',
  'function Send($message) { $bytes = [Text.Encoding]::UTF8.GetBytes(($message | ConvertTo-Json -Compress -Depth 6)); [void]$ws.SendAsync([ArraySegment[byte]]$bytes, 0, $true, $none).Wait(3000) };',
  "function Receive { $text = ''; do { $task = $ws.ReceiveAsync([ArraySegment[byte]]$buffer, $none); if (-not $task.Wait(5000)) { exit 1 }; $text += [Text.Encoding]::UTF8.GetString($buffer, 0, $task.Result.Count) } until ($task.Result.EndOfMessage); $text | ConvertFrom-Json };",
  "Send @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'mods-image-preview'; version = '1' } } };",
  'do { $reply = Receive } until ($reply.id -eq 1);',
  "Send @{ jsonrpc = '2.0'; method = 'notifications/initialized' };",
  "Send @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{ name = 'openFile'; arguments = @{ filePath = $file; preview = $true; makeFrontmost = $false } } };",
  'do { $reply = Receive } until ($reply.id -eq 2);',
  "[void]$ws.CloseAsync(1000, '', $none).Wait(1000);",
  'if ($reply.error -or $reply.result.isError) { exit 1 } }',
].join(' ')

export function ideCommand(port: string, lock: string, file: string): string[] {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

  return ['powershell', '-NoProfile', '-NonInteractive', '-Command', `${IDE_SCRIPT} ${quote(port)} ${quote(lock)} ${quote(file)}`]
}

export function viewerCommands(file: string, isWindows: boolean): string[][] {
  return isWindows ? [['explorer', file.replace(/\//g, '\\')]] : [['xdg-open', file], ['open', file]]
}

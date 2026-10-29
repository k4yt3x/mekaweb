# Installing mekaweb

mekaweb runs on the meka host, beside meka. meka listens on loopback only; mekaweb signs you in, serves the interface, and passes your requests to meka with its token. Only mekaweb is reachable from your network or the internet, through a TLS proxy or a tunnel in front of it.

```
browser ──HTTPS──▶ Cloudflare Tunnel or Caddy ──▶ mekaweb (loopback) ──▶ meka serve (loopback)
```

mekaweb runs on Linux, macOS and Windows. Each release states which meka versions it supports; this one needs meka 0.85.0 or newer. The steps show Linux and macOS commands, with Windows' where they differ.

## 1. Get mekaweb

Download the binary for your machine from the [releases](https://github.com/k4yt3x/mekaweb/releases): `mekaweb-x86_64-linux`, `mekaweb-aarch64-linux`, `mekaweb-aarch64-macos` for Apple silicon, or `mekaweb-x86_64-windows.exe`. Check its checksum against `SHA256SUMS`, and put it where the service you choose in step 5 runs it from: `/usr/local/bin` for a system unit or on macOS, `~/.local/bin` for a user unit.

```sh
sudo install -m 755 mekaweb-x86_64-linux /usr/local/bin/mekaweb
```

On macOS, download it with `curl -LO`: a binary downloaded in a browser is quarantined, and runs only after `xattr -d com.apple.quarantine` on it. On Windows, put it in a folder of its own as `mekaweb.exe`:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Programs\mekaweb" | Out-Null
Move-Item mekaweb-x86_64-windows.exe "$env:LOCALAPPDATA\Programs\mekaweb\mekaweb.exe"
Unblock-File "$env:LOCALAPPDATA\Programs\mekaweb\mekaweb.exe"
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', "$path;$env:LOCALAPPDATA\Programs\mekaweb", 'User')
```

A new PowerShell then runs it as `mekaweb`.

Or build it: install Node.js 24 and the Rust toolchain, then

```sh
(cd web && npm ci && npm run build)
cargo build --release --locked
sudo install -m 755 target/release/mekaweb /usr/local/bin/mekaweb
```

The interface is built into the binary, so build `web/` first. With [just](https://github.com/casey/just), `just build` does both. On Windows, building the bundled OpenSSL needs Perl, such as Strawberry Perl. A binary built on another machine needs a glibc at least as new as that machine's; `cargo build --release --locked --target x86_64-unknown-linux-musl`, with `musl-tools` installed and the target added (`rustup target add x86_64-unknown-linux-musl`), builds one that runs on any Linux, as the releases are.

## 2. Give mekaweb a meka token

Make a token mekaweb alone holds, readable only by the user meka and mekaweb run as:

```sh
mkdir -p ~/.config/mekaweb
head -c 32 /dev/urandom | base64 | tr -d '/+=' > ~/.config/mekaweb/meka-token
chmod 600 ~/.config/mekaweb/meka-token
```

On Windows, in PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\mekaweb" | Out-Null
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes) -replace '[/+=]', '' | Set-Content -NoNewline "$env:APPDATA\mekaweb\meka-token"
```

Add it to meka's `config.toml` with every scope, and keep meka on loopback. meka reads the same file, at its absolute path, and warns unless only its owner can read it. mekaweb is meka's only client, so meka needs no CORS origins:

```toml
[serve]
bind = "127.0.0.1:8080"

[[serve.tokens]]
token_file = "/home/<you>/.config/mekaweb/meka-token"
description = "mekaweb"
scopes = [
  "sessions:r", "sessions:w",
  "memory:r", "memory:w",
  "skills:r", "skills:w",
  "schedule:r", "schedule:w",
  "mcp:r", "mcp:w",
  "config:r", "config:w",
]
```

`config:w` lets mekaweb add accounts, profiles and MCP servers; an MCP server's command runs as meka's user. A meka with no profile yet can be set up from **Providers** once mekaweb runs.

## 3. Configure mekaweb

Copy [`config/mekaweb.toml`](../config/mekaweb.toml) to `~/.config/mekaweb/config.toml`, or `%APPDATA%\mekaweb\config.toml` on Windows, and set the following, uncommenting the optional ones you use. Write a Windows path in single quotes, `'C:\Users\you\AppData\Roaming\mekaweb\meka-token'`: in double quotes a backslash starts an escape.

- `public_origin`: the address you open mekaweb at, such as `https://meka.example.com`. Passkeys work only on this hostname, so use the same name at home and away (see [one hostname](#one-hostname)).
- `meka.url`: meka's loopback address.
- `meka.token_file`: the token file from step 2, which mekaweb reads again every minute and whenever meka refuses the token, so changing it needs no restart. Or write the token itself as `meka.token`; mekaweb then warns unless only its owner can read the config.
- `push.subject`: a `mailto:` or `https:` address push services can reach you at. Apple refuses anything else. Without it, push notifications are off.

Check it:

```sh
mekaweb check
```

## 4. Add yourself

mekaweb has one user. Add them, choosing a password of at least 10 characters:

```sh
mekaweb user add <username>
```

After signing in, add a passkey in **Settings → Passkeys**. `mekaweb user passwd` sets a forgotten password and signs every device out, unless given `--keep-devices`; `mekaweb user reset-passkeys` removes lost passkeys and signs every device out. A running mekaweb ends those devices' open connections within a minute.

## 5. Run mekaweb as a service

meka runs as its own service, set up as [meka's documentation](https://github.com/k4yt3x/meka) describes, so restarting or upgrading mekaweb never interrupts a turn. Run mekaweb as the user meka runs as: Files and the terminal act as that user, and it reads the same token file. On Linux either unit works:

- **A system unit**, [`deploy/system/mekaweb.service`](../deploy/system/mekaweb.service), starts at boot like the system's other services. Set `User=` and `Group=`, and the binary's path if it is not `/usr/local/bin/mekaweb`, then:

  ```sh
  sudo cp deploy/system/mekaweb.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now mekaweb
  ```

  Its processes have no user session, so `systemctl --user` fails in its terminal. Uncomment `XDG_RUNTIME_DIR` with the user's id, and run `loginctl enable-linger <user>` so the folder it names is always there.

- **A user unit**, [`deploy/user/mekaweb.service`](../deploy/user/mekaweb.service), runs from `~/.local/bin/mekaweb` in your own service manager:

  ```sh
  cp deploy/user/mekaweb.service ~/.config/systemd/user/
  loginctl enable-linger
  systemctl --user daemon-reload
  systemctl --user enable --now mekaweb
  ```

  `enable-linger` starts your services at boot and keeps them running without a login session.

On **macOS**, the launch agent [`deploy/macos/com.github.k4yt3x.mekaweb.plist`](../deploy/macos/com.github.k4yt3x.mekaweb.plist) runs mekaweb while you are logged in. Set your username in its log path, and the binary's path if it is not `/usr/local/bin/mekaweb`, then:

```sh
cp deploy/macos/com.github.k4yt3x.mekaweb.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.github.k4yt3x.mekaweb.plist
```

On **Windows**, a scheduled task starts mekaweb at boot, as you, without a window. Register it in an administrator PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "$env:LOCALAPPDATA\Programs\mekaweb\mekaweb.exe" -Argument serve
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask mekaweb -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Start-ScheduledTask mekaweb
```

Its terminals run PowerShell unless `terminal.shell` names another shell.

## 6. Reach it over HTTPS

Browsers offer passkeys, secure cookies, and push notifications only over HTTPS (or on `localhost`).

**Cloudflare Tunnel** reaches a home server without opening a port, with a certificate every device trusts. With `cloudflared` installed and logged in:

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel id>
credentials-file: /home/<you>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: meka.example.com
    service: http://127.0.0.1:8090
  - service: http_status:404
```

Event streams and the terminal's WebSocket pass through the tunnel. meka sends a keep-alive every 20 seconds and mekaweb pings each terminal every 30, well inside Cloudflare's 100-second idle limit. Cloudflare allows request bodies of 100 MB on its free plan; Files uploads in 8 MiB pieces, so larger files upload too. Cloudflare Access can add another sign-in in front, but mekaweb does not need it.

**Caddy** on your LAN serves the same name with a certificate from Cloudflare's DNS challenge:

```
meka.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:8090
}
```

Add the proxy's address to `trusted_proxies` so the sign-in log and rate limits see each client's address rather than the proxy's. mekaweb reads it from `X-Forwarded-For`, taking the last address there that is not a trusted proxy's, which is the one the nearest proxy saw. It does not read `CF-Connecting-IP`: a proxy that does not set that header passes on whatever a client sent.

### One hostname

A passkey belongs to the hostname it was made on. Reach mekaweb by the same name everywhere: through the tunnel away from home, and through Caddy at home, with your LAN's DNS answering that name with the server's address.

## 7. Install it on your phone

Open the address in Safari, choose **Share → Add to Home Screen**, and open mekaweb from the Home Screen. Sign in, then turn on **Settings → Notifications → Push notifications** there: iOS offers push notifications only to apps on the Home Screen, and asks for permission when you tap the switch. The app's storage is separate from Safari's, so it signs in on its own.

## Upgrading

Install the new binary and restart mekaweb: `systemctl --user restart mekaweb`, or `sudo systemctl restart mekaweb` for a system unit; `launchctl kickstart -k gui/$(id -u)/com.github.k4yt3x.mekaweb` on macOS; `Stop-ScheduledTask mekaweb` before replacing the binary and `Start-ScheduledTask mekaweb` after on Windows. Its release notes say which meka versions it supports; upgrade meka when they ask, and **Settings** says whether the two match.

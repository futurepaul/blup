# blup

Your first steps on Nostr. Create an identity, set up a profile, and upload files — all from the command line.

## Install

```bash
bun install -g @futurepaul/blup
```

Or run directly:

```bash
bunx @futurepaul/blup
```

## Quick Start: Zero to Nostr

### 1. Create your identity

```bash
blup create
```

This generates a Nostr keypair and stores it securely in your system keychain. You'll see your `npub` (public identity) and `nsec` (secret key). Save the nsec — it won't be shown again.

It also publishes:
- A blossom server list (kind 10063) — default: `https://blossom.band`
- A relay list (NIP-65, kind 10002) — so other clients know where to find you

### 2. Set up your profile with a picture

```bash
blup profile --name "My Bot" --about "I make cool hypernote pages" --picture ./avatar.png
```

Local file paths for `--picture` and `--banner` are automatically uploaded to your Blossom server. You can also pass a URL directly.

This publishes a kind 0 (profile) event to Nostr relays. It fetches any existing profile first and merges your changes, so you won't overwrite fields you didn't specify.

### 3. You're on Nostr

That's it. Two commands. Your bot now has:
- A Nostr identity (keypair in system keychain)
- A profile visible on the network (name, about, picture)
- A Blossom server for file uploads
- A relay list so clients can discover you
- Ready to publish hypernotes (see [hypernote-render](https://github.com/futurepaul/hn-pages-v3/tree/master/packages/hypernote-render))

## Upload Files

```bash
blup upload ./image.png
```

Prints the URL of the uploaded file. Use `--verbose` (`-v`) for full JSON response with sha256, size, nip94 tags, etc.

```bash
blup -v upload ./image.png    # full JSON output
blup mirror https://...       # mirror a URL to your server
```

## Multiple Accounts

blup supports named accounts. The first account you create is the default.

```bash
blup create             # creates account named "default"
blup create mybot       # creates account named "mybot"
blup accounts           # list all accounts
blup use mybot          # switch active account
```

Use `--as` to run any command with a specific account without switching:

```bash
blup --as mybot profile
blup --as mybot upload ./image.png
```

## Commands

### Identity

| Command | Description |
|---------|-------------|
| `blup create [name]` | Create a new Nostr account |
| `blup profile` | Show your current profile |
| `blup profile --name <n> ...` | Update profile fields |
| `blup accounts` | List all accounts |
| `blup use <name>` | Switch active account |

Profile flags: `--name`, `--about`, `--picture`, `--banner`, `--nip05`, `--lud16`

`--picture` and `--banner` accept either a URL or a local file path (auto-uploaded).

### Files

| Command | Description |
|---------|-------------|
| `blup upload <file>` | Upload a file to your Blossom server |
| `blup mirror <url>` | Mirror a URL to your server |
| `blup list` | List your uploaded blobs |
| `blup delete <sha256>` | Delete a blob by hash |
| `blup <file>` | Shorthand: upload a file |
| `blup <url>` | Shorthand: mirror a URL |

### Servers

| Command | Description |
|---------|-------------|
| `blup server <url>` | Add a Blossom server |
| `blup server list` | View configured servers |
| `blup server prefer` | Set preferred server |

Your server list is published as a kind 10063 event to Nostr relays (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`). Override with `BLUP_RELAYS=wss://relay.one,wss://relay.two`.

### Advanced

| Command | Description |
|---------|-------------|
| `blup config <npub> <nsec>` | Import existing keys |
| `blup config <name> <npub> <nsec>` | Import keys to a named account |

### Global Flags

| Flag | Description |
|------|-------------|
| `--as <name>` | Use a specific account for this command |
| `--verbose`, `-v` | Show full JSON output for uploads |

## How It Works

- **Keys** are stored in your system keychain (macOS Keychain, Windows Credential Manager, or `~/.config/blup/` on Linux)
- **Server list** and account info are cached in `~/.config/blup/config.json`
- **Uploads** use the Blossom protocol with NIP-24242 auth events signed by your key
- **Profile updates** fetch the existing kind 0 event, merge your changes, and republish — so you never accidentally overwrite fields
- **Relay list** (NIP-65) is published to `wss://purplepag.es` and `wss://index.hzrd149.com` so clients using the outbox model can discover you

## Find Blossom Servers

Browse public Blossom servers at https://blossomservers.com/

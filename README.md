# up

A simple CLI for uploading and listing files on [Blossom](https://github.com/hzrd149/blossom) servers.

## Quick start

```bash
bunx github:futurepaul/up
```

## Install

```bash
bun install -g github:futurepaul/up
```

## Usage

### Configure

Set up your Nostr keys (stored in the system keychain):

```bash
up config <npub> <nsec>
```

Example:
```bash
up config npub1... nsec1...
```

### Server list

Blossom best practices encourage keeping an ordered list of trusted upload servers. `up` publishes (and subsequently reads) this list as a nostr `kind:10063` server-list event. By default the event is synced with `wss://relay.damus.io`, `wss://nos.lol`, and `wss://relay.primal.net`; override this set with `UP_RELAYS=wss://relay.one,wss://relay.two`. Run `config` first so `up` can sign the event with your key. When you list or upload, `up` fetches the latest published list from those relays (prompting you only when no list exists yet).

Add a server (or create the list if it does not exist):

```bash
up server <server-url>
```

Example:
```bash
up server https://blossom.primal.net
```

View the configured servers (first entry is the primary upload target):

```bash
up server list
```

Set a different server as preferred:

```bash
up server prefer
```

### List files

List your uploaded blobs on your preferred server:

```bash
up list
```

### Upload

Upload a file to your preferred server:

```bash
up upload <filename>
```

Example:
```bash
up upload ./image.png
```

### Mirror

Mirror an existing URL (Blossom or not) to your preferred server. If a server supports `/mirror`, it will fetch directly; otherwise `up` downloads the source blob and reuploads it.

```bash
up mirror <url>
```

### Blossom servers

Find more Blossom servers at https://blossomservers.com/

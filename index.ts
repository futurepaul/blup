#!/usr/bin/env bun

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { decode, nsecEncode, npubEncode } from "nostr-tools/nip19";
import { SimplePool } from "nostr-tools/pool";
import { secrets } from "bun";
import os from "os";
import path from "path";

const SERVICE_NAME = "com.blossom.blup";
const DEFAULT_BLOSSOM_SERVER = "https://blossom.band";

// ---------------------------------------------------------------------------
// Config file handling
// ---------------------------------------------------------------------------

interface CachedConfig {
  servers: string[];
  accounts: string[];
  activeAccount: string;
}

function getConfigDir(): string {
  const platform = os.platform();

  if (platform === "win32") {
    const appData = Bun.env.APPDATA || Bun.env.LOCALAPPDATA;
    if (!appData) throw new Error("APPDATA/LOCALAPPDATA not set");
    return path.join(appData, "blup");
  }

  const home = os.homedir();
  const xdgConfigHome = Bun.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdgConfigHome, "blup");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

async function loadCachedConfig(): Promise<CachedConfig> {
  const configPath = getConfigPath();
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return { servers: [], accounts: [], activeAccount: "" };
  }
  try {
    const raw = await file.json();
    return {
      servers: raw.servers || [],
      accounts: raw.accounts || [],
      activeAccount: raw.activeAccount || "",
    };
  } catch {
    return { servers: [], accounts: [], activeAccount: "" };
  }
}

async function saveCachedConfig(config: CachedConfig): Promise<void> {
  const configDir = getConfigDir();
  await Bun.$`mkdir -p ${configDir}`.quiet();
  const configPath = getConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function renderProgress(loaded: number, total?: number, width = 30): string {
  if (total) {
    const ratio = Math.min(loaded / total, 1);
    const filled = Math.round(ratio * width);
    const empty = width - filled;
    const pct = (ratio * 100).toFixed(0).padStart(3);
    return `[${"=".repeat(filled)}${" ".repeat(empty)}] ${pct}% ${formatBytes(loaded)}/${formatBytes(total)}`;
  }
  return `${formatBytes(loaded)}`;
}

// ---------------------------------------------------------------------------
// Relay pool
// ---------------------------------------------------------------------------

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const LOOKUP_RELAYS = [
  "wss://purplepag.es",
  "wss://index.hzrd149.com",
];

let pool: SimplePool | undefined;

function getPool(): SimplePool {
  if (!pool) {
    pool = new SimplePool();
  }
  return pool;
}

function getRelays(): string[] {
  const envRelays = Bun.env.BLUP_RELAYS;
  if (envRelays) {
    return envRelays.split(",").map((r) => r.trim());
  }
  return DEFAULT_RELAYS;
}

// ---------------------------------------------------------------------------
// Account management
// ---------------------------------------------------------------------------

let globalAccountOverride: string | undefined;
let globalVerbose = false;

async function getActiveAccount(): Promise<string> {
  if (globalAccountOverride) return globalAccountOverride;

  const config = await loadCachedConfig();
  if (config.activeAccount) return config.activeAccount;
  if (config.accounts.length > 0) return config.accounts[0]!;

  // Try legacy migration: old-style keys stored without account prefix
  const legacyNsec = await secrets.get({ service: SERVICE_NAME, name: "nsec" });
  if (legacyNsec) {
    const legacyNpub = await secrets.get({
      service: SERVICE_NAME,
      name: "npub",
    });
    if (legacyNpub) {
      await secrets.set({
        service: SERVICE_NAME,
        name: "default.nsec",
        value: legacyNsec,
      });
      await secrets.set({
        service: SERVICE_NAME,
        name: "default.npub",
        value: legacyNpub,
      });
      config.accounts = ["default"];
      config.activeAccount = "default";
      await saveCachedConfig(config);
      console.log("Migrated existing keys to account 'default'");
      return "default";
    }
  }

  return "";
}

async function getNsec(): Promise<string> {
  const account = await getActiveAccount();
  if (!account) {
    console.error("Error: No account found. Run 'blup create' first.");
    process.exit(1);
  }

  const nsec = await secrets.get({
    service: SERVICE_NAME,
    name: `${account}.nsec`,
  });
  if (!nsec) {
    console.error(`Error: No nsec found for account '${account}'.`);
    process.exit(1);
  }
  return nsec;
}

async function getNpub(): Promise<string> {
  const account = await getActiveAccount();
  if (!account) {
    console.error("Error: No account found. Run 'blup create' first.");
    process.exit(1);
  }

  const npub = await secrets.get({
    service: SERVICE_NAME,
    name: `${account}.npub`,
  });
  if (!npub) {
    console.error(`Error: No npub found for account '${account}'.`);
    process.exit(1);
  }
  return npub;
}

function decodeSecretKey(nsec: string): Uint8Array {
  const decoded = decode(nsec);
  if (decoded.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }
  return decoded.data;
}

function decodePubkey(npub: string): string {
  const decoded = decode(npub);
  if (decoded.type !== "npub") {
    console.error("Error: stored npub is invalid");
    process.exit(1);
  }
  return decoded.data;
}

// ---------------------------------------------------------------------------
// Server list management
// ---------------------------------------------------------------------------

async function fetchServerList(pubkey: string): Promise<string[]> {
  const relays = getRelays();

  const event = await getPool().get(relays, {
    kinds: [10063],
    authors: [pubkey],
  });

  if (!event) {
    return [];
  }

  return event.tags
    .filter(
      (t): t is [string, string, ...string[]] =>
        t[0] === "server" && typeof t[1] === "string"
    )
    .map((t) => t[1]);
}

async function publishServerList(
  secretKey: Uint8Array,
  servers: string[]
): Promise<void> {
  const relays = getRelays();

  const tags = servers.map((s) => ["server", s]);

  const event = finalizeEvent(
    {
      kind: 10063,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
    secretKey
  );

  await Promise.any(getPool().publish(relays, event));
}

async function publishRelayList(
  secretKey: Uint8Array,
  relays: string[]
): Promise<void> {
  const tags = relays.map((r) => ["r", r]);

  const event = finalizeEvent(
    {
      kind: 10002,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
    secretKey
  );

  // Publish to both default relays and lookup relays
  const publishRelays = [...getRelays(), ...LOOKUP_RELAYS];
  const unique = [...new Set(publishRelays)];
  await Promise.any(getPool().publish(unique, event));
}

async function getServers(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh) {
    const cached = await loadCachedConfig();
    if (cached.servers.length > 0) {
      return cached.servers;
    }
  }

  const npub = await getNpub();
  const pubkey = decodePubkey(npub);
  const servers = await fetchServerList(pubkey);

  if (servers.length > 0) {
    const config = await loadCachedConfig();
    config.servers = servers;
    await saveCachedConfig(config);
  }

  return servers;
}

async function getPreferredServer(): Promise<string> {
  const servers = await getServers();
  if (servers.length === 0) {
    console.error(
      "Error: No servers configured. Run 'blup server <url>' first."
    );
    process.exit(1);
  }

  return servers[0] as string;
}

// ---------------------------------------------------------------------------
// Auth event creation
// ---------------------------------------------------------------------------

function createAuthEvent(
  secretKey: Uint8Array,
  type: "list" | "upload" | "delete",
  sha256Hash?: string
) {
  const expiration = Math.floor(Date.now() / 1000) + 60;

  const tags: string[][] = [
    ["t", type],
    ["expiration", expiration.toString()],
  ];

  if (sha256Hash) {
    tags.push(["x", sha256Hash]);
  }

  const contentMap = {
    list: "List Blobs",
    upload: "Upload Blob",
    delete: "Delete Blob",
  };

  const event = finalizeEvent(
    {
      kind: 24242,
      content: contentMap[type],
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
    secretKey
  );

  return event;
}

// ---------------------------------------------------------------------------
// Blossom operations
// ---------------------------------------------------------------------------

async function listBlobs(serverUrl: string): Promise<void> {
  const nsec = await getNsec();
  const npub = await getNpub();

  const secretKey = decodeSecretKey(nsec);
  const pubkey = decodePubkey(npub);

  const authEvent = createAuthEvent(secretKey, "list");
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const url = `${serverUrl.replace(/\/$/, "")}/list/${pubkey}?limit=10`;

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error ${response.status}: ${error}`);
    process.exit(1);
  }

  const blobs = await response.json();
  console.log(JSON.stringify(blobs, null, 2));
}

async function deleteBlob(serverUrl: string, sha256: string): Promise<void> {
  const nsec = await getNsec();

  const secretKey = decodeSecretKey(nsec);

  const authEvent = createAuthEvent(secretKey, "delete", sha256);
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const url = `${serverUrl.replace(/\/$/, "")}/${sha256}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: authHeader,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.text();
      console.error(`Error ${response.status}: ${error}`);
      process.exit(1);
    }

    await response.text();
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === "AbortError") {
      console.log(`Delete request sent for ${sha256}`);
      return;
    }
    throw e;
  }

  console.log(`Deleted ${sha256}`);
}

async function uploadBytes(
  serverUrl: string,
  bytes: Uint8Array,
  contentType: string
): Promise<{ url: string; sha256: string; size: number; type: string }> {
  const nsec = await getNsec();

  const secretKey = decodeSecretKey(nsec);

  const hash = new Bun.SHA256().update(bytes).digest("hex");
  const total = bytes.length;

  const authEvent = createAuthEvent(secretKey, "upload", hash);
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const url = `${serverUrl.replace(/\/$/, "")}/upload`;

  // BUD-06: Preflight check with HEAD request
  const preflightResponse = await fetch(url, {
    method: "HEAD",
    headers: {
      Authorization: authHeader,
      "X-SHA-256": hash,
      "X-Content-Type": contentType,
      "X-Content-Length": total.toString(),
    },
  });

  if (!preflightResponse.ok && preflightResponse.status !== 404) {
    const reason = preflightResponse.headers.get("X-Reason");
    if (reason) {
      console.error(`Upload rejected: ${reason}`);
    } else {
      console.error(`Upload rejected: ${preflightResponse.status}`);
    }
    process.exit(1);
  }

  // Create a streaming body with progress
  let loaded = 0;
  const chunkSize = 64 * 1024;

  const progressStream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      const pushChunk = () => {
        if (offset >= total) {
          controller.close();
          process.stdout.write("\r" + renderProgress(total, total) + "\n");
          return;
        }
        const chunk = bytes.slice(offset, offset + chunkSize);
        offset += chunk.length;
        loaded += chunk.length;
        process.stdout.write("\r" + renderProgress(loaded, total));
        controller.enqueue(chunk);
        setTimeout(pushChunk, 0);
      };
      pushChunk();
    },
  });

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": contentType,
      "Content-Length": total.toString(),
    },
    body: progressStream,
    duplex: "half",
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error ${response.status}: ${error}`);
    process.exit(1);
  }

  const blob = await response.json();
  return blob;
}

async function uploadBlob(
  serverUrl: string,
  filePath: string
): Promise<{ url: string; sha256: string; size: number; type: string }> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const fileBuffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(fileBuffer);
  const contentType = file.type || "application/octet-stream";

  console.log(`Uploading ${filePath}...`);
  const blob = await uploadBytes(serverUrl, fileBytes, contentType);
  if (globalVerbose) {
    console.log(JSON.stringify(blob, null, 2));
  } else {
    console.log(blob.url);
  }
  return blob;
}

async function mirrorBlob(sourceUrl: string): Promise<void> {
  const nsec = await getNsec();
  const serverUrl = await getPreferredServer();

  const secretKey = decodeSecretKey(nsec);

  const mirrorUrl = `${serverUrl.replace(/\/$/, "")}/mirror`;

  const authEvent = createAuthEvent(secretKey, "upload");
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const mirrorResponse = await fetch(mirrorUrl, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: sourceUrl }),
  });

  if (mirrorResponse.ok) {
    const blob = await mirrorResponse.json();
    if (globalVerbose) {
      console.log(JSON.stringify(blob, null, 2));
    } else {
      console.log(blob.url);
    }
    return;
  }

  if (mirrorResponse.status === 404) {
    console.log(
      "Server does not support /mirror, downloading and reuploading..."
    );
  } else {
    const error = await mirrorResponse.text();
    console.log(
      `Mirror failed (${mirrorResponse.status}: ${error}), downloading and reuploading...`
    );
  }

  const sourceResponse = await fetch(sourceUrl);
  if (!sourceResponse.ok || !sourceResponse.body) {
    console.error(`Error fetching source: ${sourceResponse.status}`);
    process.exit(1);
  }

  const contentType =
    sourceResponse.headers.get("Content-Type") || "application/octet-stream";
  const contentLength = sourceResponse.headers.get("Content-Length");
  const total = contentLength ? parseInt(contentLength, 10) : undefined;

  console.log("Downloading...");
  const reader = sourceResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    process.stdout.write("\r" + renderProgress(loaded, total));
  }
  process.stdout.write("\r" + renderProgress(loaded, loaded) + "\n");

  const fileBytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    fileBytes.set(chunk, offset);
    offset += chunk.length;
  }

  console.log("Uploading...");
  const blob = await uploadBytes(serverUrl, fileBytes, contentType);
  if (globalVerbose) {
    console.log(JSON.stringify(blob, null, 2));
  } else {
    console.log(blob.url);
  }
}

// ---------------------------------------------------------------------------
// Account commands
// ---------------------------------------------------------------------------

async function createAccount(name?: string): Promise<void> {
  const accountName = name || "default";
  const config = await loadCachedConfig();

  if (config.accounts.includes(accountName)) {
    console.error(`Error: Account '${accountName}' already exists.`);
    console.error("Use 'blup accounts' to see existing accounts.");
    process.exit(1);
  }

  // Generate keypair
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nsec = nsecEncode(sk);
  const npub = npubEncode(pk);

  // Store in keychain
  await secrets.set({
    service: SERVICE_NAME,
    name: `${accountName}.nsec`,
    value: nsec,
  });
  await secrets.set({
    service: SERVICE_NAME,
    name: `${accountName}.npub`,
    value: npub,
  });

  // Update config
  config.accounts.push(accountName);
  if (!config.activeAccount) {
    config.activeAccount = accountName;
  }

  // Add default blossom server if none configured
  if (config.servers.length === 0) {
    config.servers = [DEFAULT_BLOSSOM_SERVER];
  }

  await saveCachedConfig(config);

  // Publish initial events to the network
  console.log("Publishing to relays...");
  const publishResults = { serverList: false, relayList: false };
  try {
    await publishServerList(sk, config.servers);
    publishResults.serverList = true;
  } catch {
    // non-fatal
  }
  try {
    await publishRelayList(sk, DEFAULT_RELAYS);
    publishResults.relayList = true;
  } catch {
    // non-fatal
  }

  console.log(`Account '${accountName}' created`);
  console.log(`npub: ${npub}`);
  console.log(`nsec: ${nsec}`);
  console.log("");
  console.log("Save your nsec somewhere safe. It won't be shown again.");
  console.log(`Default blossom server: ${DEFAULT_BLOSSOM_SERVER}`);
  if (publishResults.relayList) {
    console.log(`Relay list (NIP-65) published to ${LOOKUP_RELAYS.join(", ")}`);
  } else {
    console.log("Note: Could not publish relay list (non-fatal)");
  }
}

async function configure(
  first: string,
  second: string,
  third?: string
): Promise<void> {
  let accountName: string;
  let npub: string;
  let nsec: string;

  if (third) {
    // blup config <name> <npub> <nsec>
    accountName = first;
    npub = second;
    nsec = third;
  } else {
    // blup config <npub> <nsec>
    accountName = "default";
    npub = first;
    nsec = second;
  }

  const publicKey = decode(npub);
  if (publicKey.type !== "npub") {
    console.error(
      third
        ? "Error: second argument must be a valid npub"
        : "Error: first argument must be a valid npub"
    );
    process.exit(1);
  }

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: last argument must be a valid nsec");
    process.exit(1);
  }

  await secrets.set({
    service: SERVICE_NAME,
    name: `${accountName}.nsec`,
    value: nsec,
  });
  await secrets.set({
    service: SERVICE_NAME,
    name: `${accountName}.npub`,
    value: npub,
  });

  const config = await loadCachedConfig();
  if (!config.accounts.includes(accountName)) {
    config.accounts.push(accountName);
  }
  if (!config.activeAccount) {
    config.activeAccount = accountName;
  }
  await saveCachedConfig(config);

  console.log(
    `Credentials for '${accountName}' stored in system keychain`
  );
}

async function listAccounts(): Promise<void> {
  const config = await loadCachedConfig();
  if (config.accounts.length === 0) {
    console.log("No accounts. Run 'blup create' to create one.");
    return;
  }

  console.log("Accounts:");
  for (const account of config.accounts) {
    const marker = account === config.activeAccount ? " (active)" : "";
    const npub = await secrets.get({
      service: SERVICE_NAME,
      name: `${account}.npub`,
    });
    console.log(`  ${account}${marker}: ${npub || "unknown"}`);
  }
}

async function useAccount(name: string): Promise<void> {
  const config = await loadCachedConfig();
  if (!config.accounts.includes(name)) {
    console.error(`Error: Account '${name}' not found.`);
    console.error("Run 'blup accounts' to see available accounts.");
    process.exit(1);
  }

  config.activeAccount = name;
  await saveCachedConfig(config);
  console.log(`Switched to account '${name}'`);
}

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

interface ProfileMetadata {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  [key: string]: string | undefined;
}

async function fetchProfile(pubkey: string): Promise<ProfileMetadata | null> {
  const relays = getRelays();
  const event = await getPool().get(relays, {
    kinds: [0],
    authors: [pubkey],
  });
  if (!event) return null;
  try {
    return JSON.parse(event.content);
  } catch {
    return null;
  }
}

async function updateProfile(updates: ProfileMetadata): Promise<void> {
  const nsec = await getNsec();
  const npub = await getNpub();

  const secretKey = decodeSecretKey(nsec);
  const pubkey = decodePubkey(npub);

  // Auto-upload local files for picture and banner
  for (const field of ["picture", "banner"] as const) {
    const value = updates[field];
    if (value && !value.startsWith("http://") && !value.startsWith("https://")) {
      const file = Bun.file(value);
      if (await file.exists()) {
        const serverUrl = await getPreferredServer();
        console.log(`Uploading ${field}: ${value}...`);
        const blob = await uploadBytes(serverUrl, new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream");
        updates[field] = blob.url;
        console.log(`Uploaded: ${blob.url}`);
      } else {
        console.error(`Error: File not found: ${value}`);
        process.exit(1);
      }
    }
  }

  // Fetch existing profile first (don't overwrite)
  console.log("Fetching existing profile...");
  const existing = (await fetchProfile(pubkey)) || {};

  // Merge: only set fields that were explicitly provided
  const merged: ProfileMetadata = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  const event = finalizeEvent(
    {
      kind: 0,
      content: JSON.stringify(merged),
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
    },
    secretKey
  );

  const relays = getRelays();
  await Promise.any(getPool().publish(relays, event));

  console.log("Profile updated");
  printProfile(merged);
}

function printProfile(profile: ProfileMetadata): void {
  if (profile.name) console.log(`  Name:      ${profile.name}`);
  if (profile.about) console.log(`  About:     ${profile.about}`);
  if (profile.picture) console.log(`  Picture:   ${profile.picture}`);
  if (profile.banner) console.log(`  Banner:    ${profile.banner}`);
  if (profile.nip05) console.log(`  NIP-05:    ${profile.nip05}`);
  if (profile.lud16) console.log(`  Lightning: ${profile.lud16}`);
}

async function displayImageInTerminal(url: string): Promise<void> {
  if (!Bun.env.KITTY_PID) return;
  try {
    await Bun.$`kitten icat --align=left ${url}`;
  } catch {
    // Not in kitty or icat failed, skip
  }
}

async function showProfile(): Promise<void> {
  const npub = await getNpub();
  const pubkey = decodePubkey(npub);
  const account = await getActiveAccount();

  console.log(`Account: ${account}`);
  console.log(`npub:    ${npub}`);

  console.log("Fetching profile from relays...");
  const profile = await fetchProfile(pubkey);

  if (!profile) {
    console.log("No profile found on relays.");
    console.log("Run 'blup profile --name \"Your Name\"' to create one.");
    return;
  }

  console.log("");
  printProfile(profile);

  if (profile.picture) {
    await displayImageInTerminal(profile.picture);
  }
}

function parseProfileFlags(args: string[]): ProfileMetadata | null {
  const updates: ProfileMetadata = {};
  let hasUpdates = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];

    switch (flag) {
      case "--name":
        updates.name = value;
        hasUpdates = true;
        i++;
        break;
      case "--about":
        updates.about = value;
        hasUpdates = true;
        i++;
        break;
      case "--picture":
        updates.picture = value;
        hasUpdates = true;
        i++;
        break;
      case "--banner":
        updates.banner = value;
        hasUpdates = true;
        i++;
        break;
      case "--nip05":
        updates.nip05 = value;
        hasUpdates = true;
        i++;
        break;
      case "--lud16":
        updates.lud16 = value;
        hasUpdates = true;
        i++;
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        process.exit(1);
    }
  }

  return hasUpdates ? updates : null;
}

// ---------------------------------------------------------------------------
// Server commands
// ---------------------------------------------------------------------------

async function addServer(serverUrl: string): Promise<void> {
  try {
    new URL(serverUrl);
  } catch {
    console.error("Error: argument must be a valid URL");
    process.exit(1);
  }

  const nsec = await getNsec();
  const secretKey = decodeSecretKey(nsec);

  const existingServers = await getServers(true);

  const normalizedUrl = serverUrl.replace(/\/$/, "");
  const filteredServers = existingServers.filter(
    (s) => s.replace(/\/$/, "") !== normalizedUrl
  );
  const newServers = [normalizedUrl, ...filteredServers];

  console.log("Publishing server list to relays...");
  await publishServerList(secretKey, newServers);

  const config = await loadCachedConfig();
  config.servers = newServers;
  await saveCachedConfig(config);
  console.log(`Server ${normalizedUrl} added to your server list`);
}

async function listServers(): Promise<void> {
  const servers = await getServers(true);
  if (servers.length === 0) {
    console.log("No servers configured. Run 'blup server <url>' to add one.");
    return;
  }

  console.log("Configured servers:");
  servers.forEach((s, i) => {
    const marker = i === 0 ? " (primary)" : "";
    console.log(`  ${i + 1}. ${s}${marker}`);
  });
}

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  for await (const line of console) {
    return line;
  }
  return "";
}

async function preferServer(): Promise<void> {
  const nsec = await getNsec();
  const secretKey = decodeSecretKey(nsec);

  const servers = await getServers(true);
  if (servers.length === 0) {
    console.log("No servers configured. Run 'blup server <url>' to add one.");
    return;
  }

  if (servers.length === 1) {
    console.log("Only one server configured, already preferred.");
    return;
  }

  console.log("Select preferred server:");
  servers.forEach((s, i) => {
    const marker = i === 0 ? " (current)" : "";
    console.log(`  ${i + 1}. ${s}${marker}`);
  });

  const input = await prompt("Enter number: ");
  const choice = parseInt(input.trim(), 10);

  if (isNaN(choice) || choice < 1 || choice > servers.length) {
    console.error("Invalid selection");
    process.exit(1);
  }

  if (choice === 1) {
    console.log("Server is already preferred.");
    return;
  }

  const chosen = servers[choice - 1]!;
  const newServers = [chosen, ...servers.filter((_, i) => i !== choice - 1)];

  console.log("Publishing updated server list...");
  await publishServerList(secretKey, newServers);

  const config = await loadCachedConfig();
  config.servers = newServers;
  await saveCachedConfig(config);
  console.log(`${chosen} is now your preferred server`);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("blup - Nostr identity & Blossom file manager");
  console.log("");
  console.log("Identity:");
  console.log("  blup create [name]           Create a new Nostr account");
  console.log("  blup profile                 Show your profile");
  console.log(
    "  blup profile --name <n>      Update profile (--name, --about, --picture, --banner, --nip05, --lud16)"
  );
  console.log("  blup accounts                List all accounts");
  console.log("  blup use <name>              Switch active account");
  console.log("");
  console.log("Files:");
  console.log("  blup <file>                  Upload a file (shorthand)");
  console.log("  blup <url>                   Mirror a URL (shorthand)");
  console.log("  blup upload <filename>       Upload a file");
  console.log("  blup mirror <url>            Mirror a URL to your server");
  console.log("  blup list                    List your uploaded blobs");
  console.log("  blup delete <sha256>         Delete a blob by hash");
  console.log("");
  console.log("Servers:");
  console.log("  blup server <url>            Add a server to your list");
  console.log("  blup server list             View configured servers");
  console.log("  blup server prefer           Set preferred server");
  console.log("");
  console.log("Advanced:");
  console.log(
    "  blup config <npub> <nsec>    Import existing keys (stored in system keychain)"
  );
  console.log(
    "  blup config <name> <npub> <nsec>  Import keys to a named account"
  );
  console.log("");
  console.log("Global flags:");
  console.log("  --as <name>                  Use a specific account for this command");
  console.log("  --verbose, -v                Show full JSON output for uploads");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const rawArgs = Bun.argv.slice(2);

  // Pre-process global flags
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--as" && rawArgs[i + 1]) {
      globalAccountOverride = rawArgs[i + 1];
      i++;
    } else if (rawArgs[i] === "--verbose" || rawArgs[i] === "-v") {
      globalVerbose = true;
    } else {
      args.push(rawArgs[i]!);
    }
  }

  if (args.length < 1) {
    printUsage();
    process.exit(1);
  }

  const command = args[0]!;
  const rest = args.slice(1);

  switch (command) {
    case "create":
      await createAccount(rest[0]);
      break;

    case "profile": {
      const updates = parseProfileFlags(rest);
      if (updates) {
        await updateProfile(updates);
      } else {
        await showProfile();
      }
      break;
    }

    case "accounts":
      await listAccounts();
      break;

    case "use":
      if (!rest[0]) {
        console.error("Usage: blup use <account-name>");
        process.exit(1);
      }
      await useAccount(rest[0]);
      break;

    case "config":
      if (rest.length === 3) {
        await configure(rest[0]!, rest[1]!, rest[2]);
      } else if (rest.length === 2) {
        await configure(rest[0]!, rest[1]!);
      } else {
        console.error("Usage: blup config <npub> <nsec>");
        console.error("       blup config <name> <npub> <nsec>");
        process.exit(1);
      }
      break;

    case "server":
      if (rest[0] === "list") {
        await listServers();
      } else if (rest[0] === "prefer") {
        await preferServer();
      } else if (rest[0]) {
        await addServer(rest[0]);
      } else {
        console.error("Usage:");
        console.error("  blup server <url>      Add a server");
        console.error("  blup server list       View configured servers");
        console.error("  blup server prefer     Set preferred server");
        process.exit(1);
      }
      break;

    case "list": {
      const serverUrl = await getPreferredServer();
      await listBlobs(serverUrl);
      break;
    }

    case "upload": {
      if (!rest[0]) {
        console.error("Usage: blup upload <filename>");
        process.exit(1);
      }
      const serverUrl = await getPreferredServer();
      await uploadBlob(serverUrl, rest[0]);
      break;
    }

    case "mirror": {
      if (!rest[0]) {
        console.error("Usage: blup mirror <url>");
        process.exit(1);
      }
      await mirrorBlob(rest[0]);
      break;
    }

    case "delete": {
      if (!rest[0]) {
        console.error("Usage: blup delete <sha256>");
        process.exit(1);
      }
      const serverUrl = await getPreferredServer();
      await deleteBlob(serverUrl, rest[0]);
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;

    default:
      if (command.startsWith("http://") || command.startsWith("https://")) {
        await mirrorBlob(command);
      } else if (await Bun.file(command).exists()) {
        const serverUrl = await getPreferredServer();
        await uploadBlob(serverUrl, command);
      } else {
        console.error(`Unknown command or file not found: ${command}`);
        printUsage();
        process.exit(1);
      }
      break;
  }
}

await main();
process.exit(0);

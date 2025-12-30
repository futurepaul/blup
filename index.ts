#!/usr/bin/env bun

import { finalizeEvent } from "nostr-tools";
import { decode } from "nostr-tools/nip19";
import { SimplePool } from "nostr-tools/pool";
import { secrets } from "bun";
import os from "os";
import path from "path";

const SERVICE_NAME = "com.blossom.blup";

// Config file handling
interface CachedConfig {
  servers: string[];
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

async function loadCachedConfig(): Promise<CachedConfig | null> {
  const configPath = getConfigPath();
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return await file.json();
  } catch {
    return null;
  }
}

async function saveCachedConfig(config: CachedConfig): Promise<void> {
  const configDir = getConfigDir();
  await Bun.$`mkdir -p ${configDir}`.quiet();
  const configPath = getConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

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

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const pool = new SimplePool();

function getRelays(): string[] {
  const envRelays = Bun.env.BLUP_RELAYS;
  if (envRelays) {
    return envRelays.split(",").map((r) => r.trim());
  }
  return DEFAULT_RELAYS;
}

async function fetchServerList(pubkey: string): Promise<string[]> {
  const relays = getRelays();

  const event = await pool.get(relays, {
    kinds: [10063],
    authors: [pubkey],
  });

  if (!event) {
    return [];
  }

  return event.tags
    .filter((t): t is [string, string, ...string[]] => t[0] === "server" && typeof t[1] === "string")
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

  await Promise.any(pool.publish(relays, event));
}

async function getNsec(): Promise<string> {
  const nsec = await secrets.get({ service: SERVICE_NAME, name: "nsec" });
  if (!nsec) {
    console.error("Error: No nsec found. Run 'config' first.");
    process.exit(1);
  }
  return nsec;
}

async function getNpub(): Promise<string> {
  const npub = await secrets.get({ service: SERVICE_NAME, name: "npub" });
  if (!npub) {
    console.error("Error: No npub found. Run 'config' first.");
    process.exit(1);
  }
  return npub;
}

function createAuthEvent(
  secretKey: Uint8Array,
  type: "list" | "upload",
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

  const event = finalizeEvent(
    {
      kind: 24242,
      content: type === "list" ? "List Blobs" : "Upload Blob",
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
    secretKey
  );

  return event;
}

async function listBlobs(serverUrl: string): Promise<void> {
  const nsec = await getNsec();
  const npub = await getNpub();

  const secretKey = decode(nsec);
  const publicKey = decode(npub);

  if (publicKey.type !== "npub") {
    console.error("Error: stored npub is invalid");
    process.exit(1);
  }
  if (secretKey.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }

  const authEvent = createAuthEvent(secretKey.data, "list");
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const url = `${serverUrl.replace(/\/$/, "")}/list/${publicKey.data}`;

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

async function uploadBytes(
  serverUrl: string,
  bytes: Uint8Array,
  contentType: string
): Promise<void> {
  const nsec = await getNsec();

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }

  const hash = new Bun.SHA256().update(bytes).digest("hex");
  const total = bytes.length;

  const authEvent = createAuthEvent(secretKey.data, "upload", hash);
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

  // 404 means server doesn't support BUD-06, proceed with upload
  // Other non-2xx means rejection
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
  const chunkSize = 64 * 1024; // 64KB chunks

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
        // Use setTimeout to yield and allow progress to render
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
  console.log(JSON.stringify(blob, null, 2));
}

async function uploadBlob(serverUrl: string, filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const fileBuffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(fileBuffer);
  const contentType = file.type || "application/octet-stream";

  console.log(`Uploading ${filePath}...`);
  await uploadBytes(serverUrl, fileBytes, contentType);
}

async function configure(npub: string, nsec: string): Promise<void> {
  const publicKey = decode(npub);
  if (publicKey.type !== "npub") {
    console.error("Error: first argument must be a valid npub");
    process.exit(1);
  }

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: second argument must be a valid nsec");
    process.exit(1);
  }

  await secrets.set({ service: SERVICE_NAME, name: "npub", value: npub });
  await secrets.set({ service: SERVICE_NAME, name: "nsec", value: nsec });

  console.log("Credentials stored in system keychain");
}

async function getServers(forceRefresh = false): Promise<string[]> {
  // Try cache first unless forcing refresh
  if (!forceRefresh) {
    const cached = await loadCachedConfig();
    if (cached && cached.servers.length > 0) {
      return cached.servers;
    }
  }

  // Fetch from nostr
  const npub = await getNpub();
  const publicKey = decode(npub);
  if (publicKey.type !== "npub") {
    console.error("Error: stored npub is invalid");
    process.exit(1);
  }

  const servers = await fetchServerList(publicKey.data);

  // Cache the result if we got servers
  if (servers.length > 0) {
    await saveCachedConfig({ servers });
  }

  return servers;
}

async function getPreferredServer(): Promise<string> {
  const servers = await getServers();
  if (servers.length === 0) {
    console.error("Error: No servers configured. Run 'blup server <url>' first.");
    process.exit(1);
  }

  return servers[0] as string;
}

async function addServer(serverUrl: string): Promise<void> {
  try {
    new URL(serverUrl);
  } catch {
    console.error("Error: argument must be a valid URL");
    process.exit(1);
  }

  const nsec = await getNsec();

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }

  // Force refresh from nostr to get latest
  const existingServers = await getServers(true);

  // Add new server to the front if not already present
  const normalizedUrl = serverUrl.replace(/\/$/, "");
  const filteredServers = existingServers.filter(
    (s) => s.replace(/\/$/, "") !== normalizedUrl
  );
  const newServers = [normalizedUrl, ...filteredServers];

  console.log("Publishing server list to relays...");
  await publishServerList(secretKey.data, newServers);

  // Update cache
  await saveCachedConfig({ servers: newServers });
  console.log(`Server ${normalizedUrl} added to your server list`);
}

async function listServers(): Promise<void> {
  // Force refresh from nostr
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

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }

  // Force refresh from nostr
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

  // Move chosen server to front
  const chosen = servers[choice - 1]!;
  const newServers = [chosen, ...servers.filter((_, i) => i !== choice - 1)];

  console.log("Publishing updated server list...");
  await publishServerList(secretKey.data, newServers);

  // Update cache
  await saveCachedConfig({ servers: newServers });
  console.log(`${chosen} is now your preferred server`);
}

async function mirrorBlob(sourceUrl: string): Promise<void> {
  const nsec = await getNsec();
  const serverUrl = await getPreferredServer();

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }

  // First, try the server's /mirror endpoint
  const mirrorUrl = `${serverUrl.replace(/\/$/, "")}/mirror`;

  // Create auth event for mirror (uses upload type)
  const authEvent = createAuthEvent(secretKey.data, "upload");
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
    console.log(JSON.stringify(blob, null, 2));
    return;
  }

  // Fall back to download + upload if /mirror not supported or fails
  if (mirrorResponse.status === 404) {
    console.log("Server does not support /mirror, downloading and reuploading...");
  } else {
    const error = await mirrorResponse.text();
    console.log(`Mirror failed (${mirrorResponse.status}: ${error}), downloading and reuploading...`);
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

  // Download with progress
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

  // Combine chunks
  const fileBytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    fileBytes.set(chunk, offset);
    offset += chunk.length;
  }

  console.log("Uploading...");
  await uploadBytes(serverUrl, fileBytes, contentType);
}

function printUsage(): void {
  console.log("blup - A simple CLI for Blossom servers");
  console.log("");
  console.log("Usage:");
  console.log("  blup config <npub> <nsec>    Set up your Nostr keys (stored in system keychain)");
  console.log("  blup server <url>            Add a server to your list");
  console.log("  blup server list             View configured servers");
  console.log("  blup server prefer           Set preferred server");
  console.log("  blup list                    List your uploaded blobs");
  console.log("  blup upload <filename>       Upload a file");
  console.log("  blup mirror <url>            Mirror a URL to your server");
}

// CLI using Bun.argv
const args = Bun.argv.slice(2);

if (args.length < 1) {
  printUsage();
  process.exit(1);
}

const [command, ...rest] = args;

switch (command) {
  case "config":
    if (!rest[0] || !rest[1]) {
      console.error("Usage: blup config <npub> <nsec>");
      process.exit(1);
    }
    await configure(rest[0], rest[1]);
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

  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

process.exit(0);

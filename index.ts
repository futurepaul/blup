import { finalizeEvent } from "nostr-tools";
import { decode } from "nostr-tools/nip19";
import os from "os";
import path from "path";
import { secrets } from "bun";

const SERVICE_NAME = "com.blossom.up";

interface Config {
  server: string;
}

function getConfigDir(): string {
  const platform = os.platform();

  if (platform === "win32") {
    const appData = Bun.env.APPDATA || Bun.env.LOCALAPPDATA;
    if (!appData) throw new Error("APPDATA/LOCALAPPDATA not set");
    return path.join(appData, "up");
  }

  const home = os.homedir();
  const xdgConfigHome = Bun.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdgConfigHome, "up");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "up_config.json");
}

async function loadConfig(): Promise<Config | null> {
  const configPath = getConfigPath();
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return null;
  }
  return file.json();
}

async function saveConfig(config: Config): Promise<void> {
  const configDir = getConfigDir();
  await Bun.$`mkdir -p ${configDir}`;
  const configPath = getConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
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

async function uploadBlob(serverUrl: string, filePath: string): Promise<void> {
  const nsec = await getNsec();

  const secretKey = decode(nsec);
  if (secretKey.type !== "nsec") {
    console.error("Error: stored nsec is invalid");
    process.exit(1);
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const fileBuffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(fileBuffer);
  const hash = new Bun.SHA256().update(fileBytes).digest("hex");

  const authEvent = createAuthEvent(secretKey.data, "upload", hash);
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const url = `${serverUrl.replace(/\/$/, "")}/upload`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": fileBytes.length.toString(),
    },
    body: fileBytes,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error ${response.status}: ${error}`);
    process.exit(1);
  }

  const blob = await response.json();
  console.log(JSON.stringify(blob, null, 2));
}

async function configure(
  npub: string,
  nsec: string,
  server: string
): Promise<void> {
  console.log(`Configuring with npub: ${npub}, nsec: ${nsec}, server: ${server}`);
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

  try {
    new URL(server);
  } catch {
    console.error("Error: third argument must be a valid URL");
    process.exit(1);
  }

  await secrets.set({ service: SERVICE_NAME, name: "npub", value: npub });
  await secrets.set({ service: SERVICE_NAME, name: "nsec", value: nsec });
  await saveConfig({ server });

  console.log("Credentials stored in system keychain");
  console.log(`Config saved to ${getConfigPath()}`);
}

// CLI
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error("Usage:");
  console.error("  bun run index.ts config <npub> <nsec> <server-url>");
  console.error("  bun run index.ts list");
  console.error("  bun run index.ts upload <filename>");
  process.exit(1);
}

const [command, ...rest] = args;

switch (command) {
  case "config":
    if (!rest[0] || !rest[1] || !rest[2]) {
      console.error("Usage: bun run index.ts config <npub> <nsec> <server-url>");
      process.exit(1);
    }
    await configure(rest[0], rest[1], rest[2]);
    break;
  case "list": {
    const config = await loadConfig();
    if (!config) {
      console.error("Error: No config found. Run 'config' first.");
      process.exit(1);
    }
    await listBlobs(config.server);
    break;
  }
  case "upload": {
    if (!rest[0]) {
      console.error("Usage: bun run index.ts upload <filename>");
      process.exit(1);
    }
    const config = await loadConfig();
    if (!config) {
      console.error("Error: No config found. Run 'config' first.");
      process.exit(1);
    }
    await uploadBlob(config.server, rest[0]);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

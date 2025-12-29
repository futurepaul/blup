import { finalizeEvent } from "nostr-tools";
import { decode } from "nostr-tools/nip19";

const PUBKEY = process.env.PUBKEY;
const SECKEY = process.env.SECKEY;

if (!PUBKEY || !SECKEY) {
  console.error("Error: PUBKEY and SECKEY must be set in .env");
  process.exit(1);
}

function createListAuthEvent(secretKey: Uint8Array) {
  const expiration = Math.floor(Date.now() / 1000) + 60; // 1 minute from now

  const event = finalizeEvent(
    {
      kind: 24242,
      content: "List Blobs",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "list"],
        ["expiration", expiration.toString()],
      ],
    },
    secretKey
  );

  return event;
}

async function listBlobs(serverUrl: string): Promise<void> {
  const secretKey = decode(SECKEY!);
  const publicKey = decode(PUBKEY!);
  if (publicKey.type !== "npub") {
    console.error("Error: PUBKEY must be a npub");
    process.exit(1);
  }
  if (secretKey.type !== "nsec") {
    console.error("Error: SECKEY must be a nsec");
    process.exit(1);
  }
  const authEvent = createListAuthEvent(secretKey.data);
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

// CLI
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error("Usage:");
  console.error("  bun run index.ts <server-url> list");
  process.exit(1);
}

const [first, second] = args;
if (!first || !second) {
  console.error("Usage: bun run index.ts <server-url> list");
  process.exit(1);
}
switch (second) {
  case "list":
    await listBlobs(first);
      break;
    default:
      console.error(`Unknown command: ${second}`);
    process.exit(1);
}

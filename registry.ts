import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http, webSocket, defineChain, parseAbiItem } from "viem";

const VAULT_ADDRESS = process.env.VAULT_ADDRESS as `0x${string}`;
const DEPLOYMENT_BLOCK = BigInt(process.env.VAULT_DEPLOYMENT_BLOCK || "0");

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const arcTestnetHttp = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.arc.network"] } },
});

const arcTestnetWs = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.arc.network"] } },
});

const httpClient = createPublicClient({ chain: arcTestnetHttp, transport: http() });

const BORROWED_EVENT = parseAbiItem("event Borrowed(address indexed user, uint256 amount)");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHUNK_SIZE = 10n; // Alchemy free tier's eth_getLogs limit — only used for the one-time historical backfill

async function addBorrowerIfNew(address: string, blockNumber: bigint) {
  const { error } = await supabase
    .from("borrowers")
    .upsert({ address: address.toLowerCase(), first_seen_block: Number(blockNumber) }, { onConflict: "address", ignoreDuplicates: true });

  if (error) console.error("  Failed to add borrower:", error.message);
}

async function getLastSyncedBlock(): Promise<bigint> {
  const { data } = await supabase.from("sync_state").select("last_synced_block").eq("id", 1).single();
  const stored = BigInt(data?.last_synced_block ?? 0);
  return stored > DEPLOYMENT_BLOCK ? stored : DEPLOYMENT_BLOCK;
}

async function setLastSyncedBlock(block: bigint) {
  await supabase.from("sync_state").upsert({ id: 1, last_synced_block: Number(block) });
}

/// One-time (per startup) historical backfill: catches any Borrowed events that happened
/// before this process started watching live. Chunked to respect the free-tier RPC limit.
/// After this runs once, live events are picked up via WebSocket — no more repeated scanning.
export async function backfillBorrowers(): Promise<void> {
  const fromBlock = (await getLastSyncedBlock()) + 1n;
  const latestBlock = await httpClient.getBlockNumber();

  if (fromBlock > latestBlock) {
    console.log("Registry: already up to date, nothing to backfill.");
    return;
  }

  const totalBlocks = latestBlock - fromBlock + 1n;
  const totalChunks = Number((totalBlocks + CHUNK_SIZE - 1n) / CHUNK_SIZE);
  console.log(`Registry: backfilling ${totalBlocks} blocks in ${totalChunks} chunks (one-time catch-up)...`);

  let chunkStart = fromBlock;
  let chunksDone = 0;
  let found = 0;

  while (chunkStart <= latestBlock) {
    const chunkEnd = chunkStart + CHUNK_SIZE - 1n > latestBlock ? latestBlock : chunkStart + CHUNK_SIZE - 1n;

    const logs = await httpClient.getLogs({
      address: VAULT_ADDRESS,
      event: BORROWED_EVENT,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });

    for (const log of logs) {
      if (log.args.user) {
        await addBorrowerIfNew(log.args.user, log.blockNumber);
        found++;
      }
    }

    chunkStart = chunkEnd + 1n;
    chunksDone++;
    if (chunksDone % 50 === 0) console.log(`  Registry: ${chunksDone}/${totalChunks} chunks scanned...`);
    if (chunkStart <= latestBlock) await sleep(250);
  }

  await setLastSyncedBlock(latestBlock);
  console.log(`Registry: backfill complete. ${found} borrow event(s) processed.`);
}

/// Starts a live WebSocket subscription — new Borrowed events are pushed to us in real time,
/// no polling or chunking needed for anything going forward.
export function watchForNewBorrowers() {
  const wsUrl = process.env.ALCHEMY_WS_URL;
  if (!wsUrl) {
    console.log("No ALCHEMY_WS_URL set — skipping live event watching (backfill-only mode).");
    return;
  }

  const wsClient = createPublicClient({ chain: arcTestnetWs, transport: webSocket(wsUrl) });

  wsClient.watchContractEvent({
    address: VAULT_ADDRESS,
    abi: [BORROWED_EVENT],
    eventName: "Borrowed",
    onLogs: async (logs) => {
      for (const log of logs) {
        if (log.args.user) {
          console.log(`  Registry: live event — new borrow from ${log.args.user}`);
          await addBorrowerIfNew(log.args.user, log.blockNumber!);
          await setLastSyncedBlock(log.blockNumber!);
        }
      }
    },
    onError: (error) => {
      console.error("  WebSocket watcher error:", error.message);
    },
  });

  console.log("Registry: live WebSocket event watching started.");
}

/// Fast, simple read — just pulls the current known borrower list from Supabase.
export async function getBorrowers(): Promise<string[]> {
  const { data, error } = await supabase.from("borrowers").select("address");
  if (error) {
    console.error("  Failed to fetch borrowers:", error.message);
    return [];
  }
  return (data ?? []).map((row) => row.address);
}

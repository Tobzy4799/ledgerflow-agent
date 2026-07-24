import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, defineChain } from "viem";
import OpenAI from "openai";
import { backfillBorrowers, watchForNewBorrowers, getBorrowers } from "./registry";

const TREASURY_ADDRESS = "0xB52Aac9451Ebb70899f3521A16F412f2c9487211"; // where genuine service fees land

// ── Config ──
const VAULT_ADDRESS = process.env.VAULT_ADDRESS as `0x${string}`;
const GUARDIAN_WALLET_ID = process.env.GUARDIAN_WALLET_ID!;
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 60_000); // default: check every 60s

const WARNING_THRESHOLD_BPS = 7000n; // 70% — Guardian warns, but doesn't act yet
const DANGER_THRESHOLD_BPS = 7500n;  // 75% — Guardian actually repays

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.arc.network"] } },
});

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const VAULT_ABI = [
  {
    type: "function",
    name: "getUtilizationBps",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "debt",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1500): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries === 0) throw err;
    console.log(`  (retrying in ${delayMs}ms...)`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timestamp() {
  return new Date().toISOString();
}

// Tracks whether we've already warned for the CURRENT risk episode, so we don't repeat
// the same warning every single cycle — only once when crossing into warning territory,
// resetting once the position recovers back to healthy.
const hasWarned = new Map<string, boolean>();

/// One monitoring cycle for a single user. Wrapped in try/catch by the caller so a failure
/// here (a bad RPC call, an OpenAI hiccup, whatever) never crashes the whole loop — it just
/// gets logged and the loop tries again next cycle.
async function checkPosition(userAddress: `0x${string}`) {
  console.log(`[${timestamp()}] Checking position for ${userAddress}...`);

  const utilizationBps = await withRetry(() =>
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "getUtilizationBps",
      args: [userAddress],
    })
  );

  await sleep(1000);

  const debt = await withRetry(() =>
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "debt",
      args: [userAddress],
    })
  );

  const utilizationPct = Number(utilizationBps) / 100;
  console.log(`  Utilization: ${utilizationPct}% | Debt: ${Number(debt) / 1e6} USDC`);

  // ── Healthy: reset the warning flag so a future episode can warn again ──
  if (utilizationBps < WARNING_THRESHOLD_BPS) {
    console.log(`  Healthy — no action needed.`);
    hasWarned.set(userAddress, false);
    return;
  }

  // ── Warning zone: notify once, take no action yet ──
  if (utilizationBps < DANGER_THRESHOLD_BPS) {
    if (hasWarned.get(userAddress)) {
      console.log(`  Still in warning zone (already warned this episode) — no new action.`);
      return;
    }

    console.log(`  Crossed ${Number(WARNING_THRESHOLD_BPS) / 100}% — issuing a warning (no repay yet).`);
    hasWarned.set(userAddress, true);

    try {
      const warning = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are Ledgerflow's Guardian agent. Write one short, calm, plain-English warning sentence for a non-technical user whose position is getting risky but isn't in immediate danger yet.",
          },
          {
            role: "user",
            content: `Utilization just crossed ${utilizationPct}%, above the ${Number(WARNING_THRESHOLD_BPS) / 100}% early-warning level, but still under the ${Number(DANGER_THRESHOLD_BPS) / 100}% level where you'd step in automatically. Debt is currently ${Number(debt) / 1e6} USDC.`,
          },
        ],
      });
      console.log(`  ⚠️  Warning: ${warning.choices[0].message.content}`);
      console.log(`  (In production, this becomes a push notification / email to the user — not a silent log line.)`);
    } catch (err) {
      console.log(`  (couldn't generate warning message this cycle: ${(err as Error).message})`);
    }
    return;
  }

  // ── Danger zone: act ──
  console.log(`  Crossed ${Number(DANGER_THRESHOLD_BPS) / 100}% — triggering protective repay.`);

  const repayAmount = debt / 5n;

  const response = await circleClient.createContractExecutionTransaction({
    walletId: GUARDIAN_WALLET_ID,
    contractAddress: VAULT_ADDRESS,
    abiFunctionSignature: "repayFor(address,uint256)",
    abiParameters: [userAddress, repayAmount.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  console.log(`  Repay submitted: ${response.data?.id} (state: ${response.data?.state})`);
  hasWarned.set(userAddress, false); // reset — if it climbs back up later, warn again first

  // Collect a small, genuine service fee from the user actually being protected —
  // real revenue paid by the user, not the platform paying itself. Uses the same
  // AgentAuth authorization and standing approval already trusted for repayFor,
  // so no separate signing flow or CLI dependency is needed.
  try {
    const feeResponse = await circleClient.createContractExecutionTransaction({
      walletId: GUARDIAN_WALLET_ID,
      contractAddress: VAULT_ADDRESS,
      abiFunctionSignature: "collectServiceFee(address,uint256,address)",
      abiParameters: [userAddress, "1000", TREASURY_ADDRESS], // $0.001 fee
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    console.log(`  Service fee collected ✓ (${feeResponse.data?.id})`);
  } catch (err) {
    // Fee collection is supplementary — never block the actual protective repay over it.
    console.error(`  Service fee collection failed (non-blocking): ${(err as Error).message}`);
  }

  try {
    const explanation = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are Ledgerflow's Guardian agent. Explain, in one short plain-English sentence, what action you just took and why, for a non-technical user.",
        },
        {
          role: "user",
          content: `Utilization was ${utilizationPct}%, above the ${Number(DANGER_THRESHOLD_BPS) / 100}% safety threshold. You repaid ${Number(repayAmount) / 1e6} USDC on the user's behalf to bring their position back to a safer level.`,
        },
      ],
    });
    console.log(`  Explanation: ${explanation.choices[0].message.content}`);
  } catch (err) {
    // If OpenAI hiccups, that's fine — the actual protective repay already happened,
    // we just lose the narration for this cycle.
    console.log(`  (couldn't generate explanation this cycle: ${(err as Error).message})`);
  }
}

async function runLoop() {
  console.log(`Guardian starting up...`);

  // One-time catch-up on any historical events, then switch to live WebSocket watching —
  // no more repeated chunked scanning on every cycle.
  await backfillBorrowers();
  watchForNewBorrowers();

  console.log(`Guardian running. Checking every ${CHECK_INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);

  while (true) {
    try {
      const borrowers = await getBorrowers();

      if (borrowers.length === 0) {
        console.log(`[${timestamp()}] No borrowers registered yet.`);
      } else {
        console.log(`[${timestamp()}] Checking ${borrowers.length} borrower(s)...`);
        for (const borrower of borrowers) {
          try {
            await checkPosition(borrower as `0x${string}`);
          } catch (err) {
            console.error(`  Failed to check ${borrower}:`, (err as Error).message);
          }
          await sleep(1000);
        }
      }
    } catch (err) {
      console.error(`[${timestamp()}] Cycle failed:`, (err as Error).message);
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

runLoop();

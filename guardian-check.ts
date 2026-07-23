import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, defineChain } from "viem";
import OpenAI from "openai";

// ── Config — fill these in via .env ──
const VAULT_ADDRESS = process.env.VAULT_ADDRESS as `0x${string}`;
const TEST_USER_ADDRESS = process.env.TEST_USER_ADDRESS as `0x${string}`;
const GUARDIAN_WALLET_ID = process.env.GUARDIAN_WALLET_ID!;

// Danger threshold: if utilization crosses this, the Guardian steps in.
// The vault's own liquidation threshold is 80% (8000 bps) — we act a bit earlier, at 75%,
// to actually prevent liquidation rather than react after the fact.
const DANGER_THRESHOLD_BPS = 7500n;

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://arc-testnet.g.alchemy.com/v2/o-AAxhTGi5ZY5OTOYhSfg"] } },
});

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Arc's public RPC has fairly tight rate limits — a couple of reads back-to-back can
// trip "request limit reached". This retries with a short backoff instead of failing outright.
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1500): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries === 0) throw err;
    console.log(`  (rate limited, retrying in ${delayMs}ms...)`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function checkPosition() {
  console.log(`Checking position for ${TEST_USER_ADDRESS}...`);

  const utilizationBps = await withRetry(() =>
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "getUtilizationBps",
      args: [TEST_USER_ADDRESS],
    })
  );

  await sleep(1000); // small gap to avoid tripping the rate limit on the next call

  const debt = await withRetry(() =>
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "debt",
      args: [TEST_USER_ADDRESS],
    })
  );

  const utilizationPct = Number(utilizationBps) / 100;
  console.log(`Current utilization: ${utilizationPct}%`);
  console.log(`Current debt: ${Number(debt) / 1e6} USDC`);

  if (utilizationBps < DANGER_THRESHOLD_BPS) {
    console.log("Position is healthy — no action needed.");
    return;
  }

  console.log(`Utilization above ${Number(DANGER_THRESHOLD_BPS) / 100}% threshold — triggering protective repay.`);

  // Repay a modest amount to bring utilization back down — here, 20% of current debt,
  // capped at what's actually owed. A real version would compute the exact amount
  // needed to land back under the threshold; this is a simple, safe first pass.
  const repayAmount = debt / 5n;

  const response = await circleClient.createContractExecutionTransaction({
    walletId: GUARDIAN_WALLET_ID,
    contractAddress: VAULT_ADDRESS,
    abiFunctionSignature: "repayFor(address,uint256)",
    abiParameters: [TEST_USER_ADDRESS, repayAmount.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  console.log("Repay transaction submitted:", response.data);

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

  console.log("");
  console.log("Guardian explanation:");
  console.log(explanation.choices[0].message.content);
}

checkPosition().catch(console.error);

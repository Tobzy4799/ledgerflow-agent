import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, defineChain } from "viem";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { sendNotificationEmail } from "./email";

const VAULT_ADDRESS = process.env.VAULT_ADDRESS as `0x${string}`;
const POOL_ADDRESS = process.env.POOL_ADDRESS as `0x${string}`;
const CONDITIONAL_AGENT_WALLET_ID = process.env.CONDITIONAL_AGENT_WALLET_ID!;
const CONDITIONAL_AGENT_WALLET_ADDRESS = process.env.CONDITIONAL_AGENT_WALLET_ADDRESS as `0x${string}`;
const CHECK_INTERVAL_MS = Number(process.env.CONDITIONAL_AGENT_INTERVAL_MS || 60_000);

const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;
const CIRBTC_ADDRESS = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF" as const;

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.arc.network"] } },
});

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const VAULT_ABI = [
  {
    type: "function",
    name: "collateralAssets",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "approved", type: "bool" },
      { name: "tokenDecimals", type: "uint8" },
      { name: "priceUSD", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

const POOL_ABI = [
  {
    type: "function",
    name: "quoteSwap",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "tokenToUsdc", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

function timestamp() {
  return new Date().toISOString();
}

function assetAddress(asset: string) {
  return asset === "cirbtc" ? CIRBTC_ADDRESS : EURC_ADDRESS;
}

function assetDecimals(asset: string) {
  return asset === "cirbtc" ? 8 : 6;
}

async function getAssetPriceUSD(asset: string): Promise<number> {
  const info = (await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "collateralAssets",
    args: [assetAddress(asset)],
  })) as [boolean, number, bigint];
  return Number(info[2]) / 1e6;
}

async function conditionMet(agent: any): Promise<boolean> {
  if (agent.condition_type === "time_interval") {
    if (!agent.next_execution_at) return false;
    return new Date() >= new Date(agent.next_execution_at);
  }
  const price = await getAssetPriceUSD(agent.condition_asset);
  if (agent.condition_type === "price_below") return price < Number(agent.threshold);
  if (agent.condition_type === "price_above") return price > Number(agent.threshold);
  return false;
}

async function waitForTerminalState(txId: string, maxAttempts = 20): Promise<{ state: string; errorReason?: string }> {
  const terminalStates = new Set(["COMPLETE", "CONFIRMED", "FAILED", "DENIED", "CANCELLED"]);
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await circleClient.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    if (state && terminalStates.has(state)) {
      return { state, errorReason: data?.transaction?.errorReason };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { state: "TIMEOUT" };
}

async function executeSwap(agent: any) {
  const isRecurring = agent.condition_type === "time_interval";
  const asset = isRecurring ? agent.swap_asset : agent.condition_asset; // time_interval rules have no condition_asset, use swap_asset instead
  const token = assetAddress(asset);
  const tokenToUsdc = agent.swap_direction === "assetToUsdc";
  const inputDecimals = tokenToUsdc ? assetDecimals(asset) : 6;
  const amountInRaw = BigInt(Math.round(Number(agent.swap_amount) * 10 ** inputDecimals));

  console.log(`  Executing swap for ${agent.user_address}: ${agent.swap_amount} ${tokenToUsdc ? asset.toUpperCase() : "USDC"} -> ${tokenToUsdc ? "USDC" : asset.toUpperCase()}`);

  const quote = (await publicClient.readContract({
    address: POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: "quoteSwap",
    args: [token, amountInRaw, tokenToUsdc],
  })) as bigint;
  const minAmountOut = (quote * 99n) / 100n;

  const response = await circleClient.createContractExecutionTransaction({
    walletId: CONDITIONAL_AGENT_WALLET_ID,
    contractAddress: POOL_ADDRESS,
    abiFunctionSignature: "swapFor(address,address,address,uint256,bool,uint256)",
    abiParameters: [agent.user_address, CONDITIONAL_AGENT_WALLET_ADDRESS, token, amountInRaw.toString(), tokenToUsdc, minAmountOut.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const txId = response.data?.id;
  console.log(`  Swap submitted: ${txId} — waiting for final on-chain result...`);

  const result = await waitForTerminalState(txId!);

  // Price-triggered rules are one-time orders — deactivate after this single
  // attempt, whether it succeeds or fails. DCA (time_interval) rules are
  // recurring — on success, they reschedule for the next interval and stay
  // active; on failure, they still deactivate, since a silently-repeating
  // failure would just keep burning gas for nothing.
  if (result.state === "COMPLETE" || result.state === "CONFIRMED") {
    console.log(`  Swap confirmed ✓`);

    const update: any = { last_triggered_at: new Date().toISOString(), last_error: null };
    if (isRecurring) {
      update.next_execution_at = new Date(Date.now() + agent.interval_days * 24 * 60 * 60 * 1000).toISOString();
    } else {
      update.active = false;
    }
    await supabase.from("conditional_agents").update(update).eq("id", agent.id);

    const conditionDescription = isRecurring
      ? `it's been ${agent.interval_days} day(s) since your last DCA execution`
      : `${asset.toUpperCase()} hit your target price of $${agent.threshold} (${agent.condition_type})`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant explaining what an autonomous trading agent just did on behalf of a user, in one or two friendly sentences.",
        },
        {
          role: "user",
          content: `${conditionDescription}, so your agent swapped ${agent.swap_amount} ${tokenToUsdc ? asset.toUpperCase() : "USDC"} to ${tokenToUsdc ? "USDC" : asset.toUpperCase()} on your behalf.`,
        },
      ],
    });
    console.log(`  Explanation: ${completion.choices[0].message.content}`);

    await sendNotificationEmail(
      agent.user_address,
      "Ledgerflow — your rule just fired",
      completion.choices[0].message.content || `Your rule executed: swapped ${agent.swap_amount} ${tokenToUsdc ? asset.toUpperCase() : "USDC"} to ${tokenToUsdc ? "USDC" : asset.toUpperCase()}.`
    );
  } else {
    const reason = result.errorReason || `Transaction ended in state: ${result.state}`;
    console.log(`  Swap failed: ${reason}`);
    await supabase
      .from("conditional_agents")
      .update({ active: false, last_triggered_at: new Date().toISOString(), last_error: reason })
      .eq("id", agent.id);

    await sendNotificationEmail(
      agent.user_address,
      "Ledgerflow — your rule failed and was deactivated",
      `Your rule (${isRecurring ? "DCA" : "price-triggered"}, ${agent.swap_amount} ${asset.toUpperCase()}) failed to execute: ${reason}. This is often caused by an insufficient pool approval for the asset being traded. It's been deactivated — check the Conditional Agents page, fix the approval, and recreate it if you'd like to try again.`
    );
  }
}

async function runCycle() {
  const { data: agents, error } = await supabase.from("conditional_agents").select("*").eq("active", true);

  if (error) {
    console.error(`[${timestamp()}] Failed to fetch conditional agents:`, error.message);
    return;
  }

  if (!agents || agents.length === 0) {
    console.log(`[${timestamp()}] No active conditional agents.`);
    return;
  }

  console.log(`[${timestamp()}] Checking ${agents.length} conditional agent(s)...`);

  for (const agent of agents) {
    try {
      if (await conditionMet(agent)) {
        const description = agent.condition_type === "time_interval"
          ? `every ${agent.interval_days}d DCA on ${agent.swap_asset}`
          : `${agent.condition_asset} ${agent.condition_type} $${agent.threshold}`;
        console.log(`  Condition met for agent #${agent.id} (${description})`);
        await executeSwap(agent);
      }
    } catch (err) {
      console.error(`  Failed to process agent #${agent.id}:`, (err as Error).message);
    }
  }
}

async function main() {
  console.log(`Conditional agent watcher started. Checking every ${CHECK_INTERVAL_MS / 1000}s.`);
  while (true) {
    await runCycle();
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

main();

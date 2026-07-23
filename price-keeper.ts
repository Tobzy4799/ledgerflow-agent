import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const VAULT_ADDRESS = process.env.VAULT_ADDRESS as `0x${string}`;
const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;
const CIRBTC_ADDRESS = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF" as const;
const CHECK_INTERVAL_MS = Number(process.env.PRICE_KEEPER_INTERVAL_MS || 5 * 60_000); // default: every 5 minutes

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.arc.network"] } },
});

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });

const VAULT_ABI = [
  {
    type: "function",
    name: "setPrice",
    inputs: [
      { name: "token", type: "address" },
      { name: "priceUSD", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
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

function timestamp() {
  return new Date().toISOString();
}

const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; LedgerflowPriceKeeper/1.0)" };

async function getBtcPriceUSD(): Promise<number> {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
    headers: FETCH_HEADERS,
  });
  const data = await res.json();
  return data.bitcoin.usd;
}

async function getEurPriceUSD(): Promise<number> {
  const res = await fetch("https://api.frankfurter.app/latest?from=EUR&to=USD", {
    headers: FETCH_HEADERS,
  });
  const data = await res.json();
  return data.rates.USD;
}

/// Only actually sends a transaction if the price has moved meaningfully (>0.1%) since
/// the last update — avoids spamming pointless transactions for negligible fluctuations.
async function updatePriceIfChanged(token: `0x${string}`, newPriceUSD: number, label: string) {
  const current = await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "collateralAssets",
    args: [token],
  });

  const currentPriceRaw = (current as [boolean, number, bigint])[2];
  const currentPrice = Number(currentPriceRaw) / 1e6;
  const percentChange = Math.abs((newPriceUSD - currentPrice) / currentPrice) * 100;

  console.log(`[${timestamp()}] ${label}: current $${currentPrice.toFixed(2)} -> live $${newPriceUSD.toFixed(2)} (${percentChange.toFixed(3)}% change)`);

  if (percentChange < 0.1) {
    console.log(`  Change too small, skipping update.`);
    return;
  }

  const newPriceRaw = BigInt(Math.round(newPriceUSD * 1e6));

  const hash = await walletClient.writeContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "setPrice",
    args: [token, newPriceRaw],
  });

  console.log(`  Price updated onchain. Tx: ${hash}`);
}

async function runCycle() {
  try {
    const [btcPrice, eurPrice] = await Promise.all([getBtcPriceUSD(), getEurPriceUSD()]);
    await updatePriceIfChanged(CIRBTC_ADDRESS, btcPrice, "cirBTC");
    await updatePriceIfChanged(EURC_ADDRESS, eurPrice, "EURC");
  } catch (err) {
    console.error(`[${timestamp()}] Price-keeper cycle failed:`, (err as Error).message);
  }
}

async function main() {
  console.log(`Price-keeper started. Checking every ${CHECK_INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);
  while (true) {
    await runCycle();
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

main();

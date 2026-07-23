import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

async function main() {
  const walletSetResponse = await client.createWalletSet({
    name: "Ledgerflow Conditional Agents",
  });
  const walletSetId = walletSetResponse.data?.walletSet?.id;
  console.log("Created wallet set:", walletSetId);

  // A SEPARATE wallet from Guardian's — this means Conditional Agents get their own,
  // independent AgentAuth authorization (own maxPerAction/dailyLimit), never sharing
  // or silently overwriting Guardian's limits, and usable standalone even by a user
  // who's never touched Guardian at all.
  const walletsResponse = await client.createWallets({
    walletSetId: walletSetId!,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
  });

  const wallet = walletsResponse.data?.wallets?.[0];
  console.log("Conditional Agents wallet created:");
  console.log("  Wallet ID:", wallet?.id);
  console.log("  Address:", wallet?.address);
  console.log("");
  console.log("Next: fund this address with a small amount of testnet USDC (for gas),");
  console.log("then update .env with these values (separate from GUARDIAN_WALLET_ID/ADDRESS).");
}

main().catch(console.error);

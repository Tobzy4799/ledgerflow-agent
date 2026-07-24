import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

async function main() {
  const walletSetResponse = await client.createWalletSet({
    name: "Ledgerflow Executor Payer",
  });
  const walletSetId = walletSetResponse.data?.walletSet?.id;
  console.log("Created wallet set:", walletSetId);

  const walletsResponse = await client.createWallets({
    walletSetId: walletSetId!,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
  });

  const wallet = walletsResponse.data?.wallets?.[0];
  console.log("Executor payer wallet created:");
  console.log("  Wallet ID:", wallet?.id);
  console.log("  Address:", wallet?.address);
  console.log("");
  console.log("Next: fund this address with a small amount of testnet USDC (for the Nanopayment fee),");
  console.log("then add EXECUTOR_PAYER_WALLET_ID and EXECUTOR_PAYER_WALLET_ADDRESS to your Vercel env vars.");
}

main().catch(console.error);

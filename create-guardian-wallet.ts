import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

async function main() {
  // A Wallet Set groups related wallets together — one per project/purpose is typical.
  const walletSetResponse = await client.createWalletSet({
    name: "Ledgerflow Guardian Agent",
  });
  const walletSetId = walletSetResponse.data?.walletSet?.id;
  console.log("Created wallet set:", walletSetId);

  // The Guardian's own wallet — an EOA on Arc Testnet. Gas is paid in USDC automatically,
  // same as any Arc wallet, no separate native gas token needed.
  const walletsResponse = await client.createWallets({
    walletSetId: walletSetId!,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
  });

  const wallet = walletsResponse.data?.wallets?.[0];
  console.log("Guardian wallet created:");
  console.log("  Wallet ID:", wallet?.id);
  console.log("  Address:", wallet?.address);
  console.log("");
  console.log("Next: fund this address with a small amount of testnet USDC (for gas),");
  console.log("then use its address as the 'agent' when calling authorizeAgent() from a test user.");
}

main().catch(console.error);

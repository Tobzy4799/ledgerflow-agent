import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const TRANSACTION_ID = process.argv[2];

if (!TRANSACTION_ID) {
  console.log("Usage: npx tsx --env-file=.env check-tx.ts <transaction-id>");
  process.exit(1);
}

async function main() {
  const response = await circleClient.getTransaction({ id: TRANSACTION_ID });
  console.log(JSON.stringify(response.data, null, 2));
}

main().catch(console.error);

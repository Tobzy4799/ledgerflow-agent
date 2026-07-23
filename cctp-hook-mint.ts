import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.arc.network"] } },
});

const ARC_MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;

// Paste these directly from the Iris response.
const MESSAGE = process.env.CCTP_MESSAGE as `0x${string}`;
const ATTESTATION = process.env.CCTP_ATTESTATION as `0x${string}`;

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });

const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

async function main() {
  if (!MESSAGE || !ATTESTATION) throw new Error("Set CCTP_MESSAGE and CCTP_ATTESTATION in .env");

  console.log("Submitting attestation to Arc's MessageTransmitterV2...");
  console.log("This should trigger: mint USDC + call our LedgerflowHooks contract.\n");

  const hash = await walletClient.writeContract({
    address: ARC_MESSAGE_TRANSMITTER_V2,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "receiveMessage",
    args: [MESSAGE, ATTESTATION],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Mint + hook transaction confirmed: ${hash}`);
  console.log(`Status: ${receipt.status}`);
  console.log(`\nCheck the borrower's collateral balance on the vault now to confirm the hook fired.`);
}

main().catch((error) => {
  console.error("\nError:", error);
  process.exit(1);
});

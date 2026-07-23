import { createPublicClient, createWalletClient, http, encodeAbiParameters, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ── Config ──
const BASE_SEPOLIA_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const; // correct TESTNET address (universal across all CCTP testnets)
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const ARC_DOMAIN = 26;
const LEDGERFLOW_HOOKS_ON_ARC = "0xc19be43Bb7Cb6D0796F04FFab9A56cf026546Ed9" as const; // diagnostic hooks contract - captures raw messageBody via event

// The user this deposit is "for" — whoever should be credited with the collateral once it lands.
// For this test, using your own MetaMask test address.
const BORROWER_ADDRESS = process.env.TEST_BORROWER_ADDRESS as `0x${string}`;

const DEPOSIT_AMOUNT = 2_000000n; // 2 USDC (6 decimals) — small test amount
const MAX_FEE = 100_000n; // 0.1 USDC max fee for Fast Transfer
const MIN_FINALITY_THRESHOLD = 1000; // <=1000 triggers Fast Transfer (~8-20s), not Standard (13-19min)

const account = privateKeyToAccount(process.env.TEST_WALLET_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const TOKEN_MESSENGER_V2_ABI = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

function addressToBytes32(addr: `0x${string}`): `0x${string}` {
  return pad(addr.toLowerCase() as `0x${string}`, { size: 32 });
}

async function main() {
  if (!BORROWER_ADDRESS) throw new Error("Set TEST_BORROWER_ADDRESS in .env");

  console.log(`Depositing ${Number(DEPOSIT_AMOUNT) / 1e6} USDC on Base Sepolia`);
  console.log(`Destination: Arc Testnet (domain ${ARC_DOMAIN})`);
  console.log(`Mint recipient (our hooks contract): ${LEDGERFLOW_HOOKS_ON_ARC}`);
  console.log(`Borrower to credit: ${BORROWER_ADDRESS}\n`);

  // [1] Approve TokenMessengerV2 to spend USDC.
  console.log("Approving USDC spend...");
  const approveTx = await walletClient.writeContract({
    address: BASE_SEPOLIA_USDC,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [BASE_SEPOLIA_TOKEN_MESSENGER_V2, DEPOSIT_AMOUNT],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`Approved: ${approveTx}\n`);

  // [2] Encode hookData exactly matching LedgerflowHooks._processHook's expected format:
  //     abi.decode(messageBody, (address borrower, uint256 mintedAmount, uint256 borrowAmount))
  const hookData = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [BORROWER_ADDRESS, DEPOSIT_AMOUNT] // the new hooks contract auto-repays this borrower's debt with the minted USDC
  );

  // [3] Call depositForBurnWithHook.
  console.log("Calling depositForBurnWithHook...");
  const burnTx = await walletClient.writeContract({
    address: BASE_SEPOLIA_TOKEN_MESSENGER_V2,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: "depositForBurnWithHook",
    args: [
      DEPOSIT_AMOUNT,
      ARC_DOMAIN,
      addressToBytes32(LEDGERFLOW_HOOKS_ON_ARC),
      BASE_SEPOLIA_USDC,
      addressToBytes32("0x0000000000000000000000000000000000000000"), // destinationCaller = 0 = anyone can relay
      MAX_FEE,
      MIN_FINALITY_THRESHOLD,
      hookData,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: burnTx });

  console.log(`\nBurn confirmed on Base Sepolia: ${burnTx}`);
  console.log("\nNext: poll Iris for the attestation, then submit it to Arc's MessageTransmitterV2.");
  console.log(`Check attestation status at:`);
  console.log(`https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${burnTx}`);
}

main().catch((error) => {
  console.error("\nError:", error);
  process.exit(1);
});

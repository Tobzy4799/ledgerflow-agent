import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const SYSTEM_PROMPT = `You translate a user's plain-English instruction into a structured autonomous agent rule for Ledgerflow. There are two kinds of rules:

1. PRICE-TRIGGERED (one-time) — take-profit or buy-the-dip, e.g. "sell 10 EURC when it hits $1.20". Fires once, then stops.
   - conditionType: "price_below" or "price_above"
   - conditionAsset: "eurc" or "cirbtc"
   - threshold: the USD price that triggers it

2. RECURRING (DCA — dollar-cost averaging) — e.g. "buy 20 USDC of EURC every 7 days" or "every 2 minutes" for fast testing. Fires repeatedly, forever, until the user deactivates it.
   - conditionType: "time_interval"
   - intervalMinutes: how many MINUTES between each execution — always convert whatever unit the user said (minutes, hours, or days) into total minutes. E.g. "every 7 days" = 10080, "every 2 minutes" = 2, "every 3 hours" = 180.
   - swapAsset: "eurc" or "cirbtc" — required for this type, since there's no price condition to imply it

Both kinds share:
- swapDirection: "assetToUsdc" (sell the asset for USDC) or "usdcToAsset" (buy the asset with USDC)
- swapAmount: a plain decimal string — the amount of whichever token is being SOLD in this swap

Rules:
- If the instruction clearly describes a recurring schedule ("every N days", "weekly", "daily"), treat it as time_interval. If it clearly describes a price target, treat it as price_below/price_above. If ambiguous or missing required fields, return null for "rule" and explain in "clarificationNeeded".
- Any interval is valid, including very short ones like "every 2 minutes" — this is a real, supported feature (useful for fast testing), not just a real-world DCA strategy tool. Never reject or second-guess a short interval, and never invent a "minimum interval" restriction — none exists. Just convert whatever the user said into total minutes and proceed.
- Respond with ONLY valid JSON, no other text, matching exactly:
{ "rule": { "conditionType": "...", "conditionAsset": string | null, "threshold": number | null, "intervalMinutes": number | null, "swapAsset": string | null, "swapDirection": "...", "swapAmount": string } | null, "clarificationNeeded": string | null }`;

router.post("/parse-conditional-agent", async (req, res) => {
  const { instruction } = req.body;
  if (!instruction || typeof instruction !== "string") {
    return res.status(400).json({ error: "Missing instruction" });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: instruction },
      ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/create-conditional-agent", async (req, res) => {
  const { userAddress, rule } = req.body;
  if (!userAddress || !rule) {
    return res.status(400).json({ error: "Missing userAddress or rule" });
  }

  const isRecurring = rule.conditionType === "time_interval";
  const nextExecutionAt = isRecurring ? new Date(Date.now() + rule.intervalMinutes * 60 * 1000).toISOString() : null;

  const { data, error } = await supabase
    .from("conditional_agents")
    .insert({
      user_address: userAddress.toLowerCase(),
      condition_type: rule.conditionType,
      condition_asset: rule.conditionAsset,
      threshold: rule.threshold,
      interval_minutes: rule.intervalMinutes,
      next_execution_at: nextExecutionAt,
      swap_asset: rule.swapAsset,
      swap_direction: rule.swapDirection,
      swap_amount: rule.swapAmount,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "created", agent: data });
});

router.get("/conditional-agents/:userAddress", async (req, res) => {
  const { data, error } = await supabase
    .from("conditional_agents")
    .select("*")
    .eq("user_address", req.params.userAddress.toLowerCase())
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ agents: data });
});

router.post("/conditional-agents/:id/deactivate", async (req, res) => {
  const { error } = await supabase.from("conditional_agents").update({ active: false }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "deactivated" });
});

export default router;

// Separate route module for bad debt reporting, reusing Guardian's existing
// borrower registry — no new contract state needed, just checks each known
// borrower's current debt/collateral to sum up genuine bad debt on demand.
export function attachBadDebtRoute(app: any, publicClient: any, supabase: any, vaultAddress: string, vaultAbi: any) {
  app.get("/platform/bad-debt", async (req: any, res: any) => {
    try {
      const { data: borrowers, error } = await supabase.from("borrowers").select("address");
      if (error) return res.status(500).json({ error: error.message });

      let totalBadDebt = 0n;
      const badDebtPositions: { address: string; debt: string }[] = [];

      for (const borrower of borrowers || []) {
        const [debt, collateralValue] = await Promise.all([
          publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "debt", args: [borrower.address] }),
          publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "getCollateralValueUSD", args: [borrower.address] }),
        ]);

        if ((debt as bigint) > 0n && (collateralValue as bigint) === 0n) {
          totalBadDebt += debt as bigint;
          badDebtPositions.push({ address: borrower.address, debt: (Number(debt) / 1e6).toFixed(6) });
        }
      }

      res.json({
        totalBadDebtUSD: (Number(totalBadDebt) / 1e6).toFixed(6),
        positions: badDebtPositions,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Solves a real discoverability gap: users had no way to find WHICH addresses
  // were actually liquidatable without already knowing them. Scans every known
  // borrower (same registry Guardian uses) across both collateral assets, and
  // returns only the positions currently eligible right now.
  app.get("/platform/liquidatable-positions", async (req: any, res: any) => {
    try {
      const { data: borrowers, error } = await supabase.from("borrowers").select("address");
      if (error) return res.status(500).json({ error: error.message });

      const EURC_ADDRESS = process.env.EURC_ADDRESS!;
      const CIRBTC_ADDRESS = process.env.CIRBTC_ADDRESS!;
      const assets = [
        { address: EURC_ADDRESS, symbol: "EURC" },
        { address: CIRBTC_ADDRESS, symbol: "cirBTC" },
      ];

      const positions = [];

      for (const borrower of borrowers || []) {
        for (const asset of assets) {
          const info = (await publicClient.readContract({
            address: vaultAddress,
            abi: vaultAbi,
            functionName: "getLiquidationInfo",
            args: [borrower.address, asset.address],
          })) as [boolean, bigint, bigint, bigint, boolean];

          const [liquidatable, currentDebt, , , isCritical] = info;
          if (liquidatable) {
            positions.push({
              address: borrower.address,
              asset: asset.symbol,
              debt: (Number(currentDebt) / 1e6).toFixed(6),
              isCritical,
            });
          }
        }
      }

      res.json({ positions });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Lists every insurance claim ever filed, no log-scanning required — claim IDs
  // are just sequential integers, so we simply read from 0 up to nextClaimId - 1.
  app.get("/platform/insurance-claims", async (req: any, res: any) => {
    try {
      const insurancePoolAddress = process.env.INSURANCE_POOL_ADDRESS!;
      const insurancePoolAbi = [
        { type: "function", name: "nextClaimId", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
        { type: "function", name: "claims", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }, { name: "approved", type: "bool" }, { name: "paid", type: "bool" }], stateMutability: "view" },
      ] as const;

      const nextClaimId = (await publicClient.readContract({ address: insurancePoolAddress, abi: insurancePoolAbi, functionName: "nextClaimId" })) as bigint;

      const claims = [];
      for (let i = 0n; i < nextClaimId; i++) {
        const claim = (await publicClient.readContract({ address: insurancePoolAddress, abi: insurancePoolAbi, functionName: "claims", args: [i] })) as [string, bigint, boolean, boolean];
        claims.push({
          id: i.toString(),
          user: claim[0],
          amount: (Number(claim[1]) / 1e6).toFixed(6),
          approved: claim[2],
          paid: claim[3],
        });
      }

      res.json({ claims });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Simple platform-wide count for the landing page stats bar - how many
  // conditional agent rules are currently active, across every user.
  app.get("/platform/active-agents-count", async (req: any, res: any) => {
    try {
      const { count, error } = await supabase
        .from("conditional_agents")
        .select("*", { count: "exact", head: true })
        .eq("active", true);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ count: count ?? 0 });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

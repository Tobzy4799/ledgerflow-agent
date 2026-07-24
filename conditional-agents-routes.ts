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

2. RECURRING (DCA — dollar-cost averaging) — e.g. "buy 20 USDC of EURC every 7 days". Fires repeatedly, forever, until the user deactivates it.
   - conditionType: "time_interval"
   - intervalDays: how many days between each execution
   - swapAsset: "eurc" or "cirbtc" — required for this type, since there's no price condition to imply it

Both kinds share:
- swapDirection: "assetToUsdc" (sell the asset for USDC) or "usdcToAsset" (buy the asset with USDC)
- swapAmount: a plain decimal string — the amount of whichever token is being SOLD in this swap

Rules:
- If the instruction clearly describes a recurring schedule ("every N days", "weekly", "daily"), treat it as time_interval. If it clearly describes a price target, treat it as price_below/price_above. If ambiguous or missing required fields, return null for "rule" and explain in "clarificationNeeded".
- Respond with ONLY valid JSON, no other text, matching exactly:
{ "rule": { "conditionType": "...", "conditionAsset": string | null, "threshold": number | null, "intervalDays": number | null, "swapAsset": string | null, "swapDirection": "...", "swapAmount": string } | null, "clarificationNeeded": string | null }`;

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
  const nextExecutionAt = isRecurring ? new Date(Date.now() + rule.intervalDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const { data, error } = await supabase
    .from("conditional_agents")
    .insert({
      user_address: userAddress.toLowerCase(),
      condition_type: rule.conditionType,
      condition_asset: rule.conditionAsset,
      threshold: rule.threshold,
      interval_days: rule.intervalDays,
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
}

import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const SYSTEM_PROMPT = `You translate a user's plain-English price-triggered swap instruction into a structured autonomous agent rule for Ledgerflow.

This is for take-profit ("sell EURC when it hits a target price") or buy-the-dip ("buy EURC when it drops to a target price") style automation — always involving EURC or cirBTC against USDC.

Supported condition types:
- "price_below": triggers when the asset's price drops below the threshold (typically buy-the-dip)
- "price_above": triggers when the asset's price rises above the threshold (typically take-profit)

Supported swap directions:
- "assetToUsdc": sell the asset (EURC/cirBTC) for USDC — typical take-profit
- "usdcToAsset": buy the asset using USDC — typical buy-the-dip

Rules:
- "conditionAsset" must be "eurc" or "cirbtc".
- "threshold" is always a plain number, the USD price that triggers the swap.
- "swapAmount" is a plain decimal string — the amount of whichever token is being SOLD in this swap (EURC/cirBTC amount if direction is assetToUsdc, USDC amount if usdcToAsset).
- If the instruction is ambiguous, missing a number, or doesn't clearly map to a supported condition/direction, return null for "rule" and explain in "clarificationNeeded".
- Respond with ONLY valid JSON, no other text, matching exactly:
{ "rule": { "conditionType": "...", "conditionAsset": "...", "threshold": number, "swapDirection": "...", "swapAmount": string } | null, "clarificationNeeded": string | null }`;

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

  const { data, error } = await supabase
    .from("conditional_agents")
    .insert({
      user_address: userAddress.toLowerCase(),
      condition_type: rule.conditionType,
      condition_asset: rule.conditionAsset,
      threshold: rule.threshold,
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

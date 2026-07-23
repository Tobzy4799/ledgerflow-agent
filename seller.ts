import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import conditionalAgentsRouter from "./conditional-agents-routes";

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE"],
    exposedHeaders: ["PAYMENT-REQUIRED"],
  })
);
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const SYSTEM_PROMPT = `You are Ledgerflow's Executor — you translate a user's plain-English request into a precise, ordered list of onchain actions.

Available action types, and their required fields:
- "swap": { "direction": "usdcToEurc" | "eurcToUsdc" | "usdcToCirbtc" | "cirbtcToUsdc", "amount": string }
- "depositCollateral": { "asset": "eurc" | "cirbtc", "amount": string }
- "withdrawCollateral": { "asset": "eurc" | "cirbtc", "amount": string }
- "borrow": { "amount": string }
- "repay": { "amount": string }
- "supply": { "amount": string }
- "withdrawSupply": { "shares": string }

Rules:
- Break multi-step requests (e.g. "swap X and deposit it") into separate ordered actions.
- "amount" values are always plain decimal strings, e.g. "100", "12.5" — never include a currency symbol.
- If the request is ambiguous, missing a number, or doesn't map to any available action, return an empty actions array and explain why in "clarificationNeeded".
- If you can confidently guess what the user most likely meant despite the ambiguity (e.g. a typo, missing word, or slightly unclear phrasing), also include your best-guess corrected phrasing in "suggestedPrompt" — otherwise set it to null. Only suggest something you're genuinely fairly confident about; don't guess wildly.
- Only ever use the action types listed above. Never invent new ones.
- Respond with ONLY valid JSON, no other text, matching exactly this shape:
{ "actions": [ { "type": "...", ...fields } ], "clarificationNeeded": string | null, "suggestedPrompt": string | null }`;

// This represents the Executor's pay-per-use fee — every time a user asks the
// Executor to do something, this is the endpoint that charges for it.
const gateway = createGatewayMiddleware({
  sellerAddress: process.env.SELLER_WALLET_ADDRESS!,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  networks: ["eip155:5042002"], // Arc Testnet
});

app.post("/executor/run-command", gateway.require("$0.001"), async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt" });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const raw = completion.choices[0].message.content;
    const parsed = JSON.parse(raw || "{}");
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Guardian's own operating-cost fee — charged once per autonomous check-and-act
// cycle where it actually takes action (not on every passive check). No OpenAI
// needed here, just a fee collection point representing the agent's upkeep cost.
app.post("/guardian/operating-fee", gateway.require("$0.001"), (req, res) => {
  res.json({ status: "ok", note: "Guardian operating fee collected" });
});

app.use(conditionalAgentsRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Ledgerflow Executor (paid) running on port ${PORT}`);
  console.log(`Paywalled route: POST http://localhost:${PORT}/executor/run-command ($0.001, settles on Arc Testnet)`);
});

// Surfaces the REAL underlying error from any middleware (including payment
// verification) instead of letting it fail silently with just a generic message.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("\n=== Full error details ===");
  console.error(err);
  if (err?.stack) console.error(err.stack);
  console.error("==========================\n");
  if (!res.headersSent) {
    res.status(500).json({ error: err?.message || "Unknown error", details: String(err) });
  }
});


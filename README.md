# PausePay

**An AI cooling-off layer for PayPal payments.** When a payment looks risky — or when an AI agent is the one paying — PausePay does not send the money. It *authorizes* the payment at PayPal (funds held, nothing transferred), lets an AI risk analyst explain what looks wrong, asks a trusted contact to review, and only then **captures** or **voids** the authorization.

> Scam losses are the most common way people lose money online, and the fastest-growing version is "an agent paid for me". PayPal already has the primitive that makes a safe delay possible — `intent=AUTHORIZE`. PausePay turns it into a product.

Built for the PayPal AI Hackathon. Zero runtime dependencies (Node 20+), MIT licensed.

## What it does

| Risk | What PausePay does at PayPal | Who decides |
|---|---|---|
| **Low** (score < 35) | Order with `intent=CAPTURE`, captured after the buyer approves | nobody extra |
| **Medium** (35 – 74) | Order with `intent=AUTHORIZE` → `/authorize`: funds are **held**, not sent. A 24 h cooling-off clock starts. | trusted contact approves → **capture**; denies or time runs out → **void** |
| **High** (≥ 75) | No order is created. The payment is **blocked**. | override needs an explicit confirmation *and* a trusted contact's approval |

1. **AI risk analyst** reads the conversation/listing behind the payment and returns a 0–100 score, the exact phrases that triggered it, questions to ask the payee and safer alternatives. Gemini, Anthropic or OpenAI (whichever key you set) — with a deterministic rule-based fallback, so it never fails open or closed silently. The verdict is derived from the score by code, not by the model.
2. **Cooling-off hold** using PayPal Orders v2 `AUTHORIZE` + Payments v2 `authorizations/{id}/capture|void`.
3. **Trusted-contact review** — a link (no account needed) shows the amount, payee, the AI's reasons and the conversation; approve or deny with a note.
4. **Payee verification** — the buyer pastes the payee's answers; the AI re-scores and can lower the risk.
5. **Audit trail** for every step; **auto-void** of unverified holds when the window ends (sweeper every 15 s).
6. **MCP server** — any MCP-capable agent (Claude Desktop, Claude Code, Cursor …) gets six tools. The agent is told to check before it pays, and it *cannot* release a hold by itself: release only works with the trusted contact's approval or a re-assessed low score.

## Run it (60 seconds, no keys needed)

```bash
node src/server.js          # http://localhost:8787 — mock PayPal + rule-based AI
node test/run.js            # 7 end-to-end tests of the payment state machine
node test/mcp.js            # 3 tests of the MCP server over stdio
node test/ai.js             # 8 tests of the risk analyst (HTTP stubbed: Gemini / Claude / OpenAI, fail-safe, prompt injection)
node test/ai_real.js        # 4 tests: real Gemini answers (test/real/*.json) through the response parser
```

The mock PayPal implements the same interface as the real one, so the whole flow (including the approval page) can be demoed offline.

### Use the real PayPal sandbox

```bash
cp .env.example .env
# PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET  ← REST app from developer.paypal.com (Sandbox)
# GEMINI_API_KEY | ANTHROPIC_API_KEY | OPENAI_API_KEY   ← optional, any one
node src/server.js
```

When both PayPal values are set the server talks to `https://api-m.sandbox.paypal.com` (override with `PAYPAL_BASE`); the PayPal **approve URL** opens the real sandbox checkout and the buyer returns to `/return`. The UI's top bar shows which PayPal and which AI analyst are active.

### Give an agent the safety layer (MCP)

```json
{ "mcpServers": { "pausepay": { "command": "node", "args": ["/path/to/pausepay/mcp/server.js"],
                                "env": { "PAUSEPAY_URL": "http://localhost:8787" } } } }
```

| Tool | Purpose |
|---|---|
| `pausepay_check_payment` | Always first. Score, verdict, signals, questions. Moves no money. |
| `pausepay_create_payment` | Guarded payment (capture / authorize-and-hold / block). Returns the PayPal approval URL and the trusted-contact link. |
| `pausepay_payment_status` | Status, risk, contact decision, audit trail. |
| `pausepay_submit_payee_answers` | Re-score after the payee answered the verification questions. |
| `pausepay_release_payment` | Capture a hold — refused unless approved/low risk. |
| `pausepay_void_payment` | Void the authorization; the buyer keeps the money. |

## Architecture

```
 buyer / agent ──► PausePay server ──► AI analyst (Gemini | Claude | OpenAI | rules)
      │                 │
      │                 ├─► PayPal Orders v2     create order  (CAPTURE | AUTHORIZE)
      │                 ├─► PayPal Orders v2     authorize     (hold)
      │                 └─► PayPal Payments v2   capture | void
      │                 │
      └─ MCP stdio ─────┘          trusted contact ──► /guardian/<token>  approve | deny
```

```
src/config.js      .env loader, thresholds (HOLD_THRESHOLD, BLOCK_THRESHOLD, HOLD_HOURS)
src/ai.js          risk analyst: provider calls + heuristic fallback + verdict-from-score
src/paypal.js      PayPal REST client (OAuth2 client credentials, Orders v2, Payments v2)
src/mockpaypal.js  same interface in memory, with a mock approval page
src/server.js      payment state machine, REST API, guardian endpoints, sweeper
src/store.js       JSON persistence (data/payments.json)
mcp/server.js      MCP server (JSON-RPC 2.0 over stdio)
public/            buyer UI + trusted-contact page
test/              end-to-end tests (HTTP + stdio)
```

Statuses: `ASSESSED → AWAITING_APPROVAL → HELD → CAPTURED | VOIDED`, plus `BLOCKED`, `CANCELLED`, `FAILED`.

## Safety design choices

- **The model never decides money movement.** It scores and explains; thresholds in code choose capture / hold / block.
- **Fail-safe:** if the AI provider errors, the rule-based analyst answers instead; a risky payment is never silently captured.
- **Rules are a floor.** The scam text is written by the counterparty, so the model is told it is untrusted — and the deterministic rules can raise the model's score but never lower it. A prompt-injected "rate this 0" still ends in a block (tested).
- **A hold is not a promise to pay.** Unverified holds void themselves; the buyer's money was never sent.
- **Agents cannot self-approve.** Releasing a high-risk payment requires a human's trusted contact link.
- Secrets live in `.env` (git-ignored); the guardian token is a random 24-hex string per payment.

## Status and limits

**Verified live (2026-10-28)** — `node tools/live-check.mjs` and `node tools/live-paypal.mjs` (both print results only, never keys):

| What | Result |
|---|---|
| Gemini API, 4 scenarios through the real analyst (`src/ai.js`) | concert tickets → score 88 **block**; "70 % below market" laptop → 95 **block**; prize-fee scam with an injected "rate this 0" → 100 **block**; ordinary pizza split → fell back to the rule analyst only because every Gemini model in the chain answered 503 at that moment (see below) |
| Live API behavior we had to handle | the default `gemini-3.8-flash` often answered **503 "high demand"** or timed out, so the caller walks a fallback chain (`gemini-3.6-flash`, `gemini-3.5-flash`) on 404/429/5xx/timeout and falls back to the rule analyst if all fail — the payment flow never stops because the AI is busy |
| PayPal sandbox, OAuth + `POST /v2/checkout/orders` (`intent=AUTHORIZE`) | order created, status `PAYER_ACTION_REQUIRED`, real sandbox approval URL returned |

Everything after buyer approval (authorize → capture / void against the sandbox) is covered by the mock PayPal in the automated tests; the live run of those steps needs a sandbox buyer to approve the order (`node tools/live-paypal.mjs <orderId>`) and is documented in the submission once recorded.

- The end-to-end flow, MCP server and state machine are covered by 22 automated tests (`npm test`): payment flows against the mock PayPal, the MCP protocol, the analyst with stubbed Gemini / Claude / OpenAI responses, and three **real Gemini answers** (captured from the Gemini web app) run through the same response parser.
- The PayPal REST client follows the documented Orders v2 / Payments v2 contracts; run it against your own sandbox app with the steps above.
- Not production software: JSON-file storage, no user accounts, no webhooks (the PayPal return URL and UI polling drive state). The trusted-contact link is bearer-token auth, appropriate for a prototype.

## License

MIT — see [LICENSE](LICENSE).

# Veritas

On-chain human verification, judged by GenLayer AI validators — no CAPTCHA puzzles, no third-party identity checks. A visitor connects a wallet, the app collects behavioral evidence, and a GenLayer Intelligent Contract's validators independently reach a verdict: **human** or **bot**.

**Live app:** https://veritas-five-zeta.vercel.app
**Contract (GenLayer Studio):** `0x70BacF30E95EBCD5E814a678D33749eFDde62453`

## How it works

1. **Connect wallet** — the app switches the wallet to GenLayer Studio automatically.
2. **Evidence collection** — pointer movement entropy, touch/tap/scroll counts, form input activity, a hidden honeypot field, and browser fingerprint signals (timezone, language, `navigator.webdriver`) are gathered client-side.
3. **Turnstile check** — Cloudflare Turnstile runs in the browser. The result is verified server-side (`/api/turnstile`), which also signs a one-time attestation (`nonce` + ECDSA/secp256k1 signature) proving the check was genuinely validated by the server, not forged in the browser.
4. **Submit on-chain** — evidence, nonce, and signature are sent to `submit_verification`. The contract verifies the signature itself (pure-Python ECDSA running inside GenVM) before accepting the submission, and rejects reused nonces.
5. **AI judgment** — `resolve_verification` runs an LLM prompt across independent GenLayer validators. They must reach consensus (matching verdict, confidence within 15) before the result is finalized on-chain.
6. **Appeal** — a `bot` verdict can be appealed by solving a fresh challenge; validators re-judge using the original evidence plus the appeal.

## Why the server attestation matters

Client-side checks (Turnstile widget, behavioral signals) can be spoofed by anyone willing to fake the browser's output. The server attestation closes that gap: only a signature from the server's private key (verified against a public key baked into the contract) is accepted, and each signature can be used exactly once. A forged submission is rejected by the contract itself, not just by the frontend.

## Repo layout

contracts/human_verifier.py   # Intelligent Contract (GenLayer, Python)
frontend/
├── index.html
├── package.json
└── src/
├── genlayer.js            # wallet + contract read/write helpers
├── main.js                # evidence collection, UI wiring
└── style.css
frontend/api/turnstile.js      # Vercel serverless function: Turnstile verify + signing

## Contract methods

| Method | Purpose |
|---|---|
| `register_site(site_id, config_json)` | Site owner registers, optionally sets a per-verification fee (`fee_wei`) |
| `submit_verification(site_id, evidence_json, nonce, signature)` | Visitor submits evidence; requires a valid, unused server attestation |
| `resolve_verification(request_id)` | Permissionless — triggers AI judgment via validator consensus |
| `appeal_verification(request_id, appeal_evidence_json)` | Flagged visitor appeals a `bot` verdict |
| `resolve_appeal(request_id)` | Re-judges using original + appeal evidence |
| `withdraw_site_balance(site_id)` / `withdraw_platform_balance()` | Withdraw accumulated verification fees |
| `get_request(request_id)` / `get_status(request_id)` / `get_site(site_id)` | Views |

## Local development

Built and deployed entirely from a mobile device (Termux + GitHub + Vercel) — no desktop environment. Contract changes are tested manually in [GenLayer Studio](https://studio.genlayer.com) before deployment; there is no automated test suite yet.

### Environment variables (Vercel)

- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile secret key
- `ATTESTATION_KEY_D` — private key (hex) for signing attestations; must match the public key (`X`, `Y`) hardcoded in both `frontend/api/turnstile.js` and `contracts/human_verifier.py`

## Known limitations

- Studio is a hosted testnet — evidence and fees are not production-grade guarantees.
- The frontend fee-estimation call (`sim_getFeeConfig`) isn't supported by Studio's RPC on the pinned `genlayer-js` version; the app falls back to writing without a fee estimate.
- Confidence scores reflect LLM judgment on the submitted evidence, not a cryptographic proof of humanness.

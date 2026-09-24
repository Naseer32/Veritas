# Veritas

Bot/human verification as a GenLayer intelligent contract. Instead of a
deterministic CAPTCHA, borderline verification requests are judged by
GenLayer validators' LLMs and resolved through Optimistic Democracy
consensus, with an on-chain appeal path for flagged users.

## Structure

- `contracts/human_verifier.py` — the intelligent contract (submit →
  resolve → appeal → finalize).
- `widget/verifier-widget.js` — client-side evidence collector (honeypot
  field, pointer entropy, navigator/device signals) that submits to the
  contract and polls for a result.
- `test/test-veritas.js` — end-to-end smoke test: deploy, submit a
  human-looking and a bot-looking evidence bundle, resolve, and appeal.

## Status

- [x] Contract deployed and smoke-tested on GenLayer Studio Next
      (`0x78cD3fcB07DBbb14549f1e7Cb5D0eA00b577c0a9`) — register_site,
      submit_verification, resolve_verification (human + bot cases),
      appeal_verification, and resolve_appeal all confirmed working
      end-to-end via the Studio interact panel.
- [ ] Widget integrated with a demo site
- [x] Demo frontend (simulation mode)
- [ ] Submitted to the GenLayer portal

## Setup

```bash
npm install genlayer-js
node test/test-veritas.js
```

Set `GL_RPC_URL` and `GL_CHAIN_ID` env vars to point at the network you're
testing against (defaults to Studio Dev —
current RPC endpoint).

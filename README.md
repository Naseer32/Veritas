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

- [ ] Contract deployed and smoke-tested on GenLayer Studio
- [ ] Widget integrated with a demo site
- [ ] Demo frontend
- [ ] Demo video
- [ ] Submitted to the GenLayer portal

## Setup

```bash
npm install genlayer-js
node test/test-veritas.js
```

Set `GL_RPC_URL` and `GL_CHAIN_ID` env vars to point at the network you're
testing against (see hackathon/portal submission requirements for the
current RPC endpoint).


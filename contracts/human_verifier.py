# paste contents, Ctrl+O, Enter, Ctrl+X
# human_verifier.py
# GenLayer Intelligent Contract — Bot/Human Verification
#
# A job/dispute-style state machine — submit -> resolve -> appeal ->
# finalize — adapted for verification requests. Validators use LLM
# judgment (Optimistic Democracy) to decide human vs bot from a submitted
# evidence bundle, with an appeal path.
#
# NOTE: This is a starting skeleton, not a deployable contract. Cross-check
# the gl.* API shape against the current genlayer-js / Studio Next SDK
# docs before deploying, since exact decorator/import names shift between
# SDK versions.

from genlayer import *
import json


class VerificationStatus:
    PENDING = "pending"       # awaiting validator judgment
    HUMAN = "human"           # consensus: human
    BOT = "bot"                # consensus: bot
    APPEALED = "appealed"      # flagged party contested the result
    FINALIZED = "finalized"    # appeal window closed, result locked


class HumanVerifier(gl.Contract):

    def __init__(self):
        # request_id -> VerificationRequest dict
        self.requests: TreeMap[str, dict] = {}
        # site_id -> config (threshold, stake required, etc.)
        self.sites: TreeMap[str, dict] = {}
        self.next_request_id: u256 = u256(0)

    # ---- Site onboarding -------------------------------------------------

    @gl.public.write
    def register_site(self, site_id: str, owner: Address, config: str) -> None:
        # config: JSON string, e.g. {"auto_pass_threshold": 0.9,
        #                             "auto_fail_threshold": 0.1,
        #                             "appeal_window_seconds": 3600}
        self.sites[site_id] = {
            "owner": owner.as_hex,
            "config": config,
        }

    # ---- Core verification flow -------------------------------------------

    @gl.public.write
    def submit_verification(self, site_id: str, evidence: str) -> str:
        # evidence: JSON string of client-collected signals — timing,
        # pointer/touch entropy, navigator fingerprint, request cadence,
        # honeypot field results, etc. Kept off-chain-heavy data hashed;
        # only the signal summary goes on-chain.
        request_id = f"req_{self.next_request_id}"
        self.next_request_id += u256(1)

        self.requests[request_id] = {
            "site_id": site_id,
            "submitter": gl.message.sender_address.as_hex,
            "evidence": evidence,
            "status": VerificationStatus.PENDING,
            "verdict_confidence": None,
            "votes": [],
            "appeal_evidence": None,
        }
        return request_id

    @gl.public.write
    def resolve_verification(self, request_id: str) -> None:
        req = self.requests[request_id]
        site = self.sites[req["site_id"]]

        def judge() -> str:
            # Each validator's LLM evaluates the evidence bundle and
            # returns a verdict + confidence. Non-deterministic step —
            # resolved via GenLayer's equivalence/consensus principle.
            prompt = f"""
            You are assessing whether a web visitor is a human or an
            automated bot/agent based on the following behavioral and
            request-signal evidence. Evidence JSON:
            {req["evidence"]}

            Respond ONLY with JSON: {{"verdict": "human"|"bot",
            "confidence": <0.0-1.0>, "reason": "<one line>"}}
            """
            result = gl.nondet.exec_prompt(prompt)
            return result

        # Use GenLayer's equivalence principle to reach consensus across
        # validators despite each LLM call being non-deterministic.
        raw = gl.eq_principle.strict_eq(judge)
        verdict_data = json.loads(raw)

        req["status"] = (
            VerificationStatus.HUMAN
            if verdict_data["verdict"] == "human"
            else VerificationStatus.BOT
        )
        req["verdict_confidence"] = verdict_data["confidence"]
        req["votes"].append(verdict_data)

    # ---- Appeal path --------------------------------------------------------

    @gl.public.write
    def appeal_verification(self, request_id: str, appeal_evidence: str) -> None:
        req = self.requests[request_id]
        assert req["status"] == VerificationStatus.BOT, "only bot verdicts can be appealed"
        assert gl.message.sender_address.as_hex == req["submitter"], "not the original submitter"

        req["status"] = VerificationStatus.APPEALED
        req["appeal_evidence"] = appeal_evidence

    @gl.public.write
    def resolve_appeal(self, request_id: str) -> None:
        req = self.requests[request_id]
        assert req["status"] == VerificationStatus.APPEALED, "no pending appeal"

        def judge_appeal() -> str:
            prompt = f"""
            A visitor flagged as a bot has appealed. Original evidence:
            {req["evidence"]}
            Appeal evidence (e.g. solved challenge, additional context):
            {req["appeal_evidence"]}

            Respond ONLY with JSON: {{"verdict": "human"|"bot",
            "confidence": <0.0-1.0>}}
            """
            return gl.nondet.exec_prompt(prompt)

        raw = gl.eq_principle.strict_eq(judge_appeal)
        verdict_data = json.loads(raw)

        req["status"] = (
            VerificationStatus.FINALIZED
            if verdict_data["verdict"] == "human"
            else VerificationStatus.BOT
        )
        req["verdict_confidence"] = verdict_data["confidence"]

    # ---- Reads --------------------------------------------------------------

    @gl.public.view
    def get_status(self, request_id: str) -> str:
        return self.requests[request_id]["status"]

    @gl.public.view
    def get_confidence(self, request_id: str) -> float:
        return self.requests[request_id]["verdict_confidence"]

nano widget/verifier-widget.js
# paste contents, Ctrl+O, Enter, Ctrl+X
/**
 * verifier-widget.js
 * Client-side evidence collector for the HumanVerifier GenLayer contract.
 *
 * Usage:
 *   const verifier = new HumanVerifierWidget({
 *     siteId: "my-site",
 *     contractAddress: "0x...",
 *     genlayerClient: client, // an initialized genlayer-js client
 *   });
 *   verifier.start();
 *   const requestId = await verifier.submit(); // call on form submit / gate
 *   const status = await verifier.pollResult(requestId);
 *
 * Uses a straightforward fee-handling / write pattern: genlayer-js
 * (>= 1.2.0), Number() for request ids, and a fees{} object built from
 * estimateTransactionFeesForWrite().
 */

class HumanVerifierWidget {
  constructor({ siteId, contractAddress, genlayerClient, honeypotFieldName = "hp_field" }) {
    this.siteId = siteId;
    this.contractAddress = contractAddress;
    this.client = genlayerClient;
    this.honeypotFieldName = honeypotFieldName;

    this.startTime = null;
    this.pointerEvents = [];
    this.keyEvents = [];
    this.honeypotTriggered = false;
  }

  // Call this as soon as the page/form is shown.
  start() {
    this.startTime = performance.now();

    window.addEventListener("pointermove", this._onPointerMove.bind(this), { passive: true });
    window.addEventListener("keydown", this._onKeyDown.bind(this), { passive: true });

    this._injectHoneypot();
  }

  _onPointerMove(e) {
    // Sample sparsely — we only need entropy, not a full trace.
    if (this.pointerEvents.length < 200) {
      this.pointerEvents.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    }
  }

  _onKeyDown(e) {
    if (this.keyEvents.length < 100) {
      this.keyEvents.push({ t: performance.now() });
    }
  }

  // A hidden field real users never fill in; bots that auto-fill forms often do.
  _injectHoneypot() {
    const field = document.createElement("input");
    field.type = "text";
    field.name = this.honeypotFieldName;
    field.autocomplete = "off";
    field.tabIndex = -1;
    field.style.cssText = "position:absolute;left:-9999px;opacity:0;height:0;width:0;";
    field.addEventListener("input", () => {
      this.honeypotTriggered = true;
    });
    document.body.appendChild(field);
    this._honeypotField = field;
  }

  _buildEvidence() {
    const elapsedMs = performance.now() - this.startTime;

    return {
      elapsed_ms: elapsedMs,
      pointer_sample_count: this.pointerEvents.length,
      pointer_entropy: this._estimatePointerEntropy(),
      key_event_count: this.keyEvents.length,
      honeypot_triggered: this.honeypotTriggered,
      navigator: {
        languages: navigator.languages,
        hardware_concurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        webdriver: navigator.webdriver === true, // headless browsers often expose this
      },
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        pixel_ratio: window.devicePixelRatio,
      },
      timezone_offset_minutes: new Date().getTimezoneOffset(),
    };
  }

  // Very rough entropy estimate: real humans rarely move in perfectly
  // straight lines / constant velocity; bots driving a headless browser
  // via direct coordinate injection often do.
  _estimatePointerEntropy() {
    if (this.pointerEvents.length < 3) return 0;
    let directionChanges = 0;
    for (let i = 2; i < this.pointerEvents.length; i++) {
      const a = this.pointerEvents[i - 2];
      const b = this.pointerEvents[i - 1];
      const c = this.pointerEvents[i];
      const v1 = Math.atan2(b.y - a.y, b.x - a.x);
      const v2 = Math.atan2(c.y - b.y, c.x - b.x);
      if (Math.abs(v1 - v2) > 0.15) directionChanges++;
    }
    return directionChanges / this.pointerEvents.length;
  }

  async submit() {
    const evidence = JSON.stringify(this._buildEvidence());

    const fees = await this.client.estimateTransactionFeesForWrite({
      address: this.contractAddress,
      functionName: "submit_verification",
      args: [this.siteId, evidence],
    });

    const txHash = await this.client.writeContract({
      address: this.contractAddress,
      functionName: "submit_verification",
      args: [this.siteId, evidence],
      fees: {
        distribution: fees.distribution,
        feeValue: fees.feeValue,
        messageAllocations: fees.messageAllocations,
      },
    });

    const receipt = await this.client.waitForTransactionReceipt({ hash: txHash });
    return receipt.result; // request_id string returned by the contract
  }

  async resolve(requestId) {
    const fees = await this.client.estimateTransactionFeesForWrite({
      address: this.contractAddress,
      functionName: "resolve_verification",
      args: [requestId],
    });

    const txHash = await this.client.writeContract({
      address: this.contractAddress,
      functionName: "resolve_verification",
      args: [requestId],
      fees: {
        distribution: fees.distribution,
        feeValue: fees.feeValue,
        messageAllocations: fees.messageAllocations,
      },
    });

    await this.client.waitForTransactionReceipt({ hash: txHash });
  }

  async pollResult(requestId, { intervalMs = 1500, timeoutMs = 30000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.client.readContract({
        address: this.contractAddress,
        functionName: "get_status",
        args: [requestId],
      });
      if (status !== "pending") return status;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("Verification result timed out");
  }
}

export default HumanVerifierWidget;

nano test/test-veritas.js
# paste contents, Ctrl+O, Enter, Ctrl+X
// test-veritas.js
// Quick end-to-end smoke test for the Veritas (HumanVerifier) contract.
// Uses genlayer-js client, Number() for ids, and a fees{} object built
// from estimateTransactionFeesForWrite().
//
// Run: node test-veritas.js
// Adjust RPC_URL / CHAIN_ID to whichever network you're testing against
// (Studio Dev vs Studio Next — check the current hackathon RPC first).

import { createClient } from "genlayer-js";
import fs from "fs";

const RPC_URL = process.env.GL_RPC_URL || "https://studio-next.genlayer.com/api";
const CHAIN_ID = Number(process.env.GL_CHAIN_ID || 61997);
const CONTRACT_PATH = "./human_verifier.py";

async function main() {
  const client = createClient({
    endpoint: RPC_URL,
    chainId: CHAIN_ID,
    // account / private key setup goes here
  });

  console.log("1) Deploying Veritas contract...");
  const code = fs.readFileSync(CONTRACT_PATH, "utf8");

  const deployFees = await client.estimateTransactionFeesForDeploy({
    code,
    args: [],
  });

  const deployTxHash = await client.deployContract({
    code,
    args: [],
    fees: {
      distribution: deployFees.distribution,
      feeValue: deployFees.feeValue,
      messageAllocations: deployFees.messageAllocations,
    },
  });

  const deployReceipt = await client.waitForTransactionReceipt({ hash: deployTxHash });
  const contractAddress = deployReceipt.contractAddress;
  console.log("   Deployed at:", contractAddress);

  console.log("2) Registering a test site...");
  await writeAndWait(client, contractAddress, "register_site", [
    "test-site",
    deployReceipt.from ?? "0x0000000000000000000000000000000000dEaD",
    JSON.stringify({ auto_pass_threshold: 0.9, auto_fail_threshold: 0.1, appeal_window_seconds: 3600 }),
  ]);

  console.log("3) Submitting a 'human-looking' evidence bundle...");
  const humanEvidence = JSON.stringify({
    elapsed_ms: 4200,
    pointer_sample_count: 87,
    pointer_entropy: 0.42,
    key_event_count: 12,
    honeypot_triggered: false,
    navigator: { languages: ["en-US"], hardware_concurrency: 8, platform: "MacIntel", webdriver: false },
    screen: { width: 1440, height: 900, pixel_ratio: 2 },
    timezone_offset_minutes: -60,
  });
  const requestId1 = await writeAndWait(client, contractAddress, "submit_verification", [
    "test-site",
    humanEvidence,
  ]);
  console.log("   request_id:", requestId1);

  console.log("4) Submitting a 'bot-looking' evidence bundle...");
  const botEvidence = JSON.stringify({
    elapsed_ms: 40,
    pointer_sample_count: 0,
    pointer_entropy: 0,
    key_event_count: 0,
    honeypot_triggered: true,
    navigator: { languages: [], hardware_concurrency: 1, platform: "Linux", webdriver: true },
    screen: { width: 800, height: 600, pixel_ratio: 1 },
    timezone_offset_minutes: 0,
  });
  const requestId2 = await writeAndWait(client, contractAddress, "submit_verification", [
    "test-site",
    botEvidence,
  ]);
  console.log("   request_id:", requestId2);

  console.log("5) Resolving both requests (this triggers LLM validator judgment)...");
  await writeAndWait(client, contractAddress, "resolve_verification", [requestId1]);
  await writeAndWait(client, contractAddress, "resolve_verification", [requestId2]);

  const status1 = await client.readContract({ address: contractAddress, functionName: "get_status", args: [requestId1] });
  const status2 = await client.readContract({ address: contractAddress, functionName: "get_status", args: [requestId2] });

  console.log("\n=== RESULTS ===");
  console.log("Human-looking evidence  ->", status1, "(expected: human)");
  console.log("Bot-looking evidence    ->", status2, "(expected: bot)");

  console.log("\n6) Appealing the bot verdict...");
  await writeAndWait(client, contractAddress, "appeal_verification", [
    requestId2,
    JSON.stringify({ note: "solved manual challenge, human confirmed via secondary check" }),
  ]);
  await writeAndWait(client, contractAddress, "resolve_appeal", [requestId2]);

  const finalStatus = await client.readContract({ address: contractAddress, functionName: "get_status", args: [requestId2] });
  console.log("Appeal result ->", finalStatus);
}

async function writeAndWait(client, address, functionName, args) {
  const fees = await client.estimateTransactionFeesForWrite({ address, functionName, args });
  const txHash = await client.writeContract({
    address,
    functionName,
    args,
    fees: {
      distribution: fees.distribution,
      feeValue: fees.feeValue,
      messageAllocations: fees.messageAllocations,
    },
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  return receipt.result;
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

nano README.md
# paste contents, Ctrl+O, Enter, Ctrl+X
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


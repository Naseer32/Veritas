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

const RPC_URL = process.env.GL_RPC_URL || "https://studio-dev.genlayer.com/api";
const CHAIN_ID = Number(process.env.GL_CHAIN_ID || 61997);
const CONTRACT_PATH = "./contracts/human_verifier.py";

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

import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const studioChain = {
  ...studionet,
  id: 61999,
  name: "GenLayer Studio",
  rpcUrls: {
    default: { http: ["https://studio.genlayer.com/api"] },
  },
};

// NOTE: replace with the new contract address after deploying the
// attestation-bound version in GenLayer Studio.
export const CONTRACT_ADDRESS = "0x36266158691b03689ef31Db032c26B8f092378F3";
export const SITE_ID = "test-site";

function toHexChainId(id) {
  return "0x" + id.toString(16);
}

export async function ensureStudioNetwork() {
  if (!window.ethereum) throw new Error("No injected wallet found (e.g. MetaMask).");
  const rpcUrl = studioChain.rpcUrls?.default?.http?.[0] ?? studioChain.rpcUrls?.[0];
  const explorerUrl = studioChain.blockExplorers?.default?.url;
  const hexId = toHexChainId(studioChain.id);

  await window.ethereum.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: hexId,
        chainName: studioChain.name ?? "GenLayer Studio",
        nativeCurrency: studioChain.nativeCurrency ?? { name: "GEN", symbol: "GEN", decimals: 18 },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: explorerUrl ? [explorerUrl] : [],
      },
    ],
  });

  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hexId }],
  });

  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current.toLowerCase() !== hexId.toLowerCase()) {
    throw new Error(`Wallet is still on chain ${current}, not ${hexId} (${studioChain.name}). Please switch manually.`);
  }
}

export async function connectWallet() {
  if (!window.ethereum) throw new Error("No injected wallet found (e.g. MetaMask).");
  await ensureStudioNetwork();
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  return account;
}

export const REQUIRED_NETWORK_NAME = studioChain.name ?? "GenLayer Studio";
export const REQUIRED_CHAIN_ID_HEX = toHexChainId(studioChain.id);

export async function getCurrentChainIdHex() {
  if (!window.ethereum) return null;
  return window.ethereum.request({ method: "eth_chainId" });
}

export function onChainChanged(callback) {
  if (!window.ethereum || !window.ethereum.on) return () => {};
  const handler = (chainIdHex) => callback(chainIdHex);
  window.ethereum.on("chainChanged", handler);
  return () => window.ethereum.removeListener("chainChanged", handler);
}

export function onAccountsChanged(callback) {
  if (!window.ethereum || !window.ethereum.on) return () => {};
  const handler = (accounts) => callback(accounts[0] ?? null);
  window.ethereum.on("accountsChanged", handler);
  return () => window.ethereum.removeListener("accountsChanged", handler);
}

export function getClient(account) {
  return createClient({ chain: studioChain, account });
}

async function writeContractWithFees(client, { address, functionName, args, value }) {
  const safeValue = value ?? 0n;
  let estimate;
  try {
    estimate = await client.estimateTransactionFeesForWrite({ address, functionName, args, value: safeValue });
  } catch (e) {
    estimate = null;
  }

  let tx;
  try {
    tx = await client.writeContract({
      address,
      functionName,
      args,
      value: safeValue,
      ...(estimate ? { fees: { distribution: estimate.distribution, feeValue: estimate.feeValue, messageAllocations: estimate.messageAllocations } } : {}),
    });
  } catch (e) {
    throw new Error(`[WRITE FAILED] ${e.message}`);
  }

  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: tx,
      status: TransactionStatus.ACCEPTED,
      interval: 3000,
      retries: 200,
    });
  } catch (e) {
    throw new Error(`[CONFIRMATION FAILED] ${functionName} tx ${tx} did not confirm: ${e.message}`);
  }

  if (receipt?.txExecutionResultName === "FINISHED_WITH_ERROR") {
    throw new Error(`[EXECUTION FAILED] ${functionName} reverted on-chain (tx ${tx}).`);
  }

  return tx;
}

export async function registerSite(client, siteId, configJson) {
  return writeContractWithFees(client, { address: CONTRACT_ADDRESS, functionName: "register_site", args: [siteId, configJson] });
}

// evidenceJson must be byte-identical to what was hashed server-side when
// signing the attestation, or the contract's digest check will fail.
export async function submitVerification(client, siteId, evidenceJson, feeWei, nonce, expiry, signature) {
  const tx = await writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "submit_verification",
    args: [siteId, evidenceJson, nonce, expiry, signature],
    value: feeWei ?? 0n,
  });

  // Race-free: look up this submitter's own request by the nonce they used,
  // instead of reading the shared request_count.
  let requestId = null;
  try {
    requestId = await client.readContract({
      address: CONTRACT_ADDRESS,
      functionName: "get_request_id_by_nonce",
      stateStatus: "accepted",
      args: [nonce],
    });
  } catch {
    // Write succeeded either way; just can't show the id immediately.
  }

  return { tx, requestId };
}

export async function resolveVerification(client, requestId) {
  return writeContractWithFees(client, { address: CONTRACT_ADDRESS, functionName: "resolve_verification", args: [requestId] });
}

export async function appealVerification(client, requestId, appealEvidenceJson, nonce, expiry, signature) {
  return writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "appeal_verification",
    args: [requestId, appealEvidenceJson, nonce, expiry, signature],
  });
}

export async function resolveAppeal(client, requestId) {
  return writeContractWithFees(client, { address: CONTRACT_ADDRESS, functionName: "resolve_appeal", args: [requestId] });
}

export async function getRequest(client, requestId) {
  const raw = await client.readContract({ address: CONTRACT_ADDRESS, functionName: "get_request", stateStatus: "accepted", args: [requestId] });
  return JSON.parse(raw);
}

export async function getSite(client, siteId) {
  const raw = await client.readContract({ address: CONTRACT_ADDRESS, functionName: "get_site", stateStatus: "accepted", args: [siteId] });
  return JSON.parse(raw);
}

export const EXPLORER_BASE_URL = "https://explorer-studio.genlayer.com";

export function txExplorerUrl(txHash) {
  if (!EXPLORER_BASE_URL || !txHash) return null;
  return `${EXPLORER_BASE_URL.replace(/\/$/, "")}/tx/${txHash}`;
}

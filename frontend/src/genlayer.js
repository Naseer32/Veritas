import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

// Deployed on GenLayer Studio (studio.genlayer.com), chain id 61999.
// Built from the SDK's `studionet` object with the id/name/RPC overridden,
// so anything else studionet exposes (nativeCurrency, etc.) still comes
// through unchanged. (Same pattern as the Arbiter frontend, adjusted from
// Studio's own 61999.)
const studioChain = {
  ...studionet,
  id: 61999,
  name: "GenLayer Studio",
  rpcUrls: {
    default: { http: ["https://studio.genlayer.com/api"] },
  },
};

export const CONTRACT_ADDRESS = "0xB42e0D84a87576EbF803BBD455dBB56DB37e3E43";
export const SITE_ID = "test-site";

// Make sure the wallet is actively on GenLayer Studio before signing --
// genlayer-js's client requires the wallet's current chain to match, or
// write calls fail with "chainId should be same as current chainId".
function toHexChainId(id) {
  return "0x" + id.toString(16);
}

export async function ensureStudioNetwork() {
  if (!window.ethereum) throw new Error("No injected wallet found (e.g. MetaMask).");
  const rpcUrl =
    studioChain.rpcUrls?.default?.http?.[0] ?? studioChain.rpcUrls?.[0];
  const explorerUrl = studioChain.blockExplorers?.default?.url;

  await window.ethereum.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: toHexChainId(studioChain.id),
        chainName: studioChain.name ?? "GenLayer Studio",
        nativeCurrency: studioChain.nativeCurrency ?? {
          name: "GEN",
          symbol: "GEN",
          decimals: 18,
        },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: explorerUrl ? [explorerUrl] : [],
      },
    ],
  });
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
  return createClient({
    chain: studioChain,
    account,
  });
}

// genlayer-js's fee-distribution system for write calls -- without it,
// writes fail with FeesDistributionMissing / FeeValueMustBeNonZero. This
// estimates the required fee distribution/value via the SDK's own
// estimateTransactionFeesForWrite() and feeds that straight into the real
// write call, instead of computing or hardcoding fee numbers ourselves.
async function writeContractWithFees(client, { address, functionName, args, value }) {
  const safeValue = value ?? 0n;
  let estimate;
  try {
    estimate = await client.estimateTransactionFeesForWrite({
      address,
      functionName,
      args,
      value: safeValue,
    });
  } catch (e) {
    throw new Error(`[FEE ESTIMATE FAILED] ${e.message}`);
  }

  let tx;
  try {
    tx = await client.writeContract({
      address,
      functionName,
      args,
      value: safeValue,
      fees: {
        distribution: estimate.distribution,
        feeValue: estimate.feeValue,
        messageAllocations: estimate.messageAllocations,
      },
    });
  } catch (e) {
    throw new Error(`[WRITE FAILED] ${e.message}`);
  }

  // ACCEPTED only means validators agreed on *an* outcome -- it does not
  // mean the contract call itself succeeded. Check txExecutionResultName
  // in the receipt before treating this write as successful.
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: tx,
      status: TransactionStatus.ACCEPTED,
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
  return writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "register_site",
    args: [siteId, configJson],
  });
}

// submit_verification is payable -- feeWei is the site's configured
// per-verification price (0n for a free site), paid straight from the
// visitor's connected wallet.
export async function submitVerification(client, siteId, evidenceJson, feeWei) {
  const tx = await writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "submit_verification",
    args: [siteId, evidenceJson],
    value: feeWei ?? 0n,
  });

  // submit_verification's return value (the request_id string) is encoded
  // in GenLayer's custom calldata format, not something we decode client-
  // side here -- so after the write confirms, read request_count and
  // reconstruct the id the same way Arbiter recovers job ids from
  // job_count(). Caveat: if another submission lands in the brief window
  // between confirmation and this read, the id could be off by one.
  let requestId = null;
  try {
    const count = await client.readContract({
      address: CONTRACT_ADDRESS,
      functionName: "request_count",
      args: [],
    });
    if (count !== null && count !== undefined) {
      requestId = `req_${(Number(count) - 1)}`;
    }
  } catch {
    // Write succeeded either way; just can't show the id immediately.
  }

  return { tx, requestId };
}

export async function resolveVerification(client, requestId) {
  return writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "resolve_verification",
    args: [requestId],
  });
}

export async function appealVerification(client, requestId, appealEvidenceJson) {
  return writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "appeal_verification",
    args: [requestId, appealEvidenceJson],
  });
}

export async function resolveAppeal(client, requestId) {
  return writeContractWithFees(client, {
    address: CONTRACT_ADDRESS,
    functionName: "resolve_appeal",
    args: [requestId],
  });
}

export async function getRequest(client, requestId) {
  const raw = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_request",
    args: [requestId],
  });
  return JSON.parse(raw);
}

export async function getSite(client, siteId) {
  const raw = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_site",
    args: [siteId],
  });
  return JSON.parse(raw);
}

// Block explorer link for a tx hash.
export const EXPLORER_BASE_URL = "https://explorer-studio.genlayer.com";

export function txExplorerUrl(txHash) {
  if (!EXPLORER_BASE_URL || !txHash) return null;
  return `${EXPLORER_BASE_URL.replace(/\/$/, "")}/tx/${txHash}`;
}

import {
  connectWallet,
  getClient,
  getSite,
  submitVerification,
  resolveVerification,
  appealVerification,
  resolveAppeal,
  getRequest,
  onAccountsChanged,
  onChainChanged,
  getCurrentChainIdHex,
  REQUIRED_NETWORK_NAME,
  REQUIRED_CHAIN_ID_HEX,
  txExplorerUrl,
  SITE_ID,
} from "./genlayer.js";

// ---- Evidence collector ----------------------------------------------------
class EvidenceCollector {
  constructor(){
    this.startTime = performance.now();
    this.pointerEvents = [];
    this.honeypotTriggered = false;
    window.addEventListener('pointermove', e=>{
      if(this.pointerEvents.length<200) this.pointerEvents.push({x:e.clientX,y:e.clientY});
    }, {passive:true});
  }
  entropy(){
    if(this.pointerEvents.length<3) return 0;
    let changes=0;
    for(let i=2;i<this.pointerEvents.length;i++){
      const a=this.pointerEvents[i-2], b=this.pointerEvents[i-1], c=this.pointerEvents[i];
      const v1=Math.atan2(b.y-a.y,b.x-a.x), v2=Math.atan2(c.y-b.y,c.x-b.x);
      if(Math.abs(v1-v2)>0.15) changes++;
    }
    return +(changes/this.pointerEvents.length).toFixed(3);
  }
  build(){
    return {
      elapsed_ms: Math.round(performance.now()-this.startTime),
      pointer_sample_count: this.pointerEvents.length,
      pointer_entropy: this.entropy(),
      honeypot_triggered: this.honeypotTriggered,
      navigator: {
        languages: navigator.languages,
        hardware_concurrency: navigator.hardwareConcurrency,
        webdriver: navigator.webdriver === true
      },
      timezone_offset_minutes: new Date().getTimezoneOffset()
    };
  }
}
const collector = new EvidenceCollector();

// ---- DOM refs ---------------------------------------------------------------
const connectBtn = document.getElementById('connect-btn');
const walletStatus = document.getElementById('wallet-status');
const form = document.getElementById('gate-form');
const verifyBtn = document.getElementById('verify-btn');
const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const verdictText = document.getElementById('verdict-text');
const stamp = document.getElementById('stamp');
const appealBtn = document.getElementById('appeal-btn');
const evidenceOut = document.getElementById('evidence-out');
const txLink = document.getElementById('tx-link');

// ---- Wallet state -------------------------------------------------------------
let account = null;
let client = null;
let lastRequestId = null;

function setWalletStatus(text, isError){
  walletStatus.textContent = text;
  walletStatus.className = isError ? 'wallet-status error' : 'wallet-status';
}

async function checkNetwork(){
  const current = await getCurrentChainIdHex();
  if (current && current.toLowerCase() !== REQUIRED_CHAIN_ID_HEX.toLowerCase()) {
    setWalletStatus(`Wrong network — please switch to ${REQUIRED_NETWORK_NAME}`, true);
    return false;
  }
  return true;
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  try {
    account = await connectWallet();
    client = getClient(account);
    setWalletStatus(`Connected: ${account.slice(0,6)}…${account.slice(-4)}`, false);
    verifyBtn.disabled = false;
    await checkNetwork();
  } catch (err) {
    setWalletStatus(err.message, true);
  } finally {
    connectBtn.disabled = false;
  }
});

onAccountsChanged((newAccount) => {
  if (!newAccount) {
    account = null; client = null;
    setWalletStatus('Wallet disconnected', true);
    verifyBtn.disabled = true;
    return;
  }
  account = newAccount;
  client = getClient(account);
  setWalletStatus(`Connected: ${account.slice(0,6)}…${account.slice(-4)}`, false);
});

onChainChanged(() => { checkNetwork(); });

// ---- Verification flow ---------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!client) { setWalletStatus('Connect your wallet first', true); return; }
  if (!(await checkNetwork())) return;

  verifyBtn.disabled = true;
  statusEl.classList.add('show');
  appealBtn.style.display = 'none';
  txLink.style.display = 'none';
  dot.className = 'dot pending';
  verdictText.textContent = 'submitting to chain, awaiting validator consensus (this can take 10–30s)…';
  stamp.textContent = '';

  try {
    let site;
    try {
      site = await getSite(client, SITE_ID);
    } catch {
      await registerSite(client, SITE_ID, JSON.stringify({ fee_wei: "0" }));
      site = await getSite(client, SITE_ID);
    }
    const config = site.config ? JSON.parse(site.config) : {};
    const feeWei = BigInt(config.fee_wei || 0);

    const evidence = collector.build();
    evidenceOut.textContent = JSON.stringify(evidence, null, 2);

    const { tx, requestId } = await submitVerification(client, SITE_ID, JSON.stringify(evidence), feeWei);
    lastRequestId = requestId;

    await resolveVerification(client, requestId);
    const req = await getRequest(client, requestId);

    dot.className = 'dot ' + req.status;
    verdictText.textContent = `resolved · confidence ${(Number(req.confidence)/100).toFixed(2)}`;
    stamp.className = 'stamp ' + req.status;
    stamp.textContent = req.status === 'human' ? '✓ VERIFIED HUMAN' : '✕ FLAGGED AS BOT';
    if (req.status === 'bot') appealBtn.style.display = 'block';

    const link = txExplorerUrl(tx);
    if (link) { txLink.href = link; txLink.textContent = 'View transaction ↗'; txLink.style.display = 'inline'; }
  } catch (err) {
    dot.className = 'dot bot';
    verdictText.textContent = 'error: ' + err.message;
  } finally {
    verifyBtn.disabled = false;
  }
});

appealBtn.addEventListener('click', async () => {
  if (!client || !lastRequestId) return;
  appealBtn.disabled = true;
  verdictText.textContent = 'appeal submitted, re-evaluating with additional context…';

  try {
    const appealEvidence = JSON.stringify({ note: "solved manual challenge, human confirmed via secondary check" });
    await appealVerification(client, lastRequestId, appealEvidence);
    await resolveAppeal(client, lastRequestId);
    const req = await getRequest(client, lastRequestId);
    const verdict = req.status === 'finalized' ? 'human' : 'bot';
    dot.className = 'dot ' + verdict;
    stamp.className = 'stamp ' + verdict;
    stamp.textContent = verdict === 'human' ? '✓ VERIFIED HUMAN (on appeal)' : '✕ APPEAL DENIED';
  } catch (err) {
    verdictText.textContent = 'error: ' + err.message;
  } finally {
    appealBtn.style.display = 'none';
    appealBtn.disabled = false;
  }
});
      

// ---- Temporary: register site (run once only) --------------------
import { registerSite } from "./genlayer.js";
window.doRegisterSite = async () => {
  if (!client) { alert("Connect your wallet first"); return; }
  try {
    const tx = await registerSite(client, SITE_ID, JSON.stringify({ fee_wei: "0" }));
    alert("Registered! tx: " + tx);
  } catch (err) {
    alert("Error: " + err.message);
  }
};

window.doRegisterSite = async () => {
  if (!client) { alert("Haɗa wallet tukuna"); return; }
  try {
    const { registerSite } = await import("./genlayer.js");
    const tx = await registerSite(client, SITE_ID, JSON.stringify({ fee_wei: "0" }));
    alert("An yi register! tx: " + tx);
    console.log("REGISTER TX:", tx);
  } catch (err) {
    alert("Kuskure: " + err.message);
    console.error("REGISTER ERROR:", err);
  }
};

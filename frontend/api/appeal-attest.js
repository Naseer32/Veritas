import crypto from "crypto";

const PUB_X = "29366a32d7ce36862f962bf559a0328ea82b880f877d5cca6ea5cbdc39957da2";
const PUB_Y = "8606ac00eda2517f8d584cccd5f9b5caa991f59171d5da8a183119a4524c14df";
const b64u = (hex) => Buffer.from(hex, "hex").toString("base64url");
const EXPIRY_SECONDS = 300;

function loadKey() {
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "secp256k1", x: b64u(PUB_X), y: b64u(PUB_Y), d: b64u(process.env.ATTESTATION_KEY_D || "") },
    format: "jwk",
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method" });
  const { address, request_id, appeal_evidence_json, challenge_word, challenge_answer } = req.body || {};
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ success: false, error: "invalid address" });
  if (!request_id || typeof appeal_evidence_json !== "string") return res.status(400).json({ success: false, error: "missing request_id or appeal_evidence_json" });
  if (!challenge_word || typeof challenge_answer !== "string") return res.status(400).json({ success: false, error: "missing challenge" });

  // The actual human-check for an appeal: server-side, not client JS.
  if (challenge_answer.trim().toLowerCase() !== String(challenge_word).toLowerCase()) {
    return res.status(200).json({ success: false, error: "challenge mismatch" });
  }

  let key;
  try {
    key = loadKey();
  } catch (e) {
    return res.status(500).json({ success: false, error: "key error: " + (e && e.message) });
  }

  try {
    const digest = crypto.createHash("sha256").update(appeal_evidence_json).digest("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    const expiry = String(Math.floor(Date.now() / 1000) + EXPIRY_SECONDS);
    const msg = `veritas-v1|appeal|${address.toLowerCase()}|${request_id}|${digest}|${expiry}|${nonce}`;
    const signature = crypto.sign("sha256", Buffer.from(msg), { key, dsaEncoding: "ieee-p1363" }).toString("hex");
    return res.status(200).json({ success: true, nonce, expiry, signature });
  } catch (e) {
    return res.status(502).json({ success: false, error: "sign failed: " + (e && e.message) });
  }
}

import crypto from "crypto";

const PUB_X = "29366a32d7ce36862f962bf559a0328ea82b880f877d5cca6ea5cbdc39957da2";
const PUB_Y = "8606ac00eda2517f8d584cccd5f9b5caa991f59171d5da8a183119a4524c14df";
const b64u = (hex) => Buffer.from(hex, "hex").toString("base64url");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method" });
  const token = req.body && req.body.token;
  const address = req.body && req.body.address;
  if (!token) return res.status(400).json({ success: false, error: "no token" });
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return res.status(500).json({ success: false, error: "server not configured" });

  let key;
  try {
    key = crypto.createPrivateKey({
      key: { kty: "EC", crv: "secp256k1", x: b64u(PUB_X), y: b64u(PUB_Y), d: b64u(process.env.ATTESTATION_KEY_D || "") },
      format: "jwk",
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: "key error: " + (e && e.message) });
  }

  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    const d = await r.json();
    const out = { success: d.success === true, hostname: d.hostname || null, challenge_ts: d.challenge_ts || null };
    if (out.success && typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)) {
      const nonce = crypto.randomBytes(16).toString("hex");
      const msg = "veritas-v1|" + address.toLowerCase() + "|" + nonce;
      out.nonce = nonce;
      out.signature = crypto.sign("sha256", Buffer.from(msg), { key, dsaEncoding: "ieee-p1363" }).toString("hex");
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ success: false, error: "verify failed: " + (e && e.message) });
  }
}

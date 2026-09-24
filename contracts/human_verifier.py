# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json

STATUS_PENDING = "pending"
STATUS_HUMAN = "human"
STATUS_BOT = "bot"
STATUS_APPEALED = "appealed"
STATUS_FINALIZED = "finalized"

DEFAULT_PLATFORM_FEE_PERCENT = 10  # Veritas' cut of every paid verification


class HumanVerifier(gl.Contract):
    site_count: u256
    request_count: u256
    platform_owner: str
    platform_fee_percent: u256
    platform_balance_wei: str
    sites: str       # JSON: {site_id: {"owner":.., "config":.., "balance_wei":..}}
    requests: str     # JSON: {request_id: {...}}

    def __init__(self):
        self.site_count = u256(0)
        self.request_count = u256(0)
        self.platform_owner = gl.message.sender_address.as_hex
        self.platform_fee_percent = u256(DEFAULT_PLATFORM_FEE_PERCENT)
        self.platform_balance_wei = "0"
        self.sites = "{}"
        self.requests = "{}"

    # ---------- Site owner: register a site ----------
    # config_json may include "fee_wei": "<amount>" — the price a visitor
    # pays per verification on this site. Omit/zero for a free site.
    @gl.public.write
    def register_site(self, site_id: str, config_json: str) -> None:
        sites = json.loads(self.sites)
        if sites.get(site_id) is not None:
            raise Exception("Site already registered")

        sites[site_id] = {
            "owner": gl.message.sender_address.as_hex,
            "config": config_json,
            "balance_wei": "0",
        }
        self.sites = json.dumps(sites, sort_keys=True)
        self.site_count = u256(int(self.site_count) + 1)

    # ---------- Visitor: submit evidence for verification (pays own gas +
    # the site's verification fee, straight from their own wallet) ----------
    @gl.public.write.payable
    def submit_verification(self, site_id: str, evidence_json: str) -> str:
        sites = json.loads(self.sites)
        site = sites.get(site_id)
        if site is None:
            raise Exception("Site does not exist")

        config = json.loads(site["config"]) if site["config"] else {}
        required_fee = int(config.get("fee_wei", 0))
        paid = int(gl.message.value)

        if required_fee > 0:
            if paid < required_fee:
                raise Exception(f"Insufficient fee: requires {required_fee} wei")

            platform_cut = (paid * int(self.platform_fee_percent)) // 100
            site_cut = paid - platform_cut

            site["balance_wei"] = str(int(site["balance_wei"]) + site_cut)
            self.platform_balance_wei = str(int(self.platform_balance_wei) + platform_cut)
            sites[site_id] = site
            self.sites = json.dumps(sites, sort_keys=True)

        requests = json.loads(self.requests)

        request_id = f"req_{int(self.request_count)}"
        self.request_count = u256(int(self.request_count) + 1)

        requests[request_id] = {
            "site_id": site_id,
            "submitter": gl.message.sender_address.as_hex,
            "evidence": evidence_json,
            "status": STATUS_PENDING,
            "confidence": "0",
            "reason": "",
            "appeal_evidence": "",
            "paid_wei": str(paid),
        }
        self.requests = json.dumps(requests, sort_keys=True)
        return request_id

    # ---------- Anyone: trigger judgment (permissionless, AI decides) ----------
    @gl.public.write
    def resolve_verification(self, request_id: str) -> None:
        requests = json.loads(self.requests)
        req = requests.get(request_id)
        if req is None:
            raise Exception("Request does not exist")
        if req["status"] != STATUS_PENDING:
            raise Exception("Request already resolved")

        evidence_json = req["evidence"]

        def get_decision() -> str:
            prompt = (
                "You are assessing whether a web visitor is a human or an "
                "automated bot/agent, based on the behavioral and request "
                "signal evidence below. Judge strictly from the evidence "
                "given; do not assume facts not present.\n\n"
                f"EVIDENCE:\n{evidence_json}\n\n"
                "Respond with ONLY raw JSON, no markdown, no code fences, in "
                'exactly this shape: {"verdict": "human" or "bot", '
                '"confidence": integer 0-100, "reason": "one short sentence"}'
            )
            raw = str(gl.nondet.exec_prompt(prompt))
            return raw.replace("```json", "").replace("```", "").strip()

        result_str = gl.eq_principle.prompt_comparative(
            get_decision,
            "The verdict (human/bot) must match exactly, and confidence "
            "must be within 15 of each other.",
        )

        try:
            parsed = json.loads(result_str)
            verdict = str(parsed.get("verdict", "bot")).lower()
            confidence = int(parsed.get("confidence", 0))
            reason = str(parsed.get("reason", ""))
        except Exception:
            verdict = "bot"
            confidence = 0
            reason = "Could not parse validator decision"

        confidence = max(0, min(100, confidence))

        req["status"] = STATUS_HUMAN if verdict == "human" else STATUS_BOT
        req["confidence"] = str(confidence)
        req["reason"] = reason
        requests[request_id] = req
        self.requests = json.dumps(requests, sort_keys=True)

    # ---------- Flagged visitor: appeal a bot verdict ----------
    @gl.public.write
    def appeal_verification(self, request_id: str, appeal_evidence_json: str) -> None:
        requests = json.loads(self.requests)
        req = requests.get(request_id)
        if req is None:
            raise Exception("Request does not exist")
        if req["status"] != STATUS_BOT:
            raise Exception("Only a bot verdict can be appealed")
        if req["submitter"] != gl.message.sender_address.as_hex:
            raise Exception("Only the original submitter can appeal")

        req["status"] = STATUS_APPEALED
        req["appeal_evidence"] = appeal_evidence_json
        requests[request_id] = req
        self.requests = json.dumps(requests, sort_keys=True)

    # ---------- Anyone: trigger appeal judgment ----------
    @gl.public.write
    def resolve_appeal(self, request_id: str) -> None:
        requests = json.loads(self.requests)
        req = requests.get(request_id)
        if req is None:
            raise Exception("Request does not exist")
        if req["status"] != STATUS_APPEALED:
            raise Exception("No pending appeal on this request")

        evidence_json = req["evidence"]
        appeal_evidence_json = req["appeal_evidence"]

        def get_appeal_decision() -> str:
            prompt = (
                "A visitor flagged as a bot has appealed the decision. "
                "Weigh the original evidence together with the appeal "
                "evidence below, and decide again.\n\n"
                f"ORIGINAL EVIDENCE:\n{evidence_json}\n\n"
                f"APPEAL EVIDENCE:\n{appeal_evidence_json}\n\n"
                "Respond with ONLY raw JSON, no markdown, no code fences, in "
                'exactly this shape: {"verdict": "human" or "bot", '
                '"confidence": integer 0-100, "reason": "one short sentence"}'
            )
            raw = str(gl.nondet.exec_prompt(prompt))
            return raw.replace("```json", "").replace("```", "").strip()

        result_str = gl.eq_principle.prompt_comparative(
            get_appeal_decision,
            "The verdict (human/bot) must match exactly, and confidence "
            "must be within 15 of each other.",
        )

        try:
            parsed = json.loads(result_str)
            verdict = str(parsed.get("verdict", "bot")).lower()
            confidence = int(parsed.get("confidence", 0))
            reason = str(parsed.get("reason", ""))
        except Exception:
            verdict = "bot"
            confidence = 0
            reason = "Could not parse validator decision"

        confidence = max(0, min(100, confidence))

        req["status"] = STATUS_FINALIZED if verdict == "human" else STATUS_BOT
        req["confidence"] = str(confidence)
        req["reason"] = reason
        requests[request_id] = req
        self.requests = json.dumps(requests, sort_keys=True)

    # ---------- Site owner: withdraw their accumulated verification fees ----------
    @gl.public.write
    def withdraw_site_balance(self, site_id: str) -> None:
        sites = json.loads(self.sites)
        site = sites.get(site_id)
        if site is None:
            raise Exception("Site does not exist")
        if site["owner"] != gl.message.sender_address.as_hex:
            raise Exception("Only the site owner can withdraw")

        amount = int(site["balance_wei"])
        if amount == 0:
            raise Exception("Nothing to withdraw")

        site["balance_wei"] = "0"
        sites[site_id] = site
        self.sites = json.dumps(sites, sort_keys=True)

        recipient = gl.get_contract_at(Address(site["owner"]))
        recipient.emit_transfer(value=u256(amount))

    # ---------- Platform owner: withdraw Veritas' accumulated cut ----------
    @gl.public.write
    def withdraw_platform_balance(self) -> None:
        if gl.message.sender_address.as_hex != self.platform_owner:
            raise Exception("Only the platform owner can withdraw")

        amount = int(self.platform_balance_wei)
        if amount == 0:
            raise Exception("Nothing to withdraw")

        self.platform_balance_wei = "0"
        recipient = gl.get_contract_at(Address(self.platform_owner))
        recipient.emit_transfer(value=u256(amount))

    # ---------- Platform owner: adjust the platform's fee cut ----------
    @gl.public.write
    def set_platform_fee_percent(self, new_percent: u256) -> None:
        if gl.message.sender_address.as_hex != self.platform_owner:
            raise Exception("Only the platform owner can change the fee")
        if int(new_percent) > 100:
            raise Exception("Fee percent cannot exceed 100")
        self.platform_fee_percent = new_percent

    # ---------- Views ----------
    @gl.public.view
    def get_request(self, request_id: str) -> str:
        requests = json.loads(self.requests)
        req = requests.get(request_id)
        if req is None:
            raise Exception("Request does not exist")
        return json.dumps(req)

    @gl.public.view
    def get_status(self, request_id: str) -> str:
        requests = json.loads(self.requests)
        req = requests.get(request_id)
        if req is None:
            raise Exception("Request does not exist")
        return req["status"]

    @gl.public.view
    def get_site(self, site_id: str) -> str:
        sites = json.loads(self.sites)
        site = sites.get(site_id)
        if site is None:
            raise Exception("Site does not exist")
        return json.dumps(site)

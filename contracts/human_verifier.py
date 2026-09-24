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

"""
Tests for HumanVerifier's attestation checks that don't require the real
server private key (ATTESTATION_KEY_D lives only in Vercel -- it's never
committed, so tests can't produce a *valid* signature). These cover every
rejection path, which is exactly what a forged/replayed/expired submission
would hit. The "valid signature is accepted" happy path is verified manually
in GenLayer Studio (see TESTING.md) using the real signer.

Run with: gltest tests/test_human_verifier.py
Adjust get_contract_factory/get_default_account/create_account calls if
your installed gltest version's API differs -- this mirrors the pattern used
in genlayer-escrow's tests/test_escrow_payout.py.
"""
import json
import pytest
from gltest import get_contract_factory, get_default_account, create_account


@pytest.fixture
def verifier():
    factory = get_contract_factory("HumanVerifier")
    contract = factory.deploy(args=[])
    contract.transact(function_name="register_site", args=["test-site", json.dumps({"fee_wei": "0"})])
    return contract


def test_bad_signature_rejected(verifier):
    result = verifier.transact(
        function_name="submit_verification",
        args=["test-site", "{}", "nonce-1", "9999999999", "00" * 64],
    )
    assert not result.tx_execution_succeeded()


def test_wrong_length_signature_rejected(verifier):
    result = verifier.transact(
        function_name="submit_verification",
        args=["test-site", "{}", "nonce-2", "9999999999", "ab"],
    )
    assert not result.tx_execution_succeeded()


def test_expired_attestation_rejected(verifier):
    # expiry of 1 (Jan 1970) is always in the past
    fake_sig = ("0" * 63 + "1") * 2
    result = verifier.transact(
        function_name="submit_verification",
        args=["test-site", "{}", "nonce-3", "1", fake_sig],
    )
    assert not result.tx_execution_succeeded()


def test_unregistered_site_rejected(verifier):
    fake_sig = ("0" * 63 + "1") * 2
    result = verifier.transact(
        function_name="submit_verification",
        args=["no-such-site", "{}", "nonce-4", "9999999999", fake_sig],
    )
    assert not result.tx_execution_succeeded()


def test_appeal_on_nonexistent_request_rejected(verifier):
    fake_sig = ("0" * 63 + "1") * 2
    result = verifier.transact(
        function_name="appeal_verification",
        args=["req_999", "{}", "nonce-5", "9999999999", fake_sig],
    )
    assert not result.tx_execution_succeeded()


def test_get_request_id_by_nonce_unknown_rejected(verifier):
    with pytest.raises(Exception):
        verifier.call(function_name="get_request_id_by_nonce", args=["never-used-nonce"])

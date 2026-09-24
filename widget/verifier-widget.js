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

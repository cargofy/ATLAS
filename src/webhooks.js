/**
 * ATLAS Webhook Emitter (ATLAS-11)
 * Sends push notifications to configured URLs when events occur.
 * Configured in config.yml:
 *
 *   webhooks:
 *     - url: "https://cargofy.com/webhook/atlas"
 *       events: ["sla_violation", "sync_error", "new_exception", "new_issue"]
 *       secret: "${WEBHOOK_SECRET}"
 *
 * All deliveries are fire-and-forget with one retry.
 * Failures are logged but never crash the server.
 */

export class WebhookEmitter {
  constructor(config) {
    this.webhooks = (config?.webhooks ?? []).filter(w => w.url);
    if (this.webhooks.length) {
      console.error(`[ATLAS] Webhooks: ${this.webhooks.length} endpoint(s) configured`);
    }
  }

  /**
   * Emit an event to all webhooks subscribed to that event type.
   * @param {string} event  — event name: sla_violation | sync_error | new_exception | new_issue | sync_complete
   * @param {object} payload — event data
   */
  async emit(event, payload) {
    if (!this.webhooks.length) return;

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      atlas_version: '1.0.0',
      payload,
    });

    for (const hook of this.webhooks) {
      const subscribed = hook.events ?? ['sla_violation', 'sync_error', 'new_issue'];
      if (!subscribed.includes(event) && !subscribed.includes('*')) continue;

      this._deliver(hook, event, body);
    }
  }

  async _deliver(hook, event, body, attempt = 1) {
    const headers = { 'Content-Type': 'application/json' };

    if (hook.secret) {
      // HMAC-SHA256 signature for verification on receiver side
      try {
        const crypto = await import('crypto');
        const secret = hook.secret.startsWith('${')
          ? process.env[hook.secret.slice(2, -1)] ?? ''
          : hook.secret;
        const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
        headers['X-Atlas-Signature'] = `sha256=${sig}`;
      } catch {}
    }

    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && attempt === 1) {
        console.error(`[ATLAS] Webhook ${event} → ${hook.url} failed (${res.status}), retrying...`);
        setTimeout(() => this._deliver(hook, event, body, 2), 5000);
      } else if (!res.ok) {
        console.error(`[ATLAS] Webhook ${event} → ${hook.url} failed after retry (${res.status})`);
      }
    } catch (e) {
      if (attempt === 1) {
        console.error(`[ATLAS] Webhook ${event} → ${hook.url} error: ${e.message}, retrying...`);
        setTimeout(() => this._deliver(hook, event, body, 2), 5000);
      }
    }
  }
}

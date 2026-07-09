import { execFile } from 'node:child_process';
import axios from 'axios';
import { config } from './config.js';
import { log } from './logger.js';

// Best-effort notifications: macOS notification center + optional Discord
// webhook. Failures are logged and swallowed — notifying must never break
// trading. `throttleKey` limits repeat noise (e.g. poller failures) to once
// per hour per key.

const lastSent = new Map();
const THROTTLE_MS = 3600_000;

// `channel` selects which sinks to use: 'macos' | 'discord' | 'all' (default).
export function notify(title, message, { throttleKey, channel = 'all' } = {}) {
  if (throttleKey) {
    const last = lastSent.get(throttleKey) || 0;
    if (Date.now() - last < THROTTLE_MS) return;
    lastSent.set(throttleKey, Date.now());
  }

  const wantMacos = channel === 'all' || channel === 'macos';
  const wantDiscord = channel === 'all' || channel === 'discord';

  if (wantMacos && config.notify.macos && process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(`Trading Bot: ${title}`)}`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) log.warn('notify', `macOS notification failed: ${err.message}`);
    });
  }

  if (wantDiscord && config.notify.discordWebhookUrl) {
    axios
      .post(config.notify.discordWebhookUrl, { content: `**${title}**\n${message}` }, { timeout: 10000 })
      .catch((err) => log.warn('notify', `Discord webhook failed: ${err.message}`));
  }
}

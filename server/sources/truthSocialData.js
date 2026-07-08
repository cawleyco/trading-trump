import axios from 'axios';
import pRetry from 'p-retry';
import { config } from '../config.js';

// Truth Social has no official API. It runs a Mastodon fork, so the standard
// Mastodon public endpoints work unauthenticated for public accounts (this is
// the same approach the open-source `truthbrush` project documents). This is
// ToS gray-area scraping and may break or be blocked at any time — failures
// here must degrade gracefully, never crash the bot.

const BASE = 'https://truthsocial.com/api/v1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let cachedAccountId = null;

async function get(url, params = {}) {
  return pRetry(
    async () => {
      const resp = await axios.get(url, {
        params,
        timeout: 20000,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      return resp.data;
    },
    { retries: 2, minTimeout: 3000 }
  );
}

async function lookupAccountId(username) {
  if (cachedAccountId) return cachedAccountId;
  const data = await get(`${BASE}/accounts/lookup`, { acct: username });
  if (!data?.id) throw new Error(`Could not resolve Truth Social account "${username}"`);
  cachedAccountId = data.id;
  return cachedAccountId;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Fetch recent posts for the configured account.
 * Returns [{ id, text, createdAt, url }] newest first; [] on any failure.
 */
export async function fetchRecentPosts() {
  const accountId = await lookupAccountId(config.polling.truthSocialUsername);
  const statuses = await get(`${BASE}/accounts/${accountId}/statuses`, {
    limit: 20,
    exclude_replies: true,
  });
  return (Array.isArray(statuses) ? statuses : [])
    .filter((s) => !s.reblog) // skip re-truths; only original posts
    .map((s) => ({
      id: String(s.id),
      text: stripHtml(s.content),
      createdAt: s.created_at,
      url: s.url || s.uri,
    }))
    .filter((p) => p.text.length > 0);
}

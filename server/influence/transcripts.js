export class TranscriptProviderRegistry {
  constructor(providers = []) {
    this.providers = providers;
  }

  // True when at least one provider could try this video right now. Callers
  // use this to distinguish "tried and failed" (counts as an attempt) from
  // "nothing enabled that could try" (must not burn retry budget).
  async hasEligibleProvider(video) {
    for (const provider of this.providers) {
      if (await provider.canFetch(video)) return true;
    }
    return false;
  }

  async fetchBestAvailableTranscript(video) {
    for (const provider of this.providers) {
      if (await provider.canFetch(video)) {
        const result = await provider.fetchTranscript(video);
        if (result.status === 'success') return result;
      }
    }
    return {
      status: 'unavailable',
      providerName: 'registry',
      errorMessage: 'No transcript provider available',
    };
  }
}

export class ManualTranscriptProvider {
  providerName = 'manual';

  constructor(input = null) {
    this.input = input;
  }

  async canFetch() {
    return !!this.input?.rawText;
  }

  async fetchTranscript() {
    if (!this.input?.rawText) {
      return { status: 'manual_required', providerName: this.providerName };
    }
    const format = this.input.format || detectTranscriptFormat(this.input.rawText);
    const segments = segmentTranscript(this.input.rawText, format);
    return {
      status: 'success',
      providerName: this.providerName,
      language: this.input.language,
      format,
      rawText: this.input.rawText,
      segments,
    };
  }
}

export class StubTranscriptProvider {
  providerName = 'stub';

  constructor(fixtures = new Map()) {
    this.fixtures = fixtures;
  }

  async canFetch(video) {
    return this.fixtures.has(String(video.id || video.youtube_video_id));
  }

  async fetchTranscript(video) {
    const rawText = this.fixtures.get(String(video.id || video.youtube_video_id));
    if (!rawText) return { status: 'unavailable', providerName: this.providerName };
    const format = detectTranscriptFormat(rawText);
    return {
      status: 'success',
      providerName: this.providerName,
      format,
      rawText,
      segments: segmentTranscript(rawText, format),
    };
  }
}

export function detectTranscriptFormat(raw) {
  const text = String(raw || '').trim();
  if (/^WEBVTT\b/i.test(text)) return 'vtt';
  if (/\d+\s*\n\d\d:\d\d:\d\d[,.]\d{3}\s+-->\s+\d\d:\d\d:\d\d[,.]\d{3}/.test(text)) return 'srt';
  return 'plain_text';
}

function parseTimestamp(ts) {
  const parts = ts.replace(',', '.').split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function parseCaptionBlocks(raw) {
  const blocks = String(raw)
    .replace(/^WEBVTT[^\n]*\n+/i, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;
    const [startRaw, endRaw] = lines[timeLineIndex].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const text = lines.slice(timeLineIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    segments.push({
      startSeconds: parseTimestamp(startRaw),
      endSeconds: parseTimestamp(endRaw),
      text,
    });
  }
  return segments;
}

function segmentPlainText(raw) {
  const words = String(raw || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const segments = [];
  const wordsPerSegment = 110;
  for (let i = 0; i < words.length; i += wordsPerSegment) {
    const text = words.slice(i, i + wordsPerSegment).join(' ');
    if (!text) continue;
    const idx = segments.length;
    segments.push({
      startSeconds: idx * 60,
      endSeconds: (idx + 1) * 60,
      text,
    });
  }
  return segments;
}

export function segmentTranscript(raw, format = detectTranscriptFormat(raw)) {
  const segments = format === 'srt' || format === 'vtt'
    ? parseCaptionBlocks(raw)
    : segmentPlainText(raw);
  return segments.map((s, i) => ({
    segment_index: i,
    start_seconds: s.startSeconds ?? null,
    end_seconds: s.endSeconds ?? null,
    text: s.text,
    token_count: s.text.split(/\s+/).filter(Boolean).length,
  }));
}

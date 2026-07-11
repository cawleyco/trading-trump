// Automated caption fetching via yt-dlp. Fetching auto-generated captions is
// a YouTube ToS gray area — this provider is OFF unless the owner explicitly
// sets YOUTUBE_AUTO_TRANSCRIPTS_ENABLED=true, every fetch is rate-limited,
// and documents it produces carry authorization_status
// 'auto_captions_tos_gray' so their provenance stays queryable forever.
// It implements the TranscriptProviderRegistry contract (canFetch /
// fetchTranscript) so a compliant provider can displace it without touching
// any caller.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { detectTranscriptFormat, segmentTranscript } from '../transcripts.js';

const execFileAsync = promisify(execFile);

export const AUTO_CAPTIONS_AUTHORIZATION_STATUS = 'auto_captions_tos_gray';

export class YtDlpTranscriptProvider {
  providerName = 'yt-dlp';

  constructor({
    binaryPath = config.influence.ytDlpPath,
    enabled = config.influence.autoTranscriptsEnabled,
    fetchDelayMs = config.influence.transcriptFetchDelayMs,
    execFileFn = execFileAsync,
    tmpRoot = os.tmpdir(),
  } = {}) {
    this.binaryPath = binaryPath;
    this.enabled = enabled;
    this.fetchDelayMs = fetchDelayMs;
    this.execFileFn = execFileFn;
    this.tmpRoot = tmpRoot;
    this._binaryAvailable = null; // checked once, cached
    this._lastFetchAt = 0;
  }

  async binaryAvailable() {
    if (this._binaryAvailable != null) return this._binaryAvailable;
    try {
      await this.execFileFn(this.binaryPath, ['--version'], { timeout: 10_000 });
      this._binaryAvailable = true;
    } catch {
      log.warn('youtube', `yt-dlp binary not found at "${this.binaryPath}" — auto transcripts disabled`);
      this._binaryAvailable = false;
    }
    return this._binaryAvailable;
  }

  async canFetch(video) {
    if (!this.enabled) return false;
    if (!video?.youtube_video_id) return false;
    return this.binaryAvailable();
  }

  async throttle() {
    const wait = this._lastFetchAt + this.fetchDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastFetchAt = Date.now();
  }

  async fetchTranscript(video) {
    await this.throttle();
    const videoId = video.youtube_video_id;
    const workDir = fs.mkdtempSync(path.join(this.tmpRoot, 'yt-transcript-'));
    try {
      const args = [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-format', 'vtt',
        '--sub-langs', 'en.*,en',
        '--output', path.join(workDir, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ];
      await this.execFileFn(this.binaryPath, args, { timeout: 120_000 });
      const vttFile = fs.readdirSync(workDir).find((f) => f.endsWith('.vtt'));
      if (!vttFile) {
        return {
          status: 'unavailable',
          providerName: this.providerName,
          errorMessage: `no captions available for ${videoId}`,
        };
      }
      const rawText = fs.readFileSync(path.join(workDir, vttFile), 'utf8');
      const format = detectTranscriptFormat(rawText);
      const segments = segmentTranscript(rawText, format);
      if (segments.length === 0) {
        return {
          status: 'unavailable',
          providerName: this.providerName,
          errorMessage: `captions file for ${videoId} produced no segments`,
        };
      }
      const langMatch = vttFile.match(/\.([a-zA-Z-]+)\.vtt$/);
      return {
        status: 'success',
        providerName: this.providerName,
        language: langMatch?.[1] || 'en',
        format,
        rawText,
        segments,
        authorizationStatus: AUTO_CAPTIONS_AUTHORIZATION_STATUS,
      };
    } catch (err) {
      return {
        status: 'error',
        providerName: this.providerName,
        errorMessage: err.message,
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

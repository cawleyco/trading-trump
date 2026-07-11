import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  YtDlpTranscriptProvider,
  AUTO_CAPTIONS_AUTHORIZATION_STATUS,
} from '../server/influence/transcriptProviders/ytDlpProvider.js'

const VTT_FIXTURE = `WEBVTT

00:00:01.000 --> 00:00:04.000
I am buying more Nvidia here.

00:00:04.000 --> 00:00:08.000
Tesla looks overextended at this level.
`

const video = { id: 1, youtube_video_id: 'dQw4w9WgXcQ' }

// execFile mock that emulates yt-dlp writing a caption file next to --output.
function fakeExecFile({ writeVtt = true, failVersion = false, failFetch = false } = {}) {
  return async (bin, args) => {
    if (args.includes('--version')) {
      if (failVersion) throw new Error('spawn yt-dlp ENOENT')
      return { stdout: '2026.01.01' }
    }
    if (failFetch) throw new Error('HTTP Error 429: Too Many Requests')
    if (writeVtt) {
      const outTemplate = args[args.indexOf('--output') + 1]
      const workDir = path.dirname(outTemplate)
      fs.writeFileSync(path.join(workDir, `${video.youtube_video_id}.en.vtt`), VTT_FIXTURE)
    }
    return { stdout: '' }
  }
}

function makeProvider(execOpts = {}, providerOpts = {}) {
  return new YtDlpTranscriptProvider({
    enabled: true,
    fetchDelayMs: 0,
    execFileFn: fakeExecFile(execOpts),
    tmpRoot: os.tmpdir(),
    binaryPath: 'yt-dlp',
    ...providerOpts,
  })
}

test('canFetch is false when auto transcripts are disabled', async () => {
  const provider = makeProvider({}, { enabled: false })
  assert.equal(await provider.canFetch(video), false)
})

test('canFetch is false when the binary is missing (checked once, cached)', async () => {
  let calls = 0
  const provider = new YtDlpTranscriptProvider({
    enabled: true,
    fetchDelayMs: 0,
    tmpRoot: os.tmpdir(),
    binaryPath: 'yt-dlp',
    execFileFn: async (bin, args) => {
      calls++
      throw new Error('spawn yt-dlp ENOENT')
    },
  })
  assert.equal(await provider.canFetch(video), false)
  assert.equal(await provider.canFetch(video), false)
  assert.equal(calls, 1)
})

test('fetchTranscript parses the VTT into segments and stamps ToS-gray provenance', async () => {
  const provider = makeProvider()
  const result = await provider.fetchTranscript(video)
  assert.equal(result.status, 'success')
  assert.equal(result.providerName, 'yt-dlp')
  assert.equal(result.format, 'vtt')
  assert.equal(result.language, 'en')
  assert.equal(result.authorizationStatus, AUTO_CAPTIONS_AUTHORIZATION_STATUS)
  assert.equal(result.segments.length, 2)
  assert.equal(result.segments[0].start_seconds, 1)
  assert.match(result.segments[1].text, /Tesla/)
})

test('fetchTranscript reports unavailable when yt-dlp writes no captions', async () => {
  const provider = makeProvider({ writeVtt: false })
  const result = await provider.fetchTranscript(video)
  assert.equal(result.status, 'unavailable')
  assert.match(result.errorMessage, /no captions/)
})

test('fetchTranscript reports error (not throw) when yt-dlp fails', async () => {
  const provider = makeProvider({ failFetch: true })
  const result = await provider.fetchTranscript(video)
  assert.equal(result.status, 'error')
  assert.match(result.errorMessage, /429/)
})

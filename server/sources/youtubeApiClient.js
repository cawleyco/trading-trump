import axios from 'axios';
import { config } from '../config.js';

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

function requireApiKey() {
  if (!config.youtubeApiKey) {
    throw new Error('YOUTUBE_API_KEY is not configured');
  }
  return config.youtubeApiKey;
}

function parseDurationSeconds(iso) {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

async function get(path, params) {
  const resp = await axios.get(`${BASE_URL}/${path}`, {
    params: { key: requireApiKey(), ...params },
    timeout: 15000,
  });
  return resp.data;
}

export function normalizeChannelInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('channel input is required');
  const url = raw.match(/youtube\.com\/(?:channel\/([^/?#]+)|@([^/?#]+)|c\/([^/?#]+)|user\/([^/?#]+))/i);
  if (url?.[1]) return { type: 'id', value: url[1] };
  if (url?.[2]) return { type: 'handle', value: `@${url[2].replace(/^@/, '')}` };
  if (raw.startsWith('@')) return { type: 'handle', value: raw };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(raw)) return { type: 'id', value: raw };
  return { type: 'handle', value: raw.startsWith('@') ? raw : `@${raw}` };
}

export async function resolveChannelId(input) {
  const normalized = normalizeChannelInput(input);
  if (normalized.type === 'id') return normalized.value;
  const data = await get('channels', {
    part: 'id',
    forHandle: normalized.value.replace(/^@/, ''),
    maxResults: 1,
  });
  const id = data.items?.[0]?.id;
  if (!id) throw new Error(`Could not resolve YouTube channel "${input}"`);
  return id;
}

export async function getChannelMetadata(channelId) {
  const data = await get('channels', {
    part: 'snippet,contentDetails,statistics',
    id: channelId,
    maxResults: 1,
  });
  const item = data.items?.[0];
  if (!item) throw new Error(`YouTube channel not found: ${channelId}`);
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  return {
    youtube_channel_id: item.id,
    title: snippet.title,
    handle: snippet.customUrl?.startsWith('@') ? snippet.customUrl : null,
    custom_url: snippet.customUrl ?? null,
    description: snippet.description ?? null,
    thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null,
    uploads_playlist_id: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    subscriber_count: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount ?? 0),
    video_count: Number(stats.videoCount ?? 0),
    view_count: Number(stats.viewCount ?? 0),
    country: snippet.country ?? null,
    language: snippet.defaultLanguage ?? null,
  };
}

export async function getChannelUploadsPlaylistId(channelId) {
  const metadata = await getChannelMetadata(channelId);
  return metadata.uploads_playlist_id;
}

export async function listLatestVideosFromUploadsPlaylist(playlistId, maxResults = 10) {
  const data = await get('playlistItems', {
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: Math.min(Math.max(Number(maxResults) || 10, 1), 50),
  });
  return (data.items || []).map((item) => ({
    youtube_video_id: item.contentDetails?.videoId,
    title: item.snippet?.title || 'Untitled video',
    description: item.snippet?.description ?? '',
    published_at: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt,
    thumbnail_url: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
    url: item.contentDetails?.videoId ? `https://www.youtube.com/watch?v=${item.contentDetails.videoId}` : null,
  })).filter((v) => v.youtube_video_id && v.published_at);
}

export async function getVideoMetadata(videoId) {
  const data = await get('videos', {
    part: 'snippet,contentDetails,statistics,paidProductPlacementDetails',
    id: videoId,
    maxResults: 1,
  });
  const item = data.items?.[0];
  if (!item) throw new Error(`YouTube video not found: ${videoId}`);
  const snippet = item.snippet || {};
  const details = item.contentDetails || {};
  const stats = item.statistics || {};
  return {
    youtube_video_id: item.id,
    title: snippet.title || 'Untitled video',
    description: snippet.description ?? '',
    published_at: snippet.publishedAt,
    duration_seconds: parseDurationSeconds(details.duration),
    thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    has_captions: details.caption === 'true',
    has_paid_product_placement: !!item.paidProductPlacementDetails?.hasPaidProductPlacement,
    default_language: snippet.defaultLanguage ?? null,
    default_audio_language: snippet.defaultAudioLanguage ?? null,
    live_broadcast_content: snippet.liveBroadcastContent ?? null,
    stats: {
      view_count: stats.viewCount == null ? null : Number(stats.viewCount),
      like_count: stats.likeCount == null ? null : Number(stats.likeCount),
      comment_count: stats.commentCount == null ? null : Number(stats.commentCount),
    },
  };
}

export { parseDurationSeconds };

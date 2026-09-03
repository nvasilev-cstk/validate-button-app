import DOMPurify from 'dompurify';
import { jsonToHTML, type EntryEmbedable } from '@contentstack/utils';

// Contentstack's Management API expects these two headers on every request.
export function buildManagementHeaders(apiKey: string, authorization: string): HeadersInit {
  const headers: Record<string, string> = {};
  if (apiKey) headers.api_key = apiKey;
  if (authorization) headers.authorization = authorization;
  return headers;
}

// Builds a Contentstack CMA "query entries" URL, e.g.
// `${statusUrl}?query={"entryid":"bltab302d06d7644b49"}`.
function buildStatusQueryUrl(statusUrl: string, entryUid: string): string {
  const query = JSON.stringify({ entryid: entryUid });
  const separator = statusUrl.includes('?') ? '&' : '?';
  return `${statusUrl}${separator}query=${encodeURIComponent(query)}`;
}

export async function postEntryForValidation(url: string, entryData: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entryData),
  });
  if (!response.ok) {
    throw new Error(`Validation service responded with status ${response.status}`);
  }
}

export type FeedbackEntry = Record<string, unknown>;

// The status endpoint may proxy Contentstack's CMA "fetch entry"/"query
// entries" shape directly, or just return the entry object as-is — accept
// whichever comes back.
function extractEntry(payload: unknown): FeedbackEntry | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  if (obj.entry && typeof obj.entry === 'object') return obj.entry as FeedbackEntry;
  if (Array.isArray(obj.entries)) return (obj.entries[0] as FeedbackEntry | undefined) ?? undefined;
  return obj as FeedbackEntry;
}

// A single best-effort check against the status endpoint. Swallows network/parse
// errors and just reports "nothing found" rather than surfacing them to the UI,
// but logs the real cause so it's visible in devtools instead of looking like a
// silent, unexplained hang.
export async function fetchFeedbackEntry(
  statusUrl: string,
  entryUid: string,
  headers: HeadersInit
): Promise<FeedbackEntry | undefined> {
  try {
    const res = await fetch(buildStatusQueryUrl(statusUrl, entryUid), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[Validation] Status check failed: ${res.status} ${res.statusText}`, body);
      return undefined;
    }
    return extractEntry(await res.json());
  } catch (err) {
    // A CORS block or network failure surfaces here as a generic "Failed to
    // fetch" TypeError — check the Network tab for the actual blocked request.
    console.error('[Validation] Status check request failed', err);
    return undefined;
  }
}

// Each feedback field's value may be a Contentstack JSON RTE (Advanced)
// document, or a plain HTML string. Converts whichever is present at each
// given field uid into sanitized HTML, safe for dangerouslySetInnerHTML.
// Fields with no content (or that fail to convert) are omitted from the result.
export function extractFeedbackHtmlByField(entry: FeedbackEntry, fieldUids: string[]): Record<string, string> {
  const mutable: FeedbackEntry = { ...entry };
  const jsonRtePaths = fieldUids.filter((uid) => {
    const value = entry[uid];
    return value !== null && typeof value === 'object';
  });

  if (jsonRtePaths.length > 0) {
    try {
      // jsonToHTML's entry type requires a `uid`, which every real
      // Contentstack entry has — the FeedbackEntry type just doesn't say so.
      jsonToHTML({ entry: mutable as unknown as EntryEmbedable, paths: jsonRtePaths });
    } catch (err) {
      console.error('[Validation] Failed to convert JSON RTE feedback to HTML', err);
    }
  }

  const result: Record<string, string> = {};
  for (const uid of fieldUids) {
    const value = mutable[uid];
    if (typeof value === 'string' && value.trim()) {
      result[uid] = DOMPurify.sanitize(value);
    }
  }
  return result;
}

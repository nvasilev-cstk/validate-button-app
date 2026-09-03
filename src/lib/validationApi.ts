import DOMPurify from 'dompurify';

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

// Each feedback field is a plain text field containing an HTML string.
// Sanitizes whichever fields are present into HTML safe for
// dangerouslySetInnerHTML; empty/missing fields are omitted from the result.
export function extractFeedbackHtmlByField(entry: FeedbackEntry, fieldUids: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const uid of fieldUids) {
    const value = entry[uid];
    if (typeof value === 'string' && value.trim()) {
      result[uid] = DOMPurify.sanitize(value);
    }
  }
  return result;
}

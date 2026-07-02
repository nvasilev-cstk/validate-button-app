import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, ShieldCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { CustomFieldLocation } from '../App';

type Status = 'idle' | 'triggering' | 'polling' | 'success' | 'error';

// The validation agent runs asynchronously, so the initial POST only
// acknowledges that the job was queued — it can't return real results yet.
// Once queued, we poll a separate "ValidationFeedback" lookup entry
// (GET `${statusUrl}/${entryUid}`) until it comes back with feedback, or
// give up after MAX_POLL_ATTEMPTS so the button can never get stuck forever.
const INITIAL_POLL_DELAY_MS = 20_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 18;
const MESSAGE_RESET_DELAY_MS = 8000;

interface ValidationFeedbackEntry {
  uid?: string;
  entryid?: string;
  feedback?: string;
  title?: string;
}

// The status endpoint may proxy Contentstack's CMA "fetch entry"/"query
// entries" shape directly, or just return the entry object as-is — accept
// whichever comes back.
function extractFeedbackEntry(payload: unknown): ValidationFeedbackEntry | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  if (obj.entry && typeof obj.entry === 'object') return obj.entry as ValidationFeedbackEntry;
  if (Array.isArray(obj.entries)) return (obj.entries[0] as ValidationFeedbackEntry | undefined) ?? undefined;
  return obj as ValidationFeedbackEntry;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Builds a Contentstack CMA "query entries" URL, e.g.
// `${statusUrl}?query={"entryid":"bltab302d06d7644b49"}`.
function buildPollUrl(statusUrl: string, entryUid: string) {
  const query = JSON.stringify({ entryid: entryUid });
  const separator = statusUrl.includes('?') ? '&' : '?';
  return `${statusUrl}${separator}query=${encodeURIComponent(query)}`;
}

// Contentstack's Management API expects these two headers on every request.
function buildManagementHeaders(apiKey: string, authorization: string): HeadersInit {
  const headers: Record<string, string> = {};
  if (apiKey) headers.api_key = apiKey;
  if (authorization) headers.authorization = authorization;
  return headers;
}

// A single best-effort check against the status endpoint. Swallows network/parse
// errors and just reports "no feedback yet" rather than surfacing them to the UI
// (callers use this both for silent background checks and for the retry loop),
// but logs the real cause so it's visible in devtools instead of looking like a
// silent, unexplained hang.
async function checkFeedbackOnce(pollUrl: string, headers: HeadersInit): Promise<string | undefined> {
  try {
    const res = await fetch(pollUrl, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ValidationButton] Status check failed: ${res.status} ${res.statusText}`, body);
      return undefined;
    }
    const feedbackEntry = extractFeedbackEntry(await res.json());
    return feedbackEntry?.feedback || undefined;
  } catch (err) {
    // A CORS block or network failure surfaces here as a generic "Failed to
    // fetch" TypeError — check the Network tab for the actual blocked request.
    console.error('[ValidationButton] Status check request failed', err);
    return undefined;
  }
}

interface ValidationButtonProps {
  customField: CustomFieldLocation;
}

function ValidationButton({ customField }: ValidationButtonProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  // A brand-new, never-saved entry has no uid yet. Querying the status
  // endpoint with an undefined uid serializes to an empty `query={}`, which
  // the Management API happily answers with an unrelated entry — showing
  // someone else's feedback as if it were this entry's. Block both the
  // trigger and the status lookup entirely until there's a real uid to key on.
  const [hasSavedEntry, setHasSavedEntry] = useState(() => Boolean(customField.entry.getData()?.uid));
  const isMounted = useRef(true);
  // Bumped on every click so a stale poll from a previous click can detect
  // it's been superseded and stop touching state.
  const pollTokenRef = useRef(0);

  useEffect(() => {
    // Must reset to true here, not just rely on the useRef initial value.
    // React 18 StrictMode (dev only) mounts every component twice
    // (mount -> simulated unmount -> remount) to surface exactly this bug:
    // without this line, the simulated unmount's cleanup below sets this to
    // false permanently, and every state update in this component silently
    // no-ops for the rest of its life, even though it's genuinely mounted.
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Once the editor saves a new entry for the first time, it's assigned a
  // real uid — flip the gate open as soon as that happens, without requiring
  // a manual reload.
  useEffect(() => {
    customField.entry.onSave((savedEntry) => {
      if (isMounted.current && savedEntry?.uid) {
        setHasSavedEntry(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerUrl = (customField.fieldConfig?.url as string | undefined) ?? '';
  const statusUrl = (customField.fieldConfig?.statusUrl as string | undefined) ?? '';
  const apiKey = (customField.fieldConfig?.api_key as string | undefined) ?? '';
  const authorization = (customField.fieldConfig?.authorization as string | undefined) ?? '';
  const managementHeaders = buildManagementHeaders(apiKey, authorization);

  // If validation has already run for this entry (e.g. the editor reopened the
  // entry after a previous trigger), show existing feedback immediately instead
  // of making the editor click the button again.
  useEffect(() => {
    if (!statusUrl) return;
    const entryData = customField.entry.getData();
    if (!entryData?.uid) return;
    const pollUrl = buildPollUrl(statusUrl, entryData.uid);

    checkFeedbackOnce(pollUrl, managementHeaders).then((feedback) => {
      // Skip if the editor already clicked the button before this resolved.
      if (feedback && isMounted.current && pollTokenRef.current === 0) {
        setStatus('success');
        setMessage(feedback);
      }
    });
    // Only ever check once, right after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = async () => {
    const myToken = ++pollTokenRef.current;
    const isCurrent = () => isMounted.current && pollTokenRef.current === myToken;

    if (!hasSavedEntry) {
      setStatus('error');
      setMessage('Save this entry before running validation.');
      return;
    }

    if (!triggerUrl || !statusUrl) {
      setStatus('error');
      setMessage('Set both "url" and "statusUrl" in the field instance settings.');
      return;
    }

    setStatus('triggering');
    setMessage('');

    let entryData;

    try {
      entryData = customField.entry.getData();
      const response = await fetch(triggerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(entryData),
      });

      if (!response.ok) {
        throw new Error(`Validation service responded with status ${response.status}`);
      }
    } catch (err) {
      if (isCurrent()) {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Failed to trigger validation.');
      }
      return;
    }

    if (!isCurrent()) return;
    setStatus('polling');
    setMessage('Waiting for validation results…');

    const pollUrl = buildPollUrl(statusUrl, entryData.uid);

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      if (!isCurrent()) return;

      // Wait before every attempt, including the first — the agent needs a
      // moment to pick up the job, so polling immediately would just waste
      // a request. The first wait is longer since the job has only just
      // been queued.
      await wait(attempt === 1 ? INITIAL_POLL_DELAY_MS : POLL_INTERVAL_MS);
      if (!isCurrent()) return;

      const feedback = await checkFeedbackOnce(pollUrl, managementHeaders);
      if (feedback) {
        if (isCurrent()) {
          setStatus('success');
          setMessage(feedback);
        }
        return;
      }
    }

    if (isCurrent()) {
      setStatus('error');
      setMessage(`Timed out waiting for validation results after ${MAX_POLL_ATTEMPTS} attempts.`);
    }
  };

  useEffect(() => {
    if (status !== 'error') return;
    const timer = setTimeout(() => {
      if (isMounted.current) {
        setStatus('idle');
        setMessage('');
      }
    }, MESSAGE_RESET_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const isBusy = status === 'triggering' || status === 'polling';
  const label = status === 'triggering' ? 'Sending…' : status === 'polling' ? 'Validating…' : 'Trigger Validation';

  return (
    <div className="validation-trigger">
      <button
        type="button"
        className="cs-btn cs-btn--primary"
        onClick={handleClick}
        disabled={isBusy || !hasSavedEntry}
      >
        {isBusy ? (
          <Loader2 className="cs-btn__icon cs-btn__icon--spin" size={16} />
        ) : (
          <ShieldCheck className="cs-btn__icon" size={16} />
        )}
        <span>{label}</span>
      </button>

      {!hasSavedEntry && status === 'idle' && (
        <div className="cs-status cs-status--pending">
          <Info size={14} />
          <span>Save this entry before running validation.</span>
        </div>
      )}

      {status === 'polling' && (
        <div className="cs-status cs-status--pending">
          <Loader2 className="cs-status__icon cs-status__icon--spin" size={14} />
          <span>{message}</span>
        </div>
      )}

      {status === 'success' && (
        <div className="cs-status cs-status--success cs-status--feedback">
          <CheckCircle2 size={14} />
          <div className="cs-status__markdown">
            <ReactMarkdown>{message}</ReactMarkdown>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="cs-status cs-status--error">
          <AlertCircle size={14} />
          <span>{message}</span>
        </div>
      )}
    </div>
  );
}

export default ValidationButton;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomFieldLocation } from '../App';
import { VALIDATION_CATEGORIES, parseValidationConfig } from '../lib/validationConfig';
import {
  buildManagementHeaders,
  extractFeedbackHtmlByField,
  fetchFeedbackEntry,
  postEntryForValidation,
} from '../lib/validationApi';

export type CategoryState = 'idle' | 'pending' | 'error';

// All pending categories share one polling loop rather than one loop each —
// a category that joins mid-loop just gets picked up on the next shared tick
// instead of getting its own precisely-timed first check. Simpler to reason
// about with several categories potentially triggered at different times,
// at the cost of a category's first check landing anywhere from ~0-10s after
// it was queued rather than a fixed delay.
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 18;
const FIELD_CHANGE_DEBOUNCE_MS = 1500;
const CATEGORY_ERROR_RESET_MS = 8000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useValidation(customField: CustomFieldLocation) {
  const config = useMemo(() => parseValidationConfig(customField.fieldConfig), [customField]);
  const managementHeaders = useMemo(
    () => buildManagementHeaders(config.apiKey, config.authorization),
    [config]
  );
  const feedbackFieldUids = useMemo(() => VALIDATION_CATEGORIES.map((c) => c.feedbackFieldUid), []);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const [hasSavedEntry, setHasSavedEntry] = useState(() => Boolean(customField.entry.getData()?.uid));
  const [feedbackHtml, setFeedbackHtml] = useState<Record<string, string>>({});
  const [categoryState, setCategoryState] = useState<Record<string, CategoryState>>({});
  const [isTriggeringAll, setIsTriggeringAll] = useState(false);
  const [globalError, setGlobalError] = useState('');

  // category key -> attempts remaining. The single source of truth for "is
  // anything still pending" — categoryState is just its UI reflection.
  const pendingAttemptsRef = useRef<Map<string, number>>(new Map());
  const isPollingRef = useRef(false);

  useEffect(() => {
    customField.entry.onSave((savedEntry) => {
      if (isMounted.current && savedEntry?.uid) {
        setHasSavedEntry(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customField]);

  const refreshFeedback = useCallback(async () => {
    if (!config.statusUrl) return;
    const entryUid = customField.entry.getData()?.uid;
    if (!entryUid) return;

    const feedbackEntry = await fetchFeedbackEntry(config.statusUrl, entryUid, managementHeaders);
    if (!feedbackEntry || !isMounted.current) return;

    const htmlByField = extractFeedbackHtmlByField(feedbackEntry, feedbackFieldUids);
    if (Object.keys(htmlByField).length > 0) {
      setFeedbackHtml((prev) => ({ ...prev, ...htmlByField }));
    }

    setCategoryState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const def of VALIDATION_CATEGORIES) {
        if (pendingAttemptsRef.current.has(def.key) && htmlByField[def.feedbackFieldUid]) {
          pendingAttemptsRef.current.delete(def.key);
          next[def.key] = 'idle';
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [config, customField, managementHeaders, feedbackFieldUids]);

  // If validation has already run for this entry (e.g. the editor reopened
  // it after a previous trigger), show existing feedback immediately.
  useEffect(() => {
    if (!hasSavedEntry) return;
    refreshFeedback();
    // Only ever check once, right after the entry has a uid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSavedEntry]);

  const startPollingIfNeeded = useCallback(() => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    const tick = async () => {
      if (!isMounted.current || pendingAttemptsRef.current.size === 0) {
        isPollingRef.current = false;
        return;
      }

      await wait(POLL_INTERVAL_MS);
      if (!isMounted.current) {
        isPollingRef.current = false;
        return;
      }

      await refreshFeedback();
      if (!isMounted.current) {
        isPollingRef.current = false;
        return;
      }

      const timedOut: string[] = [];
      pendingAttemptsRef.current.forEach((attemptsLeft, key) => {
        const remaining = attemptsLeft - 1;
        if (remaining <= 0) {
          timedOut.push(key);
        } else {
          pendingAttemptsRef.current.set(key, remaining);
        }
      });
      timedOut.forEach((key) => pendingAttemptsRef.current.delete(key));

      if (timedOut.length > 0) {
        setCategoryState((prev) => {
          const next = { ...prev };
          timedOut.forEach((key) => {
            next[key] = 'error';
          });
          return next;
        });
      }

      if (pendingAttemptsRef.current.size > 0) {
        tick();
      } else {
        isPollingRef.current = false;
      }
    };

    tick();
  }, [refreshFeedback]);

  const markPending = useCallback((categoryKeys: string[]) => {
    setCategoryState((prev) => {
      const next = { ...prev };
      for (const key of categoryKeys) {
        next[key] = 'pending';
        pendingAttemptsRef.current.set(key, MAX_POLL_ATTEMPTS);
      }
      return next;
    });
  }, []);

  const triggerAll = useCallback(async () => {
    if (!hasSavedEntry) {
      setGlobalError('Save this entry before running validation.');
      return;
    }
    if (!config.triggerUrl || !config.statusUrl) {
      setGlobalError('Set "url" and "statusUrl" in the field instance settings.');
      return;
    }

    setGlobalError('');
    setIsTriggeringAll(true);

    try {
      await postEntryForValidation(config.triggerUrl, customField.entry.getData());
    } catch (err) {
      if (isMounted.current) {
        setIsTriggeringAll(false);
        setGlobalError(err instanceof Error ? err.message : 'Failed to trigger validation.');
      }
      return;
    }

    if (!isMounted.current) return;
    setIsTriggeringAll(false);
    markPending(VALIDATION_CATEGORIES.map((def) => def.key));
    startPollingIfNeeded();
  }, [hasSavedEntry, config, customField, markPending, startPollingIfNeeded]);

  const triggerCategory = useCallback(
    async (categoryKey: string) => {
      const url = config.categoryUrls[categoryKey];
      if (!hasSavedEntry || !url) return;

      markPending([categoryKey]);

      try {
        await postEntryForValidation(url, customField.entry.getData());
      } catch (err) {
        console.error(`[Validation] Failed to auto-trigger "${categoryKey}"`, err);
        if (isMounted.current) {
          pendingAttemptsRef.current.delete(categoryKey);
          setCategoryState((prev) => ({ ...prev, [categoryKey]: 'error' }));
        }
        return;
      }

      startPollingIfNeeded();
    },
    [config, hasSavedEntry, customField, markPending, startPollingIfNeeded]
  );

  // Auto-trigger a category's own check when one of its fields is edited,
  // debounced so a category fires once after the editor pauses rather than
  // once per keystroke.
  useEffect(() => {
    if (config.fieldUidToCategory.size === 0) return;

    let previous: Record<string, unknown> = customField.entry.getData() ?? {};
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    customField.entry.onChange((_unresolved, resolved) => {
      const next: Record<string, unknown> = resolved ?? {};
      const changedCategories = new Set<string>();

      config.fieldUidToCategory.forEach((categoryKey, uid) => {
        if (previous[uid] !== next[uid]) {
          changedCategories.add(categoryKey);
        }
      });
      previous = next;

      changedCategories.forEach((categoryKey) => {
        const existingTimer = debounceTimers.get(categoryKey);
        if (existingTimer) clearTimeout(existingTimer);
        debounceTimers.set(
          categoryKey,
          setTimeout(() => {
            debounceTimers.delete(categoryKey);
            triggerCategory(categoryKey);
          }, FIELD_CHANGE_DEBOUNCE_MS)
        );
      });
    });

    return () => {
      debounceTimers.forEach((timer) => clearTimeout(timer));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, customField]);

  // Auto-clear a category's error state after a while so a failed/timed-out
  // check doesn't clutter the UI forever.
  useEffect(() => {
    const errorKeys = Object.entries(categoryState)
      .filter(([, state]) => state === 'error')
      .map(([key]) => key);
    if (errorKeys.length === 0) return;

    const timer = setTimeout(() => {
      if (!isMounted.current) return;
      setCategoryState((prev) => {
        const next = { ...prev };
        errorKeys.forEach((key) => {
          if (next[key] === 'error') next[key] = 'idle';
        });
        return next;
      });
    }, CATEGORY_ERROR_RESET_MS);
    return () => clearTimeout(timer);
  }, [categoryState]);

  // Same treatment for the button's own global error message.
  useEffect(() => {
    if (!globalError) return;
    const timer = setTimeout(() => {
      if (isMounted.current) setGlobalError('');
    }, CATEGORY_ERROR_RESET_MS);
    return () => clearTimeout(timer);
  }, [globalError]);

  return {
    hasSavedEntry,
    categories: VALIDATION_CATEGORIES,
    feedbackHtml,
    categoryState,
    isTriggeringAll,
    globalError,
    triggerAll,
  };
}

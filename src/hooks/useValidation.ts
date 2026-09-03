import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomFieldLocation } from '../App';
import {
  VALIDATION_CATEGORIES,
  isCategoryFilledOut,
  parseValidationConfig,
  resolvePath,
  valuesDiffer,
} from '../lib/validationConfig';
import {
  buildManagementHeaders,
  extractFeedbackByField,
  fetchFeedbackEntry,
  postEntryForValidation,
  type CategoryFeedback,
} from '../lib/validationApi';

export type CategoryState = 'idle' | 'pending' | 'error';

// All pending categories share one polling loop rather than one loop each —
// a category that joins mid-loop just gets picked up on the next shared tick
// instead of getting its own precisely-timed first check. Simpler to reason
// about with several categories potentially triggered at different times,
// at the cost of a category's first check landing anywhere from ~0-10s after
// it was queued rather than a fixed delay.
const POLL_INTERVAL_MS = 5_000;
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
  const [feedback, setFeedback] = useState<Record<string, CategoryFeedback>>({});
  const [categoryState, setCategoryState] = useState<Record<string, CategoryState>>({});
  const [isTriggeringAll, setIsTriggeringAll] = useState(false);
  const [globalError, setGlobalError] = useState('');

  // category key -> attempts remaining. The single source of truth for "is
  // anything still pending" — categoryState is just its UI reflection.
  const pendingAttemptsRef = useRef<Map<string, number>>(new Map());
  const isPollingRef = useRef(false);

  // entry.getData() reflects the last *saved* state for field values — wrong
  // to send as-is right after an edit — but it's the only reliable source
  // for entry-level metadata like `uid`, which entry.onChange's `resolved`
  // argument doesn't carry. So POST payloads are built by taking a fresh
  // entry.getData() as the base (guarantees uid/metadata are present and
  // current) and overlaying only the live field values captured from
  // onChange on top of it. This ref holds just those live overrides, kept
  // in sync by the single onChange subscription below.
  // Seeded from a full entry snapshot (not empty) so the very first diff
  // comparison below has a correct baseline instead of treating every field
  // as "changed from undefined" on the first edit after mount.
  const liveFieldOverridesRef = useRef<Record<string, unknown>>(customField.entry.getData() ?? {});

  const buildEntryPayload = useCallback((): Record<string, unknown> => {
    return { ...customField.entry.getData(), ...liveFieldOverridesRef.current };
  }, [customField]);

  useEffect(() => {
    customField.entry.onSave((savedEntry) => {
      if (isMounted.current && savedEntry?.uid) {
        setHasSavedEntry(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customField]);

  // `mode: 'initial'` (the one-shot check on mount) merges in whatever's
  // found for every category — `feedback` is still empty at that point, so
  // there's nothing to clobber. `mode: 'poll'` (every tick of the shared
  // polling loop) only merges categories that are actually pending right
  // now — otherwise a poll running for some *other* still-pending category
  // would blindly re-fetch and overwrite an already-resolved category (e.g.
  // one just locally set to "needs to be filled out" after an author was
  // removed) with whatever stale result is still sitting in the
  // ValidationFeedback entry from its last real run.
  const refreshFeedback = useCallback(
    async (mode: 'initial' | 'poll' = 'poll') => {
      if (!config.statusUrl) return;
      const entryUid = customField.entry.getData()?.uid;
      if (!entryUid) return;

      const feedbackEntry = await fetchFeedbackEntry(config.statusUrl, entryUid, managementHeaders);
      if (!feedbackEntry || !isMounted.current) return;

      const byField = extractFeedbackByField(feedbackEntry, feedbackFieldUids);

      const relevantByField: Record<string, CategoryFeedback> = {};
      for (const def of VALIDATION_CATEGORIES) {
        const value = byField[def.feedbackFieldUid];
        if (!value) continue;
        if (mode === 'initial' || pendingAttemptsRef.current.has(def.key)) {
          relevantByField[def.feedbackFieldUid] = value;
        }
      }

      if (Object.keys(relevantByField).length > 0) {
        setFeedback((prev) => ({ ...prev, ...relevantByField }));
      }

      setCategoryState((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const def of VALIDATION_CATEGORIES) {
          if (pendingAttemptsRef.current.has(def.key) && byField[def.feedbackFieldUid]) {
            pendingAttemptsRef.current.delete(def.key);
            next[def.key] = 'idle';
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [config, customField, managementHeaders, feedbackFieldUids]
  );

  // If validation has already run for this entry (e.g. the editor reopened
  // it after a previous trigger), show existing feedback immediately.
  useEffect(() => {
    if (!hasSavedEntry) return;
    refreshFeedback('initial');
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

  // A category whose configured fields are empty is shown a local "needs to
  // be filled out" message instead of being sent for validation at all — no
  // network call, no waiting/polling for it. Also clears any pending state
  // left over from an earlier still-in-flight trigger for this category —
  // otherwise the next poll tick would still treat it as pending, find the
  // old (now stale) result still sitting in the ValidationFeedback entry,
  // and silently overwrite this message with it.
  const showIncompleteMessage = useCallback((categoryKey: string) => {
    const def = VALIDATION_CATEGORIES.find((c) => c.key === categoryKey);
    if (!def) return;
    pendingAttemptsRef.current.delete(categoryKey);
    setFeedback((prev) => ({
      ...prev,
      [def.feedbackFieldUid]: {
        group: def.label,
        findings: [
          {
            status: 'incomplete',
            label: `${def.label} needs to be filled out before it can be validated.`,
          },
        ],
      },
    }));
    setCategoryState((prev) => ({ ...prev, [categoryKey]: 'idle' }));
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

    const entryData = buildEntryPayload();
    const readyCategories: string[] = [];
    for (const def of VALIDATION_CATEGORIES) {
      if (isCategoryFilledOut(entryData, config.categoryFieldPaths[def.key] ?? [])) {
        readyCategories.push(def.key);
      } else {
        showIncompleteMessage(def.key);
      }
    }

    // Nothing ready to validate — skip the network call entirely rather
    // than asking the orchestrator to check fields we already know are empty.
    if (readyCategories.length === 0) return;

    setIsTriggeringAll(true);

    try {
      await postEntryForValidation(config.triggerUrl, entryData);
    } catch (err) {
      if (isMounted.current) {
        setIsTriggeringAll(false);
        setGlobalError(err instanceof Error ? err.message : 'Failed to trigger validation.');
      }
      return;
    }

    if (!isMounted.current) return;
    setIsTriggeringAll(false);
    markPending(readyCategories);
    startPollingIfNeeded();
  }, [hasSavedEntry, config, buildEntryPayload, showIncompleteMessage, markPending, startPollingIfNeeded]);

  const triggerCategory = useCallback(
    async (categoryKey: string) => {
      const url = config.categoryUrls[categoryKey];
      if (!hasSavedEntry || !url) return;

      const entryData = buildEntryPayload();
      if (!isCategoryFilledOut(entryData, config.categoryFieldPaths[categoryKey] ?? [])) {
        showIncompleteMessage(categoryKey);
        return;
      }

      markPending([categoryKey]);

      try {
        await postEntryForValidation(url, entryData);
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
    [config, hasSavedEntry, buildEntryPayload, showIncompleteMessage, markPending, startPollingIfNeeded]
  );

  // Shared by both change-detection paths below (entry.onChange, and the
  // polling fallback) so a change is only ever debounced/triggered once no
  // matter which one notices it first — both read/write the same
  // liveFieldOverridesRef and debounceTimersRef.
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const checkForFieldChanges = useCallback(
    (next: Record<string, unknown>, source: 'onChange' | 'poll', pathsToCheck: Map<string, string>) => {
      const previous = liveFieldOverridesRef.current;

      if (pathsToCheck.size > 0) {
        const changedCategories = new Set<string>();
        pathsToCheck.forEach((categoryKey, path) => {
          const prevValues = resolvePath(previous, path);
          const nextValues = resolvePath(next, path);
          const changed = valuesDiffer(prevValues, nextValues);
          // TEMP DEBUG — remove once field-path watching is confirmed working
          // for nested/multi-field-group paths like "credits.authors[].author".
          console.log(`[Validation] (${source}) watch "${path}" (${categoryKey}):`, {
            prevValues,
            nextValues,
            changed,
          });
          if (changed) {
            changedCategories.add(categoryKey);
          }
        });

        changedCategories.forEach((categoryKey) => {
          const existingTimer = debounceTimersRef.current.get(categoryKey);
          if (existingTimer) clearTimeout(existingTimer);
          debounceTimersRef.current.set(
            categoryKey,
            setTimeout(() => {
              debounceTimersRef.current.delete(categoryKey);
              triggerCategory(categoryKey);
            }, FIELD_CHANGE_DEBOUNCE_MS)
          );
        });
      }

      // Merge rather than replace — `next` (from either source) only
      // reports the fields involved in that particular update, not a full
      // snapshot, so replacing outright would drop every other field's
      // last known live value.
      liveFieldOverridesRef.current = { ...previous, ...next };
    },
    [triggerCategory]
  );

  // Keeps liveFieldOverridesRef in sync with live edits on every change, and
  // auto-triggers a category's own check when one of its fields changes,
  // debounced so a category fires once after the editor pauses rather than
  // once per keystroke. Watches every configured path — for plain fields
  // this alone is enough, since onChange fires near-instantly.
  useEffect(() => {
    customField.entry.onChange((_unresolved, resolved) => {
      checkForFieldChanges(resolved ?? {}, 'onChange', config.fieldPathToCategory);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customField, config, checkForFieldChanges]);

  // Fallback for reference fields specifically (paths using the `[]`
  // multi-field-group marker — see referenceFieldPathToCategory), where
  // entry.onChange doesn't fire until some later UI commit point rather
  // than immediately: observed with Contentstack only reporting a change
  // made inside a Global Field/group once that group is collapsed again,
  // not when a reference is picked inside it. Plain text fields don't have
  // this problem and are left to onChange alone above — no need to poll
  // for them too. Polls entry.getData() on the same cadence as the
  // result-polling loop and runs it through the exact same change-detection
  // path, so a category only ever fires once regardless of which of the
  // two notices the change first (they share liveFieldOverridesRef/
  // debounceTimersRef above).
  useEffect(() => {
    if (config.referenceFieldPathToCategory.size === 0) return;

    let cancelled = false;

    const tick = async () => {
      while (!cancelled) {
        await wait(POLL_INTERVAL_MS);
        if (cancelled || !isMounted.current) return;
        checkForFieldChanges(customField.entry.getData() ?? {}, 'poll', config.referenceFieldPathToCategory);
      }
    };

    tick();

    return () => {
      cancelled = true;
    };
  }, [config, customField, checkForFieldChanges]);

  // Cancel any pending debounced triggers on unmount.
  useEffect(() => {
    return () => {
      debounceTimersRef.current.forEach((timer) => clearTimeout(timer));
      debounceTimersRef.current.clear();
    };
  }, []);

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
    feedback,
    categoryState,
    isTriggeringAll,
    globalError,
    triggerAll,
  };
}

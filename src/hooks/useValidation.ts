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
  // Pure cache of whatever the ValidationFeedback entry last reported for
  // each category — never synthesized/overwritten with a local message.
  // "Is this category actually ready to show that" is a separate concern,
  // handled by isFilledOutByCategory below.
  const [feedback, setFeedback] = useState<Record<string, CategoryFeedback>>({});
  const [categoryState, setCategoryState] = useState<Record<string, CategoryState>>({});
  const [isTriggeringAll, setIsTriggeringAll] = useState(false);
  const [globalError, setGlobalError] = useState('');

  // category key -> attempts remaining. The single source of truth for "is
  // anything still pending" — categoryState is just its UI reflection.
  const pendingAttemptsRef = useRef<Map<string, number>>(new Map());
  const isPollingRef = useRef(false);
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

  // Whether each category's configured fields currently have real content,
  // independent of anything fetched from the ValidationFeedback entry —
  // this is what the UI checks *first*, before ever looking at `feedback`,
  // so an empty field always shows "needs to be filled out" regardless of
  // whatever (possibly stale) report happens to be cached for it. Seeded
  // from the entry's state at mount so this is correct immediately, even
  // for an entry reopened with a field that was already emptied in an
  // earlier session (nothing needs to change this tick for it to be right).
  const [isFilledOutByCategory, setIsFilledOutByCategory] = useState<Record<string, boolean>>(() => {
    const entryData = customField.entry.getData() ?? {};
    const initial: Record<string, boolean> = {};
    for (const def of VALIDATION_CATEGORIES) {
      initial[def.key] = isCategoryFilledOut(entryData, config.categoryFieldPaths[def.key] ?? []);
    }
    return initial;
  });

  // Recomputes isFilledOutByCategory for the given categories against a
  // given entry snapshot, and returns the results so callers can act on
  // them immediately without waiting for the state update to land. Any
  // category that comes back empty also has its pending/debounce state
  // cleared — there's no point waiting on (or debouncing a trigger for) a
  // category we now know can't be validated.
  const syncFilledOutState = useCallback(
    (categoryKeys: string[], entryData: Record<string, unknown>): Map<string, boolean> => {
      const results = new Map<string, boolean>();
      for (const key of categoryKeys) {
        results.set(key, isCategoryFilledOut(entryData, config.categoryFieldPaths[key] ?? []));
      }

      setIsFilledOutByCategory((prev) => {
        let changed = false;
        const next = { ...prev };
        results.forEach((filled, key) => {
          if (next[key] !== filled) {
            next[key] = filled;
            changed = true;
          }
        });
        return changed ? next : prev;
      });

      const emptiedKeys: string[] = [];
      results.forEach((filled, key) => {
        if (filled) return;
        emptiedKeys.push(key);
        pendingAttemptsRef.current.delete(key);
        const existingTimer = debounceTimersRef.current.get(key);
        if (existingTimer) {
          clearTimeout(existingTimer);
          debounceTimersRef.current.delete(key);
        }
      });

      if (emptiedKeys.length > 0) {
        setCategoryState((prev) => {
          let changed = false;
          const next = { ...prev };
          emptiedKeys.forEach((key) => {
            if (next[key] && next[key] !== 'idle') {
              next[key] = 'idle';
              changed = true;
            }
          });
          return changed ? next : prev;
        });
      }

      return results;
    },
    [config]
  );

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

    const byField = extractFeedbackByField(feedbackEntry, feedbackFieldUids);
    if (Object.keys(byField).length > 0) {
      setFeedback((prev) => ({ ...prev, ...byField }));
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
  }, [config, customField, managementHeaders, feedbackFieldUids]);

  // If validation has already run for this entry (e.g. the editor reopened
  // it after a previous trigger), show existing feedback immediately. Any
  // category that's currently empty will still be hidden behind the
  // isFilledOutByCategory gate regardless of what this finds.
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

    const entryData = buildEntryPayload();
    const results = syncFilledOutState(
      VALIDATION_CATEGORIES.map((def) => def.key),
      entryData
    );
    const readyCategories = VALIDATION_CATEGORIES.filter((def) => results.get(def.key)).map((def) => def.key);

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
  }, [hasSavedEntry, config, buildEntryPayload, syncFilledOutState, markPending, startPollingIfNeeded]);

  const triggerCategory = useCallback(
    async (categoryKey: string) => {
      const url = config.categoryUrls[categoryKey];
      if (!hasSavedEntry || !url) return;

      const entryData = buildEntryPayload();
      const results = syncFilledOutState([categoryKey], entryData);
      // TEMP DEBUG — remove alongside the other TEMP DEBUG logs once
      // reference-field auto-trigger payloads are confirmed correct.
      console.log(`[Validation] triggerCategory("${categoryKey}") payload check`, {
        filledOut: results.get(categoryKey),
        paths: config.categoryFieldPaths[categoryKey] ?? [],
        resolvedValues: (config.categoryFieldPaths[categoryKey] ?? []).map((path) => resolvePath(entryData, path)),
        liveOverrides: liveFieldOverridesRef.current,
      });
      if (!results.get(categoryKey)) return;

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
    [config, hasSavedEntry, buildEntryPayload, syncFilledOutState, markPending, startPollingIfNeeded]
  );

  // Shared by both change-detection paths below (entry.onChange, and the
  // polling fallback) so a change is only ever debounced/triggered once no
  // matter which one notices it first — both read/write the same
  // liveFieldOverridesRef and debounceTimersRef.
  const checkForFieldChanges = useCallback(
    (next: Record<string, unknown>, source: 'onChange' | 'poll', pathsToCheck: Map<string, string>) => {
      const previous = liveFieldOverridesRef.current;

      // entry.onChange's `resolved` reflects genuine live edits, so merging
      // it in full is safe and correct. The reference-field poll, on the
      // other hand, calls raw entry.getData() — which reflects the last
      // *saved* state for anything outside the specific reference paths
      // being polled — so a blanket merge from that source would silently
      // revert any other field's live, unsaved edit (e.g. a headline being
      // typed) back to its saved value the next time the poll ticks.
      // Restrict the poll's contribution to just the top-level keys it's
      // actually responsible for.
      let merged: Record<string, unknown>;
      if (source === 'poll') {
        const topLevelKeys = new Set<string>();
        pathsToCheck.forEach((_categoryKey, path) => {
          const firstSegment = path.split('.')[0];
          topLevelKeys.add(firstSegment.endsWith('[]') ? firstSegment.slice(0, -2) : firstSegment);
        });
        merged = { ...previous };
        topLevelKeys.forEach((key) => {
          if (key in next) merged[key] = next[key];
        });
      } else {
        merged = { ...previous, ...next };
      }

      if (pathsToCheck.size > 0) {
        const changedCategories = new Set<string>();
        pathsToCheck.forEach((categoryKey, path) => {
          const prevValues = resolvePath(previous, path);
          const nextValues = resolvePath(next, path);
          const changed = valuesDiffer(prevValues, nextValues);
          // TEMP DEBUG — remove once field-path watching is confirmed working
          // for nested/multi-field-group paths like "credits.authors[].author".
          // onChange fires on every keystroke, so it's only logged when it
          // actually found a change. The reference-field poll only fires
          // every 5s, so it's cheap to log unconditionally — and doing so is
          // the whole point right now: it tells us whether entry.getData()
          // ever reflects a newly-added group item / reference change at
          // all, as opposed to our diff logic failing to notice one it did
          // receive.
          if (changed || source === 'poll') {
            console.log(`[Validation] (${source}) watch "${path}" (${categoryKey}):`, {
              prevValues,
              nextValues,
              changed,
            });
          }
          if (changed) {
            changedCategories.add(categoryKey);
          }
        });

        if (changedCategories.size > 0) {
          // Update isFilledOutByCategory (and clean up pending/debounce
          // state for any category that just became empty) immediately —
          // this doesn't need the debounce below, since it's just a local
          // UI decision, not a network call.
          const results = syncFilledOutState(Array.from(changedCategories), merged);

          changedCategories.forEach((categoryKey) => {
            // Now-empty categories were already handled by
            // syncFilledOutState above (pending/debounce cleared) — no
            // trigger to schedule for them.
            if (!results.get(categoryKey)) return;

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
      }

      liveFieldOverridesRef.current = merged;
    },
    [triggerCategory, syncFilledOutState]
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
    isFilledOutByCategory,
    categoryState,
    isTriggeringAll,
    globalError,
    triggerAll,
  };
}

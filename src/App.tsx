import { useEffect, useState } from 'react';
import ContentstackAppSDK from '@contentstack/app-sdk';
import ValidationButton from './components/ValidationButton';

// Derive types straight off the SDK's own return value instead of deep-importing
// internal paths — @contentstack/app-sdk only publishes `dist/src/index.d.ts` as
// its public "types" entry, and that entry doesn't re-export ICustomField.
type UILocation = Awaited<ReturnType<typeof ContentstackAppSDK.init>>;
export type CustomFieldLocation = NonNullable<UILocation['location']['CustomField']>;

function App() {
  const [customField, setCustomField] = useState<CustomFieldLocation | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    ContentstackAppSDK.init()
      .then((sdk) => {
        const field = sdk.location.CustomField;
        if (!field) {
          setInitError('This app is not running inside a Custom Field location.');
          return;
        }
        field.frame.enableAutoResizing();
        field.frame.updateHeight();
        setCustomField(field);
      })
      .catch((err) => {
        setInitError(err instanceof Error ? err.message : 'Failed to initialize the App SDK.');
      });
  }, []);

  // Debug aid: log which top-level field(s) changed on every entry edit.
  // entry.onChange fires on real user edits (unlike field.onChange, which is
  // only for programmatic writes from other apps/extensions), but it hands
  // back the whole entry each time rather than a single field, so we diff
  // against the previous snapshot ourselves to know what actually changed.
  // Reference/group/array field values are new objects on every change, so
  // they'll always log as "changed" even if their contents are identical —
  // fine for a debug log, not a signal to build real behavior on.
  useEffect(() => {
    if (!customField) return;
    let previous: Record<string, unknown> = customField.entry.getData();

    customField.entry.onChange((_unresolved, resolved) => {
      const next: Record<string, unknown> = resolved ?? {};
      const uids = new Set([...Object.keys(previous), ...Object.keys(next)]);
      for (const uid of uids) {
        if (previous[uid] !== next[uid]) {
          console.log(`[FieldWatcher] "${uid}" changed`, { from: previous[uid], to: next[uid] });
        }
      }
      previous = next;
    });
  }, [customField]);

  if (initError) {
    return <div className="cs-app cs-app--error">{initError}</div>;
  }

  if (!customField) {
    return <div className="cs-app cs-app--loading">Loading…</div>;
  }

  return (
    <div className="cs-app">
      <ValidationButton customField={customField} />
    </div>
  );
}

export default App;

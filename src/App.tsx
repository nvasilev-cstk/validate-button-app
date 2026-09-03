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

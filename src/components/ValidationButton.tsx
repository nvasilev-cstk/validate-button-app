import { AlertCircle, CheckCircle2, Info, Loader2, ShieldCheck } from 'lucide-react';
import type { CustomFieldLocation } from '../App';
import { useValidation } from '../hooks/useValidation';

interface ValidationButtonProps {
  customField: CustomFieldLocation;
}

function ValidationButton({ customField }: ValidationButtonProps) {
  const { hasSavedEntry, categories, feedbackHtml, categoryState, isTriggeringAll, globalError, triggerAll } =
    useValidation(customField);

  const label = isTriggeringAll ? 'Sending…' : 'Trigger Validation';

  return (
    <div className="validation-trigger">
      <button
        type="button"
        className="cs-btn cs-btn--primary"
        onClick={triggerAll}
        disabled={isTriggeringAll || !hasSavedEntry}
      >
        {isTriggeringAll ? (
          <Loader2 className="cs-btn__icon cs-btn__icon--spin" size={16} />
        ) : (
          <ShieldCheck className="cs-btn__icon" size={16} />
        )}
        <span>{label}</span>
      </button>

      {!hasSavedEntry && (
        <div className="cs-status cs-status--pending">
          <Info size={14} />
          <span>Save this entry before running validation.</span>
        </div>
      )}

      {globalError && (
        <div className="cs-status cs-status--error">
          <AlertCircle size={14} />
          <span>{globalError}</span>
        </div>
      )}

      {categories.map((category) => {
        const html = feedbackHtml[category.feedbackFieldUid];
        const state = categoryState[category.key] ?? 'idle';

        // Nothing to show and nothing in progress — omit entirely, per spec.
        if (!html && state === 'idle') return null;

        return (
          <div key={category.key} className="cs-status cs-status--success cs-status--feedback">
            {state === 'pending' ? (
              <Loader2 className="cs-status__icon cs-status__icon--spin" size={14} />
            ) : state === 'error' ? (
              <AlertCircle size={14} />
            ) : (
              <CheckCircle2 size={14} />
            )}
            <div className="cs-status__content">
              <div className="cs-status__category-label">{category.label}</div>
              {html ? (
                <div dangerouslySetInnerHTML={{ __html: html }} />
              ) : state === 'pending' ? (
                <span>Waiting for results…</span>
              ) : (
                <span>Validation failed or timed out.</span>
              )}
              {html && state === 'pending' && <div className="cs-status__rechecking">Re-checking…</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ValidationButton;

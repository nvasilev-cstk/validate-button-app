import { AlertCircle, Info, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import type { CustomFieldLocation } from '../App';
import { useValidation } from '../hooks/useValidation';
import type { ValidationFinding } from '../lib/validationApi';

interface ValidationButtonProps {
  customField: CustomFieldLocation;
}

// Only findings with status "fail" are ever shown — passes, warnings, and
// any other informational status are filtered out before rendering (see
// the errorFindings filter in ValidationButton below), so this only needs
// to render the error case.
//
// A finding's `label` names the passing condition ("Headline is not a
// placeholder"), which reads backwards on an error, so the row leads with
// `message` — what's actually wrong — and only falls back to the label when
// an automation didn't supply one. `found` is skipped when the message
// already quotes it, to avoid saying the same value twice.
function FindingRow({ finding }: { finding: ValidationFinding }) {
  const message = finding.message?.trim();
  const found = finding.found?.trim();
  const showFound = Boolean(found) && !(message && message.includes(found!));
  return (
    <li className="cs-finding cs-finding--fail">
      <XCircle size={12} className="cs-finding__icon cs-finding__icon--fail" />
      <div className="cs-finding__body">
        <span className="cs-finding__label">{message || finding.label || finding.id || 'Check'}</span>
        {showFound && (
          <div className="cs-finding__detail">
            <strong>Found:</strong> {finding.found}
          </div>
        )}
        {finding.fix && (
          <div className="cs-finding__detail">
            <strong>Fix:</strong> {finding.fix}
          </div>
        )}
      </div>
    </li>
  );
}

function ValidationButton({ customField }: ValidationButtonProps) {
  const {
    hasSavedEntry,
    categories,
    feedback,
    isFilledOutByCategory,
    categoryState,
    isTriggeringAll,
    globalError,
    triggerAll,
  } = useValidation(customField);

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
        // Emptiness always wins: an empty configured field means the
        // category can't be validated right now, so nothing is shown for
        // it — no "needs to be filled out" notice (only actual errors are
        // surfaced), and no cached report either, even a legitimate one
        // from before the field was cleared, since it's now stale.
        // Checked first, ahead of everything else below.
        if (isFilledOutByCategory[category.key] === false) return null;

        // Only actual errors are surfaced: anything that isn't a "fail"
        // (passes, warnings, informational notes) is dropped here, and a
        // category whose report has no errors is hidden entirely — it
        // doesn't render a block at all, same as one with no report yet.
        const errorFindings = (feedback[category.feedbackFieldUid]?.findings ?? []).filter(
          (finding) => finding.status === 'fail'
        );
        const hasErrors = errorFindings.length > 0;
        const state = categoryState[category.key] ?? 'idle';

        // No errors and nothing in progress — omit entirely.
        if (!hasErrors && state === 'idle') return null;

        return (
          <div key={category.key} className="cs-status cs-status--report">
            {state === 'pending' && !hasErrors ? (
              <Loader2 className="cs-status__icon cs-status__icon--spin" size={14} />
            ) : (
              <AlertCircle size={14} className="cs-finding__icon--fail" />
            )}
            <div className="cs-status__content">
              <div className="cs-status__category-label">{category.label}</div>
              {hasErrors ? (
                <ul className="cs-findings">
                  {errorFindings.map((finding, index) => (
                    <FindingRow key={finding.id ?? index} finding={finding} />
                  ))}
                </ul>
              ) : state === 'pending' ? (
                <span>Waiting for results…</span>
              ) : (
                <span>Validation failed or timed out.</span>
              )}
              {hasErrors && state === 'pending' && <div className="cs-status__rechecking">Re-checking…</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ValidationButton;

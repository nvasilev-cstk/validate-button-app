import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Info, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import type { CustomFieldLocation } from '../App';
import { useValidation } from '../hooks/useValidation';
import type { ValidationFinding } from '../lib/validationApi';

interface ValidationButtonProps {
  customField: CustomFieldLocation;
}

function FindingIcon({ status }: { status?: string }) {
  if (status === 'pass') return <CheckCircle2 size={12} className="cs-finding__icon cs-finding__icon--pass" />;
  if (status === 'fail') return <XCircle size={12} className="cs-finding__icon cs-finding__icon--fail" />;
  if (status === 'incomplete') return <AlertTriangle size={12} className="cs-finding__icon cs-finding__icon--incomplete" />;
  return <HelpCircle size={12} className="cs-finding__icon cs-finding__icon--unknown" />;
}

function FindingRow({ finding }: { finding: ValidationFinding }) {
  const statusClass =
    finding.status === 'pass'
      ? 'cs-finding--pass'
      : finding.status === 'fail'
        ? 'cs-finding--fail'
        : finding.status === 'incomplete'
          ? 'cs-finding--incomplete'
          : 'cs-finding--unknown';

  return (
    <li className={`cs-finding ${statusClass}`}>
      <FindingIcon status={finding.status} />
      <div className="cs-finding__body">
        <span className="cs-finding__label">{finding.label || finding.id || 'Check'}</span>
        {finding.message && <div className="cs-finding__detail">{finding.message}</div>}
        {finding.found && (
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

function CategoryIcon({ findings }: { findings: ValidationFinding[] }) {
  if (findings.some((f) => f.status === 'fail')) return <AlertCircle size={14} className="cs-finding__icon--fail" />;
  if (findings.some((f) => f.status === 'incomplete')) return <AlertTriangle size={14} className="cs-finding__icon--incomplete" />;
  return <CheckCircle2 size={14} />;
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
        // category can't be validated right now, no matter what's cached
        // in `feedback` (even a legitimate report from before the field
        // was cleared) — checked first, ahead of everything else below.
        if (isFilledOutByCategory[category.key] === false) {
          return (
            <div key={category.key} className="cs-status cs-status--report">
              <AlertTriangle size={14} className="cs-finding__icon--incomplete" />
              <div className="cs-status__content">
                <div className="cs-status__category-label">{category.label}</div>
                <span>{category.label} needs to be filled out before it can be validated.</span>
              </div>
            </div>
          );
        }

        const data = feedback[category.feedbackFieldUid];
        const state = categoryState[category.key] ?? 'idle';

        // Nothing to show and nothing in progress — omit entirely, per spec.
        if (!data && state === 'idle') return null;

        return (
          <div key={category.key} className="cs-status cs-status--report">
            {state === 'pending' && !data ? (
              <Loader2 className="cs-status__icon cs-status__icon--spin" size={14} />
            ) : state === 'error' && !data ? (
              <AlertCircle size={14} />
            ) : data ? (
              <CategoryIcon findings={data.findings} />
            ) : (
              <CheckCircle2 size={14} />
            )}
            <div className="cs-status__content">
              <div className="cs-status__category-label">{category.label}</div>
              {data ? (
                <ul className="cs-findings">
                  {data.findings.map((finding, index) => (
                    <FindingRow key={finding.id ?? index} finding={finding} />
                  ))}
                </ul>
              ) : state === 'pending' ? (
                <span>Waiting for results…</span>
              ) : (
                <span>Validation failed or timed out.</span>
              )}
              {data && state === 'pending' && <div className="cs-status__rechecking">Re-checking…</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ValidationButton;

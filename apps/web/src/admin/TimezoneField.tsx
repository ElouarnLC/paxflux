import React, { useId, useMemo } from 'react';
import { isValidTimezone, supportedTimezones } from '@paxflux/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Timezone selection for an event.
 *
 * A `datalist` rather than a `<select>` of four hundred options: it stays a
 * text field, so it is searchable by typing on every platform and needs no
 * custom listbox to remain reachable at 320px, while still offering the real
 * list where the engine has one.
 *
 * Where `Intl.supportedValuesOf` is missing the field degrades to free entry,
 * which is why the value is validated here as well — and, decisively, on the
 * server. Nothing about correctness rests on the browser.
 */
export interface TimezoneFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  /**
   * The value as stored, when editing an existing event.
   *
   * Events created before the IANA rule may hold something this field would
   * reject — `GMT`, `EST`, a bare offset. Such a value is not an error the
   * operator has just made, and refusing to let them rename the event until
   * they fix it would be the wrong trade. So an unchanged stored value is
   * reported as a legacy value that may stay, and only a *change* is held to
   * the rule.
   */
  storedValue?: string;
}

export const TimezoneField: React.FC<TimezoneFieldProps> = ({
  value,
  onChange,
  label = 'Fuseau horaire',
  disabled,
  storedValue,
}) => {
  const inputId = useId();
  const listId = `${inputId}-zones`;
  const zones = useMemo(() => supportedTimezones(), []);
  const valid = isValidTimezone(value);
  const unchangedLegacy = !valid && storedValue !== undefined && value === storedValue;
  const blocking = !valid && !unchangedLegacy;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        type="text"
        list={zones.length > 0 ? listId : undefined}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={blocking}
        aria-describedby={`${inputId}-hint`}
        onChange={(e) => onChange(e.target.value)}
      />
      {zones.length > 0 ? (
        <datalist id={listId}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      ) : null}
      {/* Written, not signalled by colour alone. */}
      <p
        id={`${inputId}-hint`}
        data-testid="timezone-hint"
        className={
          blocking
            ? 'text-xs font-semibold text-danger'
            : unchangedLegacy
              ? 'text-xs font-semibold text-warning'
              : 'text-xs text-muted-foreground'
        }
      >
        {blocking
          ? 'Fuseau horaire inconnu. Utilisez un identifiant comme Europe/Paris.'
          : unchangedLegacy
            ? 'Fuseau horaire hérité, conservé tel quel. Vous pouvez enregistrer sans y toucher ; toute modification devra utiliser un identifiant comme Europe/Paris.'
            : 'Les journées et les exports de l’événement sont découpés dans ce fuseau.'}
      </p>
    </div>
  );
};

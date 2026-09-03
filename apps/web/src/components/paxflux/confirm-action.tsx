import * as React from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The two confirmation shapes PaxFlux needs, and nothing else.
 *
 * They replace `window.confirm` and `window.prompt`, which were unusable
 * for this product in three concrete ways: a browser dialog cannot be
 * styled to show that force-closing is dangerous, it cannot validate the
 * reason before accepting it, and on a phone installed as a PWA it renders
 * as an unbranded system sheet naming the origin.
 *
 * Both keep the one behaviour that matters most: **cancelling sends
 * nothing**. `onConfirm` is the only path to a request.
 */

/** Minimum length the server accepts for an audited reason. */
export const MIN_REASON_LENGTH = 3;

export interface ConfirmActionProps {
  /** The button that opens it. Focus returns here on close. */
  trigger: React.ReactElement;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonProps['variant'];
  /** Disables the trigger — an action already in flight, or not available. */
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  confirmVariant = 'default',
  disabled,
  busy,
  onConfirm,
}: ConfirmActionProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild disabled={disabled}>
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          {/* Cancel first in the DOM so Radix lands initial focus on it: a
              stray Enter must never close an event. */}
          <AlertDialogCancel asChild>
            <Button variant="outline">Annuler</Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant={confirmVariant}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                setOpen(false);
                void onConfirm();
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ReasonActionProps extends Omit<ConfirmActionProps, 'onConfirm'> {
  /** Label of the reason field. */
  reasonLabel: string;
  reasonPlaceholder?: string;
  onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * A confirmation that also collects the audited reason, in one step.
 *
 * The browser version asked twice — `prompt` for the reason, then `confirm`
 * to accept it — and validated the length only after the second answer, so
 * a two-character reason cost the operator the whole sequence. Here the
 * confirm button is simply unavailable until the reason is long enough, and
 * the field says why.
 */
export function ReasonAction({
  trigger,
  title,
  description,
  confirmLabel,
  confirmVariant = 'danger',
  disabled,
  busy,
  reasonLabel,
  reasonPlaceholder,
  onConfirm,
}: ReasonActionProps) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const inputId = React.useId();

  const trimmed = reason.trim();
  const tooShort = trimmed.length < MIN_REASON_LENGTH;

  // Every opening starts from an empty field: a reason typed for a
  // transition that was then cancelled must not be carried into the next.
  React.useEffect(() => {
    if (!open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild disabled={disabled}>
        {trigger}
      </DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(e) => {
          // Focus the reason field: it is the only thing the operator has
          // to do here, and it is what the dialog exists for.
          e.preventDefault();
          document.getElementById(inputId)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id={`${inputId}-form`}
            onSubmit={(e) => {
              e.preventDefault();
              if (tooShort) {
                setTouched(true);
                return;
              }
              setOpen(false);
              void onConfirm(trimmed);
            }}
            className="space-y-1.5"
          >
            <Label htmlFor={inputId}>{reasonLabel}</Label>
            <Input
              id={inputId}
              value={reason}
              placeholder={reasonPlaceholder}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && tooShort ? true : undefined}
              aria-describedby={`${inputId}-hint`}
            />
            <p
              id={`${inputId}-hint`}
              className={touched && tooShort ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}
            >
              {`Motif obligatoire, ${MIN_REASON_LENGTH} caractères minimum. Il est conservé dans le journal d’audit.`}
            </p>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button
            type="submit"
            form={`${inputId}-form`}
            variant={confirmVariant}
            disabled={busy || tooShort}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RenameActionProps extends Omit<ConfirmActionProps, 'onConfirm' | 'description'> {
  description?: React.ReactNode;
  /** Field label, e.g. "Nom de l'appareil". */
  fieldLabel: string;
  /** The value as it stands. Every opening starts from this, not from the last attempt. */
  currentValue: string;
  maxLength: number;
  placeholder?: string;
  /** The server's refusal, shown in the dialog so the operator can correct it in place. */
  errorMessage?: string | null;
  /**
   * Called when the dialog opens.
   *
   * Lets the caller drop a refusal from a previous attempt: an error the
   * operator has already closed the dialog on should not greet them when
   * they open it again.
   */
  onOpen?: () => void;
  /** Resolve to `true` when the save succeeded; the dialog stays open otherwise. */
  onRename: (value: string) => Promise<boolean>;
}

/**
 * Renaming something, in a dialog rather than a `window.prompt`.
 *
 * Close cousin of `ReasonAction` and deliberately not the same component:
 * a reason is written fresh each time and must be long enough to be
 * auditable, while a name arrives already set and only has to be non-empty
 * and bounded. Sharing one component would mean a `mode` flag and two sets
 * of half-applicable rules.
 *
 * What it keeps from the rest of this file: cancelling sends nothing, and
 * the confirm button is unavailable until the value could actually be
 * accepted. What it adds: the dialog stays open when the server refuses, so
 * the operator can fix the name where they typed it instead of finding out
 * from a row that quietly did not change.
 */
export function RenameAction({
  trigger,
  title,
  description,
  confirmLabel,
  confirmVariant = 'default',
  disabled,
  busy,
  fieldLabel,
  currentValue,
  maxLength,
  placeholder,
  errorMessage,
  onOpen,
  onRename,
}: RenameActionProps) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(currentValue);
  const [saving, setSaving] = React.useState(false);
  const inputId = React.useId();

  // Every opening starts from what is stored now, not from an abandoned
  // attempt or from a value another row has since changed.
  React.useEffect(() => {
    if (open) setValue(currentValue);
  }, [open, currentValue]);

  // And from a clean slate: a refusal belongs to the attempt that caused it.
  const onOpenRef = React.useRef(onOpen);
  onOpenRef.current = onOpen;
  React.useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  const trimmed = value.trim();
  const invalid = trimmed.length === 0 || trimmed.length > maxLength;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild disabled={disabled}>
        {trigger}
      </DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById(inputId)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>
          <form
            id={`${inputId}-form`}
            onSubmit={async (e) => {
              e.preventDefault();
              if (invalid || saving) return;
              setSaving(true);
              try {
                // Only a success closes it. A refusal leaves the operator
                // looking at the name they typed and the reason it was
                // rejected.
                if (await onRename(trimmed)) setOpen(false);
              } finally {
                setSaving(false);
              }
            }}
            className="space-y-1.5"
          >
            <Label htmlFor={inputId}>{fieldLabel}</Label>
            <Input
              id={inputId}
              value={value}
              maxLength={maxLength}
              placeholder={placeholder}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={`${inputId}-hint`}
            />
            <p
              id={`${inputId}-hint`}
              className={errorMessage || invalid ? 'text-xs font-semibold text-danger' : 'text-xs text-muted-foreground'}
            >
              {errorMessage ?? (invalid ? 'Le nom ne peut pas être vide.' : `${maxLength} caractères maximum.`)}
            </p>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button type="submit" form={`${inputId}-form`} variant={confirmVariant} disabled={busy || saving || invalid}>
            {busy || saving ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

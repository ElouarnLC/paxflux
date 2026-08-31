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

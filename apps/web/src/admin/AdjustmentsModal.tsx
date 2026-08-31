import React, { useState } from 'react';
import { apiFetch } from '../api/client.js';
import { Sliders, AlertCircle, Loader2 } from 'lucide-react';
import { ProblemDetails } from '@paxflux/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardPanel } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

interface AdjustmentsModalProps {
  eventId: string;
  spaces: Array<{ id: string; name: string; kind: string }>;
  currentOccupancies: Record<string, number>;
  onClose: () => void;
  onSuccess: () => void;
}

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

/**
 * Supervised gauge correction.
 *
 * No route mounts this component today, and Phase 8 deliberately does not
 * wire one: giving it a home is a product decision, not a design-system
 * one. What it does get here is the common Dialog in place of the
 * hand-rolled `fixed inset-0` overlay it used to paint — so the day it is
 * mounted it already has the focus trap, the Escape handling and the
 * safe-area behaviour every other portalled surface has, rather than a
 * lookalike that has none of them.
 */
export const AdjustmentsModal: React.FC<AdjustmentsModalProps> = ({
  eventId,
  spaces,
  currentOccupancies,
  onClose,
  onSuccess,
}) => {
  const leafSpaces = spaces.filter((s) => s.kind === 'leaf');
  const [selectedSpaceId, setSelectedSpaceId] = useState(leafSpaces[0]?.id || '');
  const [observedCount, setObservedCount] = useState<number>(
    currentOccupancies[leafSpaces[0]?.id] || 0
  );
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentSystemCount = currentOccupancies[selectedSpaceId] || 0;
  const delta = observedCount - currentSystemCount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || reason.trim().length < 3) {
      setError('Un motif explicite d’au moins 3 caractères est obligatoire.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await apiFetch(`/api/v1/events/${eventId}/adjustments`, {
        method: 'POST',
        body: JSON.stringify({
          spaceId: selectedSpaceId,
          observedCount,
          reason: reason.trim(),
        }),
      });

      onSuccess();
      onClose();
    } catch (err) {
      setError(errorDetail(err, 'Erreur lors de l’application de la correction.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-warning/40 bg-warning/10 text-warning">
              <Sliders className="size-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>Correction de Jauge Supervisée</DialogTitle>
              <DialogDescription>Ajustement audité dans le journal des mouvements.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody>
          {error ? (
            <Alert tone="danger" className="mb-4">
              <AlertCircle />
              <AlertDescription className="mt-0 text-foreground/90">{error}</AlertDescription>
            </Alert>
          ) : null}

          <form id="adjustment-form" onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="adjustment-space">Zone à corriger</Label>
              <NativeSelect
                id="adjustment-space"
                value={selectedSpaceId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedSpaceId(id);
                  setObservedCount(currentOccupancies[id] || 0);
                }}
              >
                {leafSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <CardPanel className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Valeur Système
                </span>
                <span className="font-mono text-2xl font-black text-foreground/80">
                  {currentSystemCount}
                </span>
              </div>

              <div className="space-y-1">
                <Label htmlFor="adjustment-observed" className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Valeur Observée Réelle *
                </Label>
                <Input
                  id="adjustment-observed"
                  type="number"
                  min="0"
                  required
                  value={observedCount}
                  onChange={(e) => setObservedCount(parseInt(e.target.value, 10) || 0)}
                  className="font-mono text-xl font-bold"
                />
              </div>
            </CardPanel>

            <div className="flex items-center justify-between rounded-lg border border-primary-accent/40 bg-primary/10 p-3 text-xs text-foreground/90">
              <span>Correction nette calculée :</span>
              <span className="font-mono text-sm font-bold">{delta > 0 ? `+${delta}` : delta}</span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adjustment-reason">Motif de la correction *</Label>
              <Textarea
                id="adjustment-reason"
                required
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ex: Recomptage manuel après coupure réseau temporaire"
              />
            </div>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="adjustment-form" variant="closing" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            Appliquer la correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

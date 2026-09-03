import { z } from 'zod';

/**
 * What a device may be called, wherever it is named.
 *
 * A device label names the *physical phone* — "Téléphone entrée nord" — and
 * is deliberately not the checkpoint's name. One door can have several
 * handsets on it, and an operator holding one of them needs to know which
 * one they are holding.
 *
 * There is one schema rather than one per caller because there are two
 * callers with the same rule: staff renaming a device from the management
 * table, and the device renaming itself after pairing. They were previously
 * an untyped `{ label?: string }` read and nothing at all.
 */

/**
 * The upper bound, and why it is this number.
 *
 * The column is `TEXT` and imposes nothing, so the bound is a product
 * decision. It has to be at least as large as the label the server itself
 * generates at pairing time — `${checkpoint.name} — appareil ${n}` in
 * `auth/pairing.ts` — because a device must always be able to save the name
 * it was given. A checkpoint name is capped at 100, and the suffix costs
 * about 15 more, so anything under ~120 would make the server's own default
 * unsaveable. 120 also matches the event-name bound, which is the longest
 * free-text field the product already accepts.
 */
export const DEVICE_LABEL_MAX_LENGTH = 120;

/**
 * Trims first, then validates.
 *
 * Trimming before the length and emptiness checks is what makes "   " a
 * refusal rather than a three-character name, and it means the value stored
 * is the value validated — no caller can trim afterwards and store something
 * the schema never saw.
 */
export const DeviceLabelSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'Le nom de l’appareil ne peut pas être vide.')
      .max(DEVICE_LABEL_MAX_LENGTH, `Le nom de l’appareil est limité à ${DEVICE_LABEL_MAX_LENGTH} caractères.`)
  );

/** The body both rename endpoints accept, and the only field either changes. */
export const RenameDeviceRequestSchema = z.object({
  label: DeviceLabelSchema,
});
export type RenameDeviceRequest = z.infer<typeof RenameDeviceRequestSchema>;

/**
 * What a rename returns.
 *
 * The canonical stored label, plus the session it belongs to. The id matters
 * for the self-rename: the client uses it to check the response describes the
 * pairing it still holds before letting it touch local state.
 */
export interface RenameDeviceResponse {
  deviceSession: {
    id: string;
    label: string;
  };
}

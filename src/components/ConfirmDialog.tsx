/**
 * OSP-72: confirmation for admin actions. Focus starts on "Vazgeç" so Enter never confirms by
 * accident. An optional acknowledgement checkbox gates the confirm button (global revoke). While
 * the request runs both buttons are disabled and Escape is ignored; an error stays in the dialog.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone: 'danger' | 'default';
  acknowledgement?: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** See Dialog `returnFocus` (OSP-72). */
  returnFocus?: () => HTMLElement | null;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Vazgeç',
  tone,
  acknowledgement,
  pending,
  error,
  onConfirm,
  onCancel,
  returnFocus,
}: ConfirmDialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = acknowledgement !== undefined && !acknowledged;

  return (
    <Dialog
      role="alertdialog"
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={() => {
        if (!pending) onCancel();
      }}
      initialFocusRef={cancelRef}
      returnFocus={returnFocus}
      className={tone === 'danger' ? 'modal-danger' : undefined}
    >
      <h2 id={titleId}>{title}</h2>
      <div id={descriptionId}>{children}</div>
      {acknowledgement !== undefined && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={pending}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {acknowledgement}
        </label>
      )}
      {error && (
        <div role="alert" className="banner-error">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" ref={cancelRef} className="button-secondary" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={tone === 'danger' ? 'button-danger' : undefined}
          onClick={onConfirm}
          disabled={pending || blocked}
        >
          {pending ? 'İşleniyor…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

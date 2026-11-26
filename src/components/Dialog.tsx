/**
 * OSP-72: accessible modal used by the admin screens. A plain element with `aria-modal` (no
 * `<dialog>.showModal()`, which jsdom does not support): focus moves in on mount and back to the
 * opener on unmount, Tab / Shift+Tab stay inside, Escape calls `onClose`. A backdrop click does
 * NOT close it, so a destructive confirmation cannot be dismissed (or confirmed) by accident.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  role: 'dialog' | 'alertdialog';
  titleId: string;
  descriptionId?: string;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  /**
   * OSP-72: element to focus when the dialog closes, read at that moment. Used when the action
   * replaced or removed the opener. Without it (or when it returns null) focus goes back to the
   * opener if it is still in the document.
   */
  returnFocus?: () => HTMLElement | null;
  children?: ReactNode;
}

export function Dialog({
  role,
  titleId,
  descriptionId,
  onClose,
  initialFocusRef,
  className,
  returnFocus,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocusRef?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current;
    target?.focus();

    function onKeyDown(event: KeyboardEvent) {
      const root = ref.current;
      if (!root) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const target = returnFocusRef.current?.() ?? null;
      if (target && target.isConnected) target.focus();
      else if (opener && opener.isConnected) opener.focus();
    };
    // Mount / unmount only: focus must not jump while the dialog re-renders.
  }, []);

  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={className ? `modal ${className}` : 'modal'}
      >
        {children}
      </div>
    </div>
  );
}

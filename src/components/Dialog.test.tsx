import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from './Dialog';
import { ConfirmDialog } from './ConfirmDialog';

// OSP-72: modal focus handling and the confirmation dialog.
function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Aç
      </button>
      {open && (
        <Dialog
          role="dialog"
          titleId="t"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <h2 id="t">Başlık</h2>
          <button type="button">Birinci</button>
          <button type="button">İkinci</button>
        </Dialog>
      )}
    </>
  );
}

describe('Dialog', () => {
  it('focuses the first control, traps Tab, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Aç' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Başlık' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Birinci' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'İkinci' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Birinci' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'İkinci' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('does not close on a backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Aç' }));
    await user.click(container.querySelector('.modal-backdrop') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Dialog returnFocus (OSP-72)', () => {
  it('focuses the returnFocus target on close instead of the opener', async () => {
    function WithTarget() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <h3 id="target" tabIndex={-1}>
            Hedef
          </h3>
          <button type="button" onClick={() => setOpen(true)}>
            Aç
          </button>
          {open && (
            <Dialog
              role="dialog"
              titleId="t2"
              onClose={() => setOpen(false)}
              returnFocus={() => document.getElementById('target')}
            >
              <h2 id="t2">Başlık</h2>
              <button type="button">Tamam</button>
            </Dialog>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<WithTarget />);
    await user.click(screen.getByRole('button', { name: 'Aç' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('heading', { name: 'Hedef' })).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  function renderConfirm(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Onay"
        confirmLabel="Evet"
        tone="danger"
        pending={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      >
        <p>Açıklama</p>
      </ConfirmDialog>,
    );
    return { onConfirm, onCancel, user: userEvent.setup() };
  }

  it('is an alertdialog with focus on Vazgeç', () => {
    renderConfirm();
    const dialog = screen.getByRole('alertdialog', { name: 'Onay' });
    expect(dialog).toHaveAccessibleDescription('Açıklama');
    expect(dialog).toHaveClass('modal-danger');
    expect(screen.getByRole('button', { name: 'Vazgeç' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Evet' })).toHaveClass('button-danger');
  });

  it('gates the confirm button behind the acknowledgement', async () => {
    const { user, onConfirm } = renderConfirm({ acknowledgement: 'Anlıyorum.' });
    const confirm = screen.getByRole('button', { name: 'Evet' });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Anlıyorum.' }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('disables both buttons and ignores Escape while pending', async () => {
    const { user, onCancel } = renderConfirm({ pending: true });
    expect(screen.getByRole('button', { name: 'Vazgeç' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'İşleniyor…' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape when idle and shows an error inside', async () => {
    const { user, onCancel } = renderConfirm({ error: 'Olmadı.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Olmadı.');
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

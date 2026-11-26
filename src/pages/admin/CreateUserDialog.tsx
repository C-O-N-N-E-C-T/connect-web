/**
 * OSP-72: create a rescuer or coordinator account (POST /admin/users). An administrator account
 * cannot be created here: the role select offers only CREATABLE_ROLES, `createAdminApi` refuses
 * other roles at runtime, and the backend answers 403.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { useAdminApi } from '../../admin/AdminApiContext';
import { adminErrorMessage, DUPLICATE_EMAIL_MESSAGE } from '../../admin/adminErrors';
import { ROLE_LABELS } from '../../admin/labels';
import { Dialog } from '../../components/Dialog';
import { CREATABLE_ROLES, isCreatableRole, type CreateUserResponse } from '../../services/adminApi';

type Field = 'full_name' | 'email' | 'password' | 'role';
type Errors = Partial<Record<Field, string>>;

const FIELD_ORDER: Field[] = ['full_name', 'email', 'password', 'role'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (user: CreateUserResponse['user']) => void;
}) {
  const api = useAdminApi();
  const id = useId();
  const titleId = `${id}-title`;
  const [values, setValues] = useState<Record<Field, string>>({ full_name: '', email: '', password: '', role: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refs = {
    full_name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    role: useRef<HTMLSelectElement>(null),
  };

  function validate(): Errors {
    const next: Errors = {};
    const name = values.full_name.trim();
    if (name.length < 1 || name.length > 100) next.full_name = 'Ad soyad girin (en fazla 100 karakter).';
    const email = values.email.trim();
    if (!EMAIL_PATTERN.test(email) || email.length > 254) next.email = 'Geçerli bir e-posta adresi girin.';
    if (values.password.length < 10 || values.password.length > 72) {
      next.password = 'Şifre 10 ile 72 karakter arasında olmalı.';
    }
    if (!isCreatableRole(values.role)) next.role = 'Bir rol seçin.';
    return next;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const found = validate();
    setErrors(found);
    const firstInvalid = FIELD_ORDER.find((field) => found[field]);
    if (firstInvalid) {
      refs[firstInvalid].current?.focus();
      return;
    }
    if (!isCreatableRole(values.role)) return;
    setPending(true);
    const result = await api.createUser({
      email: values.email.trim(),
      password: values.password,
      full_name: values.full_name.trim(),
      role: values.role,
    });
    setPending(false);
    if (result.ok) {
      onCreated(result.data.user);
      return;
    }
    if (result.error.kind === 'HTTP_ERROR' && result.error.status === 409) {
      setErrors({ email: DUPLICATE_EMAIL_MESSAGE });
      refs.email.current?.focus();
      return;
    }
    setFormError(adminErrorMessage(result.error, 'createUser'));
  }

  function field(name: Field) {
    const error = errors[name];
    return {
      id: `${id}-${name}`,
      name,
      value: values[name],
      disabled: pending,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': [error ? `${id}-${name}-error` : '', name === 'role' ? `${id}-role-hint` : '']
        .filter(Boolean)
        .join(' ') || undefined,
      onChange: (event: { target: { value: string } }) =>
        setValues((current) => ({ ...current, [name]: event.target.value })),
    };
  }

  function errorText(name: Field) {
    return errors[name] ? (
      <p id={`${id}-${name}-error`} className="field-error">
        {errors[name]}
      </p>
    ) : null;
  }

  return (
    <Dialog
      role="dialog"
      titleId={titleId}
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <h2 id={titleId}>Yeni kullanıcı oluştur</h2>
      <form noValidate onSubmit={handleSubmit}>
        <label htmlFor={`${id}-full_name`}>Ad Soyad</label>
        <input ref={refs.full_name} type="text" autoComplete="off" maxLength={100} {...field('full_name')} />
        {errorText('full_name')}

        <label htmlFor={`${id}-email`}>E-posta</label>
        <input ref={refs.email} type="email" autoComplete="off" {...field('email')} />
        {errorText('email')}

        <label htmlFor={`${id}-password`}>Geçici şifre</label>
        <input ref={refs.password} type="password" autoComplete="new-password" {...field('password')} />
        {errorText('password')}

        <label htmlFor={`${id}-role`}>Rol</label>
        <select ref={refs.role} {...field('role')}>
          <option value="" disabled>
            Rol seçin
          </option>
          {CREATABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <p id={`${id}-role-hint`} className="field-hint">
          Yönetici hesabı bu panelden oluşturulamaz.
        </p>
        {errorText('role')}

        {formError && (
          <div role="alert" className="banner-error">
            {formError}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose} disabled={pending}>
            Vazgeç
          </button>
          <button type="submit" disabled={pending}>
            {pending ? 'Oluşturuluyor…' : 'Oluştur'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

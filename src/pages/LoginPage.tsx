import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  classifySignInError,
  loginWithPassword,
  LOGIN_ERROR_MESSAGES,
  type LoginErrorCode,
} from '../auth/login';
import { supabase } from '../lib/supabase';
import { clearSignOutReason, peekSignOutReason, subscribeSignOutReason } from '../auth/forcedSignOut';
import { safeSessionStorage } from '../lib/storage';
import { getOrCreateDeviceId } from '../services/deviceId';
import { registerBrowserSession } from '../services/authSessionClient';
import { SupplementaryDisclaimer } from '../components/SupplementaryDisclaimer';
import { SeismographBackground } from '../components/SeismographBackground';
import { BrandMark } from '../components/BrandMark';
import { EyeIcon, EyeOffIcon } from '../components/icons';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginForm(email: string, password: string): string | null {
  if (!EMAIL_PATTERN.test(email.trim())) return 'Geçerli bir e-posta adresi girin.';
  if (password.length === 0) return 'Şifre boş bırakılamaz.';
  return null;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // Reason of a forced sign-out (OSP-70): read once, cleared in the effect below. Reading in the
  // initializer and clearing in an effect keeps it visible under StrictMode's double invocation.
  const [bannerError, setBannerError] = useState<LoginErrorCode | null>(() =>
    peekSignOutReason(safeSessionStorage()),
  );
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    clearSignOutReason(safeSessionStorage());
    // A forced sign-out while this page is already mounted (e.g. the SDK dropped the session first).
    return subscribeSignOutReason((reason) => {
      setBannerError(reason);
      clearSignOutReason(safeSessionStorage());
    });
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBannerError(null);

    const validationError = validateLoginForm(email, password);
    setFormError(validationError);
    if (validationError) return;

    setSubmitting(true);
    const result = await loginWithPassword(email.trim(), password, {
      signIn: async (mail, pass) => {
        const { data, error } = await supabase.auth.signInWithPassword({ email: mail, password: pass });
        if (error) return { error: classifySignInError(error) };
        if (!data.session) return { error: 'UNKNOWN' };
        return { accessToken: data.session.access_token };
      },
      signOut: async () => {
        await supabase.auth.signOut({ scope: 'local' });
      },
      registerSession: (accessToken) =>
        registerBrowserSession(
          {
            deviceId: getOrCreateDeviceId(),
            deviceName: navigator.userAgent.slice(0, 100),
          },
          accessToken,
        ),
    });
    setSubmitting(false);

    if (result.ok) {
      navigate(result.route, { replace: true });
    } else {
      setBannerError(result.code);
    }
  }

  return (
    <div className="login-screen">
      <SeismographBackground />

      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <BrandMark />
          <p className="login-system">Afet Koordinasyon Bilgi Sistemi</p>
          <h1 id="login-title">CONNECT</h1>
        </div>

        <SupplementaryDisclaimer />

        {bannerError && (
          <div role="alert" className="banner-error">
            {LOGIN_ERROR_MESSAGES[bannerError]}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="login-email">E-posta</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            aria-invalid={formError !== null && formError.startsWith('Geçerli')}
            aria-describedby={formError ? 'form-error' : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label htmlFor="login-password">Şifre</label>
          <div className="password-field">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              aria-invalid={formError !== null && formError.startsWith('Şifre')}
              aria-describedby={formError ? 'form-error' : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          {formError && (
            <p id="form-error" role="alert" className="field-error">
              {formError}
            </p>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>

        <p className="login-footer">
          Bu sistem yalnızca yetkili kullanıcılar içindir. Tüm erişimler kayıt altına alınır.
        </p>
      </section>
    </div>
  );
}

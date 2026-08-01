/**
 * Connexion + parcours MFA (E7). Le tenant est identifié par son SLUG, résolu et
 * vérifié par le SERVEUR — le client n'impose jamais de tenant_id. Les échecs restent
 * génériques (anti-énumération), les verrous et limitations affichent le délai.
 */
import { h } from '../core/dom.ts';
import { t, getLocale } from '../core/i18n.ts';
import type { Session } from '../core/session.ts';
import { button, field, guardedSubmit, icon } from '../ui/kit.ts';

export function loginPage(session: Session, onSuccess: () => void, onLocale: (l: 'fr' | 'en') => void): HTMLElement {
  let mfaMode = false;
  let lastTenant = '';
  let lastEmail = '';
  let lastPassword = '';

  const tenant = field('login.tenant', { hintKey: 'login.tenantHint', required: true, autocomplete: 'organization' });
  const email = field('login.email', { type: 'email', required: true, autocomplete: 'username' });
  const password = field('login.password', { type: 'password', required: true, autocomplete: 'current-password' });
  const mfa = field('login.mfaCode', { autocomplete: 'one-time-code', placeholder: '000000' });
  const globalError = h('p', { class: 'error', role: 'alert' });
  globalError.style.display = 'none';

  const submitBtn = button(t('login.submit'), null, { variant: 'primary', type: 'submit' }) as HTMLButtonElement;
  submitBtn.style.width = '100%';

  const langBtn = button(`${getLocale() === 'fr' ? t('app.lang.en') : t('app.lang.fr')}`, () => {
    onLocale(getLocale() === 'fr' ? 'en' : 'fr');
  }, { variant: 'ghost', small: true });

  const form = h('form', { novalidate: 'novalidate' },
    tenant.wrap, email.wrap, password.wrap, mfa.wrap, globalError, submitBtn,
  ) as HTMLFormElement;
  mfa.wrap.style.display = 'none';

  const title = h('h1', {}, t('login.title'));
  const subtitle = h('p', { class: 'section-note' }, t('login.subtitle'));

  function showError(msg: string): void {
    globalError.textContent = msg;
    globalError.style.display = '';
  }
  function clearError(): void {
    globalError.style.display = 'none';
    globalError.textContent = '';
  }

  function enterMfaMode(): void {
    mfaMode = true;
    title.textContent = t('login.mfaTitle');
    subtitle.textContent = t('login.mfaSubtitle');
    tenant.wrap.style.display = 'none';
    email.wrap.style.display = 'none';
    password.wrap.style.display = 'none';
    mfa.wrap.style.display = '';
    submitBtn.textContent = t('login.mfaSubmit');
    mfa.input.focus();
  }

  guardedSubmit(form, submitBtn, async () => {
    clearError();
    if (!mfaMode) {
      lastTenant = tenant.input.value.trim();
      lastEmail = email.input.value.trim();
      lastPassword = password.input.value;
      if (!lastTenant || !lastEmail || !lastPassword) {
        showError(t('form.required'));
        return;
      }
    }
    const code = mfaMode ? mfa.input.value.trim() : undefined;
    const res = await session.login(lastTenant, lastEmail, lastPassword, code);
    switch (res.kind) {
      case 'ok':
        lastPassword = ''; // purge mémoire locale du secret
        onSuccess();
        return;
      case 'mfa_required':
        if (mfaMode) showError(t('login.failed'));
        else enterMfaMode();
        return;
      case 'invalid':
        showError(mfaMode ? t('login.failed') : t('login.failed'));
        return;
      case 'locked':
        showError(t('login.locked'));
        return;
      case 'rate_limited':
        showError(t('login.rateLimited', { seconds: res.retryAfterSeconds ?? 60 }));
        return;
      case 'offline':
        showError(t('state.offlineBody'));
        return;
      default:
        showError(t('login.serverError'));
    }
  });

  return h('div', { class: 'login-wrap' },
    h('div', { class: 'login-card glass glass-strong' },
      h('div', { class: 'login-brand' },
        h('div', { class: 'brand-logo', 'aria-hidden': 'true' }, 'K'),
        h('div', {},
          h('div', { class: 'brand-name' }, t('app.name')),
          h('div', { class: 'brand-tenant' }, t('app.tagline')),
        ),
        h('span', { class: 'spacer' }),
        langBtn,
      ),
      title, subtitle, form,
      h('p', { class: 'section-note' }, icon('shield'), ' ', t('app.theme.tenantDefault')),
    ),
  );
}

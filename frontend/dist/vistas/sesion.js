import { passwordRequirements } from '../modelos/credenciales.js';
import { bindPasswords, byId, field, formValues, maskPasswords, notice } from './componentes.js';

function bindSubmit(form, buttons, send) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    for (const button of buttons) button.disabled = true;
    try {
      await send(formValues(form));
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  });
}

export function createSessionView({ onAuth, onRecover, onReset, onBack, onRetry }) {
  const auth = byId('auth');
  const forgotForm = byId('forgot-form');
  const resetForm = byId('reset-form');
  const retry = byId('retry-session');
  const submit = byId('auth-submit');
  const toggle = byId('register-toggle');
  const forgotToggle = byId('forgot-toggle');
  const password = field(auth, 'password');
  const requirements = byId('registration-password-rules');
  const requirementStatus = byId('registration-password-status');
  const rules = [...requirements.querySelectorAll('[data-password-rule]')];
  const forms = { login: auth, forgot: forgotForm, reset: resetForm };
  let registering = false;
  let submitting = false;

  function updatePasswordRequirements() {
    let pending = false;
    if (registering) {
      const checks = passwordRequirements(password.value);
      let met = 0;
      for (const rule of rules) {
        const valid = checks[rule.dataset.passwordRule];
        if (valid) met++;
        rule.classList.toggle('is-met', valid);
        rule.querySelector('.password-requirement-icon').textContent = valid ? '✓' : '×';
        rule.querySelector('[data-rule-status]').textContent = valid ? 'Cumplido' : 'Pendiente';
      }
      pending = met !== rules.length;
      const summary = `${met} de ${rules.length} requisitos cumplidos.`;
      if (requirementStatus.textContent !== summary) requirementStatus.textContent = summary;
      password.setAttribute('aria-invalid', String(Boolean(password.value) && pending));
    }
    submit.toggleAttribute('data-password-incomplete', pending);
    submit.disabled = submitting || pending;
    return !pending;
  }

  function setRegistration(active) {
    maskPasswords(auth);
    registering = active;
    byId('registration').hidden = !active;
    requirements.hidden = !active;
    field(auth, 'email').disabled = !active;
    password.autocomplete = active ? 'new-password' : 'current-password';
    if (active) {
      password.setAttribute('aria-describedby', 'registration-password-title registration-password-status');
    } else {
      password.removeAttribute('aria-describedby');
      password.removeAttribute('aria-invalid');
    }
    byId('auth-title').textContent = active ? 'Crear cuenta' : 'Iniciar sesión';
    submit.textContent = active ? 'Crear cuenta' : 'Entrar';
    toggle.textContent = active ? 'Volver al inicio de sesión' : 'Crear una cuenta';
    forgotToggle.hidden = active;
    updatePasswordRequirements();
    notice();
  }

  function select(name, focus = true) {
    const form = forms[name];
    for (const candidate of Object.values(forms)) {
      candidate.hidden = candidate !== form;
      if (candidate.hidden) maskPasswords(candidate);
    }
    if (focus) form.querySelector('input').focus();
    notice();
  }

  bindPasswords(auth);
  bindPasswords(resetForm);
  password.addEventListener('input', updatePasswordRequirements);
  password.addEventListener('change', updatePasswordRequirements);
  auth.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !updatePasswordRequirements()) return;
    submitting = toggle.disabled = forgotToggle.disabled = true;
    updatePasswordRequirements();
    try {
      await onAuth(formValues(auth), registering);
    } finally {
      password.value = '';
      submitting = toggle.disabled = forgotToggle.disabled = false;
      updatePasswordRequirements();
    }
  });
  bindSubmit(forgotForm, forgotForm.querySelectorAll('button'), onRecover);
  bindSubmit(resetForm, resetForm.querySelectorAll('button'), onReset);
  toggle.addEventListener('click', () => setRegistration(!registering));
  forgotToggle.addEventListener('click', () => {
    password.value = '';
    select('forgot');
  });
  for (const button of document.querySelectorAll('[data-auth-back]')) {
    button.addEventListener('click', () => {
      onBack();
      resetForm.reset();
      select('login');
    });
  }
  retry.addEventListener('click', onRetry);

  return {
    select,
    setRegistration,
    resetPasswordForm() { resetForm.reset(); },
    showSession(active) {
      byId('session-check').hidden = true;
      byId('login').hidden = active;
    },
    showChecking(failed = false) {
      retry.hidden = !failed;
      byId('session-status').textContent = failed
        ? 'No se pudo comprobar tu sesión. Inténtalo de nuevo.'
        : 'Comprobando tu sesión…';
    }
  };
}

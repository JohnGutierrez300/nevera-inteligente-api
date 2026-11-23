import { passwordLengthLimit, passwordRequirements } from '../modelos/credenciales.js';
import { bindPasswords, byId, field, formValues, maskPasswords, notice } from './componentes.js';

function bindSubmit(form, buttons, send, { validate, blocked, done } = {}) {
  const submit = form.querySelector('button[type="submit"], button:not([type])');
  let submitting = false;

  function update() {
    const valid = validate?.() ?? true;
    const locked = blocked?.() ?? false;
    submit.disabled = submitting || !valid || locked;
    submit.toggleAttribute('data-password-incomplete', !valid);
    submit.toggleAttribute('data-login-locked', locked);
    return valid && !locked;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !update()) return;
    submitting = true;
    for (const button of buttons) button.disabled = true;
    try {
      await send(formValues(form));
    } finally {
      done?.();
      submitting = false;
      for (const button of buttons) button.disabled = false;
      update();
    }
  });
  if (validate) form.addEventListener('reset', () => queueMicrotask(update));
  update();
  return update;
}

function createPasswordChecklist(container, password, confirmation) {
  container.append(byId('password-requirements-template').content.cloneNode(true));
  const title = container.querySelector('[data-requirements-title]');
  const status = container.querySelector('[role="status"]');
  const lengthLabel = container.querySelector('[data-length-label]');
  const minimumLabel = lengthLabel.textContent;
  title.id = container.id + '-title';
  status.id = container.id + '-status';
  container.querySelector('ul').setAttribute('aria-labelledby', title.id);
  const confirmationRule = container.querySelector('[data-password-rule="confirmation"]');
  if (confirmation) {
    confirmationRule.id = container.id + '-confirmation';
    confirmation.setAttribute('aria-describedby', confirmationRule.id);
  } else {
    confirmationRule.remove();
  }
  const rules = [...container.querySelectorAll('[data-password-rule]')].map(node => ({
    node,
    key: node.dataset.passwordRule,
    icon: node.querySelector('.password-requirement-icon'),
    status: node.querySelector('[data-rule-status]')
  }));

  return {
    show(active) {
      container.hidden = !active;
      if (active) {
        password.setAttribute('aria-describedby', title.id + ' ' + status.id);
      } else {
        password.removeAttribute('aria-describedby');
        password.removeAttribute('aria-invalid');
      }
    },
    update() {
      const value = password.value;
      const checks = passwordRequirements(value);
      const validPassword = Object.values(checks).every(Boolean);
      if (confirmation) {
        const repeated = confirmation.value;
        checks.confirmation = Boolean(value) && value === repeated;
        confirmation.setAttribute('aria-invalid', String(Boolean(repeated) && !checks.confirmation));
      }
      const label = value.length > passwordLengthLimit ? 'La contraseña es demasiado larga' : minimumLabel;
      if (lengthLabel.textContent !== label) lengthLabel.textContent = label;
      let met = 0;
      for (const rule of rules) {
        const valid = checks[rule.key];
        if (valid) met++;
        rule.node.classList.toggle('is-met', valid);
        rule.icon.textContent = valid ? '✓' : '×';
        rule.status.textContent = valid ? 'Cumplido' : 'Pendiente';
      }
      const complete = met === rules.length;
      const summary = `${met} de ${rules.length} requisitos cumplidos.`;
      if (status.textContent !== summary) status.textContent = summary;
      password.setAttribute('aria-invalid', String(Boolean(value) && !validPassword));
      return complete;
    }
  };
}

export function createSessionView({ onAuth, onRecover, onReset, onBack, onRetry }) {
  const login = byId('login');
  const auth = byId('auth');
  const forgotForm = byId('forgot-form');
  const resetForm = byId('reset-form');
  const retry = byId('retry-session');
  const submit = byId('auth-submit');
  const toggle = byId('register-toggle');
  const forgotToggle = byId('forgot-toggle');
  const username = field(auth, 'nombre');
  const lockNotice = byId('login-lock');
  const lockTime = byId('login-lock-time');
  const password = field(auth, 'password');
  const resetPassword = field(resetForm, 'password');
  const resetConfirmation = field(resetForm, 'confirmation');
  const registerChecklist = createPasswordChecklist(byId('registration-password-rules'), password);
  const resetChecklist = createPasswordChecklist(byId('reset-password-rules'), resetPassword, resetConfirmation);
  resetChecklist.show(true);
  const forms = { login: auth, forgot: forgotForm, reset: resetForm };
  const loginLocks = new Map();
  let lockTimer;
  let registering = false;

  function updateLoginLock() {
    clearTimeout(lockTimer);
    const name = username.value;
    const seconds = Math.ceil(((loginLocks.get(name) ?? 0) - performance.now()) / 1000);
    if (seconds <= 0) loginLocks.delete(name);
    const locked = seconds > 0 && !registering && !auth.hidden && !login.hidden;
    lockNotice.hidden = !locked;
    if (locked) {
      lockTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      lockTimer = setTimeout(updateAuthSubmit, 1000);
    }
    return locked;
  }

  function setRegistration(active) {
    maskPasswords(auth);
    registering = active;
    byId('registration').hidden = !active;
    registerChecklist.show(active);
    field(auth, 'email').disabled = !active;
    password.autocomplete = active ? 'new-password' : 'current-password';
    byId('auth-title').textContent = active ? 'Crear cuenta' : 'Iniciar sesión';
    submit.textContent = active ? 'Crear cuenta' : 'Entrar';
    toggle.textContent = active ? 'Volver al inicio de sesión' : 'Crear una cuenta';
    forgotToggle.hidden = active;
    updateAuthSubmit();
    notice();
  }

  function select(name, focus = true) {
    const form = forms[name];
    for (const candidate of Object.values(forms)) {
      candidate.hidden = candidate !== form;
      if (candidate.hidden) maskPasswords(candidate);
    }
    updateAuthSubmit();
    if (focus) form.querySelector('input').focus();
    notice();
  }

  bindPasswords(auth);
  bindPasswords(resetForm);
  const updateAuthSubmit = bindSubmit(auth, [submit, toggle, forgotToggle], fields => onAuth(fields, registering), {
    validate: () => !registering || registerChecklist.update(),
    blocked: updateLoginLock,
    done: () => { password.value = ''; }
  });
  bindSubmit(forgotForm, forgotForm.querySelectorAll('button'), onRecover);
  const updateResetSubmit = bindSubmit(resetForm, resetForm.querySelectorAll('button'), onReset, {
    validate: resetChecklist.update
  });
  for (const event of ['input', 'change']) {
    username.addEventListener(event, updateAuthSubmit);
    password.addEventListener(event, updateAuthSubmit);
    resetPassword.addEventListener(event, updateResetSubmit);
    resetConfirmation.addEventListener(event, updateResetSubmit);
  }
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
    blockLogin(name, seconds) {
      const now = performance.now();
      for (const [key, deadline] of loginLocks) {
        if (deadline <= now) loginLocks.delete(key);
      }
      loginLocks.set(name, now + seconds * 1000);
      updateAuthSubmit();
    },
    resetPasswordForm() {
      resetForm.reset();
      loginLocks.clear();
      updateAuthSubmit();
    },
    showSession(active) {
      byId('session-check').hidden = true;
      login.hidden = active;
      updateAuthSubmit();
    },
    showChecking(failed = false) {
      retry.hidden = !failed;
      byId('session-status').textContent = failed
        ? 'No se pudo comprobar tu sesión. Inténtalo de nuevo.'
        : 'Comprobando tu sesión…';
    }
  };
}

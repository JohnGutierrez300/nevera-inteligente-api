import { createPasswordChecklist } from './requisitos-clave.js';
import { bindCodeInput, bindPasswords, byId, field, formValues, maskPasswords, notice } from './componentes.js';

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
  const lastAttemptNotice = byId('login-last-attempt');
  const recoveryLockNotice = byId('login-recovery-lock');
  const forgotEmail = field(forgotForm, 'email');
  const resetEmail = field(resetForm, 'email');
  const resetCode = field(resetForm, 'codigo');
  const requestNew = byId('reset-request-new');
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
    const lock = loginLocks.get(name);
    const seconds = Math.ceil(((lock?.deadline ?? 0) - performance.now()) / 1000);
    const visible = !registering && !auth.hidden && !login.hidden;
    const requiresRecovery = visible && lock?.requiresRecovery === true;
    const waiting = visible && seconds > 0;
    lastAttemptNotice.hidden = !visible || waiting || requiresRecovery || !lock?.lastAttempt;
    recoveryLockNotice.hidden = !requiresRecovery;
    lockNotice.hidden = !waiting;
    if (waiting) {
      lockTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      lockTimer = setTimeout(updateAuthSubmit, 1000);
    }
    return waiting || (requiresRecovery && !password.value);
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
    if (focus) form.querySelector('input:enabled').focus();
    notice();
  }

  function showPasswordReset(email) {
    const useCode = email !== undefined;
    resetForm.reset();
    byId('reset-code-fields').hidden = !useCode;
    resetEmail.disabled = !useCode;
    resetCode.disabled = !useCode;
    requestNew.hidden = !useCode;
    if (useCode) resetEmail.value = email;
    select('reset', !email);
    if (email) resetCode.focus();
  }

  bindPasswords(auth);
  bindPasswords(resetForm);
  bindCodeInput(resetCode);
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
  byId('reset-use-code').addEventListener('click', () => {
    onBack();
    showPasswordReset(forgotEmail.value.trim());
  });
  requestNew.addEventListener('click', () => {
    onBack();
    forgotEmail.value = resetEmail.value;
    resetForm.reset();
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
    showPasswordReset,
    blockLogin(name, seconds, lastAttempt = false) {
      const now = performance.now();
      for (const [key, lock] of loginLocks) {
        if (lock.deadline <= now && !lock.lastAttempt) loginLocks.delete(key);
      }
      loginLocks.set(name, {
        deadline: now + seconds * 1000, lastAttempt: lastAttempt || loginLocks.get(name)?.lastAttempt
      });
      updateAuthSubmit();
    },
    requireRecovery(name) {
      loginLocks.set(name, { requiresRecovery: true });
      updateAuthSubmit();
    },
    clearLoginLock(name) {
      loginLocks.delete(name);
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

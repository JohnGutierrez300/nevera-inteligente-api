import { bindPasswords, byId, field, formValues, maskPasswords, notice } from './componentes.js';

function bindSubmit(form, buttons, send, done) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    for (const button of buttons) button.disabled = true;
    try {
      await send(formValues(form));
    } finally {
      if (done) done();
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
  const forms = { login: auth, forgot: forgotForm, reset: resetForm };
  let registering = false;

  function setRegistration(active) {
    maskPasswords(auth);
    registering = active;
    byId('registration').hidden = !active;
    field(auth, 'email').disabled = !active;
    password.autocomplete = active ? 'new-password' : 'current-password';
    password.minLength = active ? 12 : 0;
    byId('auth-title').textContent = active ? 'Crear cuenta' : 'Iniciar sesión';
    submit.textContent = active ? 'Crear cuenta' : 'Entrar';
    toggle.textContent = active ? 'Volver al inicio de sesión' : 'Crear una cuenta';
    forgotToggle.hidden = active;
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
  bindSubmit(auth, [submit, toggle, forgotToggle], fields => onAuth(fields, registering), () => { password.value = ''; });
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

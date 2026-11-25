import { action, bindPasswords, byId, detailList, errorMessage, formValues, group, maskPasswords } from './componentes.js';

export function showLotError(target, error, onConflict, onReload = onConflict) {
  target.hidden = !error;
  target.textContent = error ? errorMessage(error) : '';
  const conflictId = error?.status === 409 && error.data?.inventario_id;
  const stale = error?.data?.conflicto === 'VERSION';
  const showLot = stale ? onReload : onConflict;
  if (conflictId && showLot) {
    target.append(' ', action(stale ? 'Recargar lote' : 'Ver lote existente', () => {
      target.closest('dialog').close();
      void showLot(conflictId);
    }, 'text-button button-view'));
  }
}

export function createDialogs() {
  const confirmDialog = byId('delete-dialog');
  const confirmButton = confirmDialog.querySelector('[value="confirm"]');
  const nameField = byId('delete-name-field');
  const nameInput = byId('delete-name');
  const proof = byId('delete-proof');
  const method = byId('delete-method');
  const currentPassword = byId('delete-password');
  const code = byId('delete-code');
  const accept = byId('delete-accept');
  const sendCode = byId('delete-send-code');
  const codeStatus = byId('delete-code-status');
  const update = byId('update-dialog');
  const details = byId('detail-dialog');
  const editor = byId('editor-dialog');
  const form = byId('editor-form');
  const submit = byId('editor-save');
  const cancel = byId('editor-cancel');
  const formError = byId('editor-error');
  let pendingConfirmation = null;
  let requiredName = null;
  let requestCode = null;
  let confirmationGeneration = 0;
  let feedbackTimer;

  function closeFeedback() {
    clearTimeout(feedbackTimer);
    if (update.open) update.close();
  }

  function showEditorError(message = '') {
    formError.hidden = !message;
    formError.textContent = message;
  }

  function confirmationMatches() {
    return requiredName === null || (nameInput.value === requiredName && accept.checked &&
      (method.value === 'password' ? Boolean(currentPassword.value) : /^[0-9]{6}$/.test(code.value)));
  }

  function updateConfirmButton() {
    confirmButton.disabled = !confirmationMatches();
  }

  nameInput.addEventListener('input', updateConfirmButton);
  for (const field of [currentPassword, code, accept]) field.addEventListener('input', updateConfirmButton);
  function showMethod() {
    const byCode = method.value === 'code';
    byId('delete-password-field').hidden = byCode;
    byId('delete-code-field').hidden = !byCode;
    updateConfirmButton();
  }
  method.addEventListener('change', showMethod);
  sendCode.addEventListener('click', async () => {
    if (!requestCode) return;
    const generation = confirmationGeneration;
    sendCode.disabled = true;
    codeStatus.textContent = 'Enviando código…';
    try {
      const response = await requestCode();
      if (generation === confirmationGeneration && confirmDialog.open) codeStatus.textContent = response.message;
    } catch (error) {
      if (generation === confirmationGeneration && confirmDialog.open) codeStatus.textContent = errorMessage(error);
    } finally {
      if (generation === confirmationGeneration) sendCode.disabled = false;
    }
  });
  confirmDialog.addEventListener('close', () => {
    if (confirmDialog.open) return;
    currentPassword.value = code.value = '';
    accept.checked = false;
    requestCode = null;
  });
  confirmDialog.addEventListener('cancel', () => { pendingConfirmation = null; });
  confirmDialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const confirming = event.submitter === confirmButton;
    if (confirming && !confirmationMatches()) return;
    const confirm = pendingConfirmation;
    const verification = requiredName === null ? undefined : {
      nombre: nameInput.value, acepta_borrado: accept.checked,
      ...(method.value === 'password' ? { password_actual: currentPassword.value } : { codigo: code.value })
    };
    pendingConfirmation = null;
    confirmDialog.close();
    if (confirming && confirm) void confirm(verification);
  });
  details.addEventListener('cancel', event => {
    if (details.querySelector('.detail-actions button:disabled')) event.preventDefault();
  });
  bindPasswords(form);
  cancel.addEventListener('click', () => editor.close());
  editor.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
  editor.addEventListener('close', () => {
    if (editor.open) return;
    maskPasswords(form);
    for (const input of form.querySelectorAll('.password-field input')) input.value = '';
    form.onsubmit = null;
  });

  return {
    confirm(title, message, label, onConfirm, { accountName = null, onRequestCode = null } = {}) {
      if (confirmDialog.open) return;
      byId('delete-title').textContent = title;
      byId('delete-description').replaceChildren(message);
      confirmButton.textContent = label;
      requiredName = accountName?.replace(/\r\n?|\n/g, ' ') ?? null;
      nameField.hidden = requiredName === null;
      byId('delete-expected-name').textContent = requiredName ?? '';
      nameInput.value = '';
      confirmationGeneration++;
      proof.hidden = requiredName === null;
      method.value = 'password';
      currentPassword.value = code.value = codeStatus.textContent = '';
      accept.checked = false;
      sendCode.disabled = false;
      requestCode = onRequestCode;
      showMethod();
      pendingConfirmation = onConfirm;
      confirmDialog.showModal();
    },
    showUpdated() {
      clearTimeout(feedbackTimer);
      update.showModal();
      feedbackTimer = setTimeout(closeFeedback, 3000);
    },
    get detailsOpen() { return details.open; },
    showDetails({ title, entries, buttons = [] }) {
      if (details.open) return;
      const content = byId('detail-content');
      content.replaceChildren(detailList(entries));
      if (buttons.length) content.append(group('detail-actions', ...buttons));
      showLotError(byId('detail-error'));
      byId('detail-title').textContent = title;
      details.showModal();
    },
    closeDetails() { if (details.open) details.close(); },
    setDetailBusy(busy) {
      for (const button of details.querySelectorAll('button')) button.disabled = busy;
    },
    showDetailError(error, onConflict) { showLotError(byId('detail-error'), error, onConflict); },
    get editorOpen() { return editor.open; },
    openEditor({ title, fields }, onSubmit) {
      if (editor.open) return;
      byId('editor-title').textContent = title;
      byId('editor-fields').replaceChildren(...fields);
      showEditorError();
      form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = cancel.disabled = true;
        showEditorError();
        try {
          await onSubmit(formValues(form));
        } catch (error) {
          if (editor.open) showEditorError(errorMessage(error));
        } finally {
          submit.disabled = cancel.disabled = false;
        }
      };
      editor.showModal();
    },
    closeEditor() { if (editor.open) editor.close(); },
    closeAll() {
      for (const dialog of [confirmDialog, details, editor]) if (dialog.open) dialog.close();
      pendingConfirmation = null;
      closeFeedback();
    }
  };
}

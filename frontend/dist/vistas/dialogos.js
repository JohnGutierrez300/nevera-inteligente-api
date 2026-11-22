import { action, bindPasswords, byId, detailList, errorMessage, formValues, group, maskPasswords } from './componentes.js';

export function showLotError(target, error, onConflict) {
  target.hidden = !error;
  target.textContent = error ? errorMessage(error) : '';
  const conflictId = error?.status === 409 && error.data?.inventario_id;
  if (conflictId && onConflict) {
    target.append(' ', action('Ver lote existente', () => {
      target.closest('dialog').close();
      void onConflict(conflictId);
    }, 'text-button button-view'));
  }
}

export function createDialogs() {
  const confirmDialog = byId('delete-dialog');
  const update = byId('update-dialog');
  const details = byId('detail-dialog');
  const editor = byId('editor-dialog');
  const form = byId('editor-form');
  const submit = byId('editor-save');
  const cancel = byId('editor-cancel');
  const formError = byId('editor-error');
  let pendingConfirmation = null;
  let feedbackTimer;

  function closeFeedback() {
    clearTimeout(feedbackTimer);
    if (update.open) update.close();
  }

  function showEditorError(message = '') {
    formError.hidden = !message;
    formError.textContent = message;
  }

  confirmDialog.addEventListener('cancel', () => { pendingConfirmation = null; });
  confirmDialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const confirm = pendingConfirmation;
    pendingConfirmation = null;
    confirmDialog.close();
    if (event.submitter?.value === 'confirm' && confirm) void confirm();
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
    confirm(title, message, label, onConfirm) {
      if (confirmDialog.open) return;
      byId('delete-title').textContent = title;
      byId('delete-description').replaceChildren(message);
      confirmDialog.querySelector('[value="confirm"]').textContent = label;
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

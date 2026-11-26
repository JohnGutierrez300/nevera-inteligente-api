import { passwordLengthLimit, passwordRequirements, passwordStrength } from '../modelos/credenciales.js';
import { byId } from './componentes.js';

export function createPasswordChecklist(container, password, confirmation) {
  container.append(byId('password-requirements-template').content.cloneNode(true));
  const title = container.querySelector('[data-requirements-title]');
  const status = container.querySelector('[role="status"]');
  const strengthLabel = container.querySelector('[data-strength-label]');
  const strengthBar = container.querySelector('[data-password-strength]');
  const lengthLabel = container.querySelector('[data-length-label]');
  const minimumLabel = lengthLabel.textContent;
  title.id = container.id + '-title';
  status.id = container.id + '-status';
  strengthLabel.id = container.id + '-strength';
  strengthBar.setAttribute('aria-labelledby', strengthLabel.id);
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
      const strength = passwordStrength(value, checks);
      strengthBar.value = strength.score;
      strengthBar.dataset.level = strength.level;
      const security = `Seguridad: ${strength.label}`;
      if (strengthLabel.textContent !== security) strengthLabel.textContent = security;
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
      const summary = `${met} de ${rules.length} requisitos cumplidos. ${security}.`;
      if (status.textContent !== summary) status.textContent = summary;
      password.setAttribute('aria-invalid', String(Boolean(value) && !validPassword));
      return complete;
    }
  };
}

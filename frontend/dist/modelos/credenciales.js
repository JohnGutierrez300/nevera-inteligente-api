// Estos criterios corresponden a CLAVE_SEGURA en la API.
export const passwordLengthLimit = 128;

export function passwordRequirements(password) {
  return {
    length: password.length >= 8 && password.length <= passwordLengthLimit,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    symbol: /[!@#$%^&*-]/.test(password),
    allowed: /^[A-Za-z0-9!@#$%^&*-]+$/.test(password)
  };
}

export function passwordStrength(password, checks) {
  if (!password) return { score: 0, level: 'empty', label: 'Sin evaluar' };
  const met = Object.values(checks).filter(Boolean).length;
  const distinct = new Set(password).size;
  const bonus = Number(password.length >= 12 && distinct >= 8) +
    Number(password.length >= 16 && distinct >= 12);
  const score = met === 6 ? met + bonus : Math.min(met, 5);
  if (score === 8) return { score, level: 'strong', label: 'Fuerte' };
  if (score >= 4 && checks.allowed && checks.length) return { score, level: 'medium', label: 'Media' };
  return { score, level: 'weak', label: 'Débil' };
}

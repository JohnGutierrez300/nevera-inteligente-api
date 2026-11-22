// Estos criterios corresponden a CLAVE_SEGURA en la API.
export const passwordLengthLimit = 1024;

export function passwordRequirements(password) {
  return {
    length: password.length <= passwordLengthLimit && /^.{12,}$/.test(password),
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    symbol: /[\W_]/.test(password)
  };
}

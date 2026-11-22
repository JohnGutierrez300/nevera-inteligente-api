// Estos criterios corresponden a CLAVE_SEGURA en la API.
export function passwordRequirements(password) {
  return {
    length: /^.{12,1024}$/.test(password),
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    symbol: /[\W_]/.test(password)
  };
}

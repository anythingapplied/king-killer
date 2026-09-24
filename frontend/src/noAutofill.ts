import type { InputHTMLAttributes } from 'react';

/**
 * Spread onto every text input so password managers leave it alone.
 *
 * None of this app's fields is a credential, but a lone text box for a name
 * reads as a username field, and managers offered to save or fill a password
 * for it. `autoComplete="off"` alone doesn't stop them - the major managers
 * deliberately ignore it - so each one's own opt-out is set as well.
 */
export const NO_AUTOFILL = {
    autoComplete: 'off',
    'data-1p-ignore': 'true', // 1Password
    'data-lpignore': 'true', // LastPass
    'data-bwignore': 'true', // Bitwarden
    'data-form-type': 'other', // Dashlane
} as InputHTMLAttributes<HTMLInputElement>;

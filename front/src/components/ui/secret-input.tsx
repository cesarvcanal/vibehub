import * as React from "react";
import { Input } from "@/components/ui/input";

/**
 * A field for a SECRET THAT IS NOT A LOGIN — a GitHub token, an API key, an MCP secret.
 *
 * `autocomplete="off"` is NOT enough: browsers ignore it on password-shaped fields and fill the
 * credentials they saved for this site. In production that turned the "add a GitHub account" form
 * into the owner's saved login — the account name arrived as `cesar` and the token box arrived full
 * of their PANEL PASSWORD — so a second person could not add their own account, and pressing the
 * button would have sent a password to GitHub as if it were a token.
 *
 * `new-password` is the value browsers DO honour for "this is not the login you have saved", the
 * `data-*` opt-outs cover the managers that ignore it (1Password, LastPass, Bitwarden), and the
 * `name` is deliberately not username/password-shaped, because the heuristics read it.
 *
 * Use it for the SECRET and for any plain field sitting next to one — a text input right above a
 * password input is exactly what a password manager fills as the username.
 */
export const SecretInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input"> & { name: string }
>(({ type = "password", ...props }, ref) => (
  <Input
    ref={ref}
    type={type}
    autoComplete="new-password"
    autoCorrect="off"
    autoCapitalize="off"
    spellCheck={false}
    data-1p-ignore=""
    data-lpignore="true"
    data-bwignore="true"
    data-form-type="other"
    {...props}
  />
));
SecretInput.displayName = "SecretInput";

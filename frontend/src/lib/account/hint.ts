/**
 * Whether this browser last held a Tredio account, so the first paint can show the signed-in or
 * the signed-out shell while the session restores (a second of NEAR reads). The hint lives in
 * localStorage and on <html data-account>, set before first paint by ACCOUNT_HINT_SCRIPT; elements
 * marked `when-account` or `when-no-account` (globals.css) show for one case only. It is a layout
 * hint, never an authority: the restored session decides what the app does.
 */

const KEY = "tredio.account-hint";

export const ACCOUNT_HINT_SCRIPT = `try{if(localStorage.getItem("${KEY}"))document.documentElement.dataset.account=""}catch(e){}`;

/** Records whether an account is on this device (a session, live or ended, or a wallet). */
export function setAccountHint(present: boolean) {
  if (present) document.documentElement.dataset.account = "";
  else delete document.documentElement.dataset.account;
  try {
    if (present) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the next visit paints the neutral shell.
  }
}

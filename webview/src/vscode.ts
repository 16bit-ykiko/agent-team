// The panel open in VS Code's own browser: there a file opens in the editor,
// and VS Code's menus take some keys before the page can act on them.
export function inVSCode(ua = navigator.userAgent): boolean {
  return /\bCode(?: - Insiders)?\/\d/.test(ua) && /\bElectron\//.test(ua);
}

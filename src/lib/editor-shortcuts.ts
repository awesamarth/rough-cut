/** Keep native typing and modal controls; range sliders/buttons keep editor shortcuts. */
export function blocksEditorShortcuts(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented || document.querySelector('dialog[open], [aria-modal="true"]')) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('textarea, [role="textbox"]')) return true;
  return target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset", "file", "color"].includes(target.type);
}

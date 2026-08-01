/**
 * Micro-couche DOM (E7) — création d'éléments SANS innerHTML de données.
 * RÈGLE anti-XSS : tout texte passe par textContent ; aucun rendu HTML non contrôlé.
 * (Un lint maison en CI interdit innerHTML/outerHTML/insertAdjacentHTML dans src/.)
 */

export type Child = Node | string | null | undefined | false;

export interface Attrs {
  /** Attributs HTML simples (class, id, type, value, placeholder, aria-*, data-*…). */
  [name: string]: string | number | boolean | EventListener | undefined;
}

const EVENT_PREFIX = 'on';

/** h('button', { class: 'btn', onclick: fn }, t('app.save')) */
export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith(EVENT_PREFIX) && typeof value === 'function') {
      el.addEventListener(name.slice(EVENT_PREFIX.length), value as EventListener);
    } else if (value === true) {
      el.setAttribute(name, '');
    } else if (typeof value === 'string' || typeof value === 'number') {
      el.setAttribute(name, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string') {
      parent.appendChild(document.createTextNode(child)); // texte = TOUJOURS un nœud texte
    } else {
      parent.appendChild(child);
    }
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: HTMLElement, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Fragment utilitaire — évite les wrappers inutiles. */
export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    f.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return f;
}

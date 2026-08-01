/**
 * Faux DOM MINIMAL pour tester les composants en node:test sans dépendance.
 * Il n'implémente QUE la surface utilisée par core/dom.ts et ui/kit.ts : c'est un
 * banc d'essai honnête (les composants réels s'exécutent), pas un navigateur.
 */

export class FakeNode {
  nodeType = 1;
  textContent = '';
}

export class FakeText extends FakeNode {
  override nodeType = 3;
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

export class FakeElement extends FakeNode {
  tagName: string;
  namespace: string | null;
  children: Array<FakeElement | FakeText> = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  style: Record<string, string> = {};
  disabled = false;
  checked = false;
  selected = false;
  value = '';
  parent: FakeElement | null = null;

  constructor(tagName: string, namespace: string | null = null) {
    super();
    this.tagName = tagName.toUpperCase();
    this.namespace = namespace;
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null;
  }
  appendChild<T extends FakeElement | FakeText>(child: T): T {
    if (child instanceof FakeElement) child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement | FakeText): void {
    this.children = this.children.filter((c) => c !== child);
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  replaceChildren(...nodes: Array<FakeElement | FakeText>): void {
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void { /* non nécessaire au banc */ }
  dispatch(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() { /* noop */ }, target: this, ...ev });
  }
  focus(): void { /* traçable si besoin */ }
  click(): void {
    this.dispatch('click');
  }
  contains(el: FakeElement): boolean {
    if (el === this) return true;
    return this.children.some((c) => c instanceof FakeElement && c.contains(el));
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const c of el.children) {
        if (c instanceof FakeElement) {
          if (matches(c, selector)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  get classList() {
    const self = this;
    return {
      toggle(cls: string, force?: boolean): void {
        const classes = new Set((self.attributes.get('class') ?? '').split(/\s+/).filter(Boolean));
        const target = force ?? !classes.has(cls);
        if (target) classes.add(cls);
        else classes.delete(cls);
        self.attributes.set('class', [...classes].join(' '));
      },
      add(cls: string): void {
        this.toggle(cls, true);
      },
      contains(cls: string): boolean {
        return (self.attributes.get('class') ?? '').split(/\s+/).includes(cls);
      },
    };
  }
  /** Texte agrégé (assertions). */
  get text(): string {
    let out = this.textContent ?? '';
    for (const c of this.children) out += c instanceof FakeElement ? c.text : c.textContent;
    return out;
  }
}

function matches(el: FakeElement, selector: string): boolean {
  // sous-ensemble : 'tag', '.classe', '[attr]', 'tag[attr="v"]', 'a, b'
  return selector.split(',').some((one) => {
    const s = one.trim();
    const attrMatch = /^([a-z0-9]*)\[([-a-z]+)(?:="([^"]*)")?\]$/i.exec(s);
    if (attrMatch) {
      const [, tag, attr, val] = attrMatch;
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      if (!el.attributes.has(attr!)) return false;
      return val === undefined || el.attributes.get(attr!) === val;
    }
    if (s.startsWith('.')) return el.classList.contains(s.slice(1));
    if (s.includes(':')) return el.tagName === s.split(':')[0]!.toUpperCase(); // pseudo ignoré
    return el.tagName === s.toUpperCase();
  });
}

export interface FakeDocument {
  documentElement: FakeElement;
  body: FakeElement;
  createElement(tag: string): FakeElement;
  createElementNS(ns: string, tag: string): FakeElement;
  createTextNode(text: string): FakeText;
  createDocumentFragment(): FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
}

export function installFakeDom(): FakeDocument {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  const doc: FakeDocument = {
    documentElement,
    body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    createTextNode: (text) => new FakeText(text),
    createDocumentFragment: () => new FakeElement('#fragment'),
    getElementById: () => null,
    addEventListener: () => { /* global doc events non testés */ },
    removeEventListener: () => { /* idem */ },
  };
  (globalThis as Record<string, unknown>)['document'] = doc;
  (globalThis as Record<string, unknown>)['location'] = { hash: '#/', reload: () => { /* noop */ } };
  return doc;
}

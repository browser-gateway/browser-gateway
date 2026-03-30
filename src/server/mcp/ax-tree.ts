import type { CdpClient } from "./cdp-client.js";

const SKIP_ROLES = new Set([
  "none", "generic", "InlineTextBox", "LineBreak", "StaticText",
  "paragraph", "Section", "LabelText", "ignored",
]);

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "tab", "slider", "spinbutton",
  "searchbox", "switch", "menuitemcheckbox", "menuitemradio",
]);

const LANDMARK_ROLES = new Set([
  "heading", "navigation", "main", "banner", "form", "dialog",
  "alert", "table", "list", "img", "figure", "region",
]);

interface RefEntry {
  backendDOMNodeId: number;
  role: string;
  name: string;
}

let refMap = new Map<number, RefEntry>();
let nextRef = 1;

export function clearRefs(): void {
  refMap.clear();
  nextRef = 1;
}

export function getRef(ref: number): RefEntry | undefined {
  return refMap.get(ref);
}

export async function getSnapshot(cdp: CdpClient): Promise<string> {
  clearRefs();

  try {
    const result = await cdp.send("Accessibility.getFullAXTree") as {
      nodes: Array<{
        nodeId: string;
        role: { value: string };
        name?: { value: string };
        value?: { value: string };
        properties?: Array<{ name: string; value: { value: unknown } }>;
        backendDOMNodeId?: number;
        childIds?: string[];
        parentId?: string;
      }>;
    };

    if (!result.nodes || result.nodes.length < 3) {
      return fallbackSnapshot(cdp);
    }

    const lines: string[] = [];
    const nodeMap = new Map(result.nodes.map((n) => [n.nodeId, n]));
    const depths = new Map<string, number>();
    depths.set(result.nodes[0]?.nodeId ?? "", 0);

    for (const node of result.nodes) {
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";

      if (SKIP_ROLES.has(role)) continue;

      const isInteractive = INTERACTIVE_ROLES.has(role);
      const isLandmark = LANDMARK_ROLES.has(role);

      if (!isInteractive && !isLandmark) continue;
      if (isLandmark && !name) continue;

      const parentDepth = node.parentId ? (depths.get(node.parentId) ?? 0) : 0;
      const depth = parentDepth + 1;
      if (node.childIds) {
        for (const childId of node.childIds) {
          depths.set(childId, depth);
        }
      }

      if (!node.backendDOMNodeId) continue;

      const ref = nextRef++;
      refMap.set(ref, {
        backendDOMNodeId: node.backendDOMNodeId,
        role,
        name,
      });

      let line = `${"  ".repeat(Math.min(depth, 4))}[${ref}] ${role}`;
      if (name) line += ` "${name}"`;

      let hasValue = false;
      const props = node.properties ?? [];
      for (const prop of props) {
        if (prop.name === "value" && prop.value.value) {
          line += ` value="${prop.value.value}"`;
          hasValue = true;
        } else if (prop.name === "checked" && prop.value.value) {
          line += ` checked`;
        } else if (prop.name === "required" && prop.value.value) {
          line += ` required`;
        } else if (prop.name === "disabled" && prop.value.value) {
          line += ` disabled`;
        } else if (prop.name === "level" && prop.value.value) {
          line += ` level=${prop.value.value}`;
        }
      }

      if (node.value?.value && !hasValue) {
        line += ` value="${node.value.value}"`;
      }

      lines.push(line);
    }

    if (lines.length < 3) {
      return fallbackSnapshot(cdp);
    }

    return lines.join("\n");
  } catch {
    return fallbackSnapshot(cdp);
  }
}

async function fallbackSnapshot(cdp: CdpClient): Promise<string> {
  clearRefs();

  const result = await cdp.evaluate(`
    (() => {
      const els = document.querySelectorAll(
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], h1, h2, h3, h4, h5, h6'
      );
      const items = [];
      const seen = new Set();
      for (const el of els) {
        if (items.length >= 200) break;
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().slice(0, 100);
        const type = el.getAttribute('type') || '';
        const href = el.getAttribute('href') || '';
        const role = el.getAttribute('role') || '';
        const name = el.getAttribute('name') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const key = tag + text + type + href;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ tag, text, type, href, role, name, placeholder, value: el.value || '' });
      }
      return items;
    })()
  `) as Array<{
    tag: string; text: string; type: string; href: string;
    role: string; name: string; placeholder: string; value: string;
  }>;

  const lines: string[] = [];
  for (const el of (result || [])) {
    const ref = nextRef++;
    let line = `[${ref}] ${el.tag}`;
    if (el.type) line += `[type=${el.type}]`;
    if (el.role) line += `[role=${el.role}]`;
    if (el.text) line += ` "${el.text}"`;
    if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
    if (el.href) line += ` href="${el.href}"`;
    if (el.name) line += ` name="${el.name}"`;
    if (el.value) line += ` value="${el.value}"`;
    line += " (fallback)";
    lines.push(line);
  }

  return lines.length > 0 ? lines.join("\n") : "(empty page - no interactive elements found)";
}

export async function resolveRefToSelector(cdp: CdpClient, ref: number): Promise<string | null> {
  const entry = refMap.get(ref);
  if (!entry) return null;

  try {
    const resolved = await cdp.send("DOM.resolveNode", {
      backendNodeId: entry.backendDOMNodeId,
    }) as { object: { objectId: string } };

    const descResult = await cdp.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function() {
        const el = this;
        if (el.id) return '#' + el.id;
        const tag = el.tagName.toLowerCase();
        const name = el.getAttribute('name');
        if (name) return tag + '[name="' + name + '"]';
        const text = (el.textContent || '').trim().slice(0, 50);
        return JSON.stringify({ tag, text, role: el.getAttribute('role') });
      }`,
      returnByValue: true,
    }) as { result: { value: string } };

    return descResult.result.value;
  } catch {
    return null;
  }
}

export async function clickByRef(cdp: CdpClient, ref: number): Promise<{ success: boolean; error?: string }> {
  const entry = refMap.get(ref);
  if (!entry) return { success: false, error: `Ref [${ref}] not found. Run browser_snapshot to refresh refs.` };

  try {
    const resolved = await cdp.send("DOM.resolveNode", {
      backendNodeId: entry.backendDOMNodeId,
    }) as { object: { objectId: string } };

    await cdp.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center' }); this.click(); }`,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function typeByRef(
  cdp: CdpClient,
  ref: number,
  text: string,
  clear: boolean = true,
): Promise<{ success: boolean; error?: string }> {
  const entry = refMap.get(ref);
  if (!entry) return { success: false, error: `Ref [${ref}] not found. Run browser_snapshot to refresh refs.` };

  try {
    const resolved = await cdp.send("DOM.resolveNode", {
      backendNodeId: entry.backendDOMNodeId,
    }) as { object: { objectId: string } };

    await cdp.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function(text, shouldClear) {
        this.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(this).constructor.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(this, shouldClear ? text : this.value + text);
        } else {
          this.value = shouldClear ? text : this.value + text;
        }
        const reactProps = Object.keys(this).find(k => k.startsWith('__reactProps$'));
        if (reactProps && this[reactProps]?.onChange) {
          this[reactProps].onChange({ target: this, currentTarget: this });
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [
        { value: text },
        { value: clear },
      ],
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

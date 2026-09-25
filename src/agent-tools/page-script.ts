export interface PageSnapshotRequest {
  interactiveOnly: boolean;
  viewportOnly: boolean;
  maxNodes: number;
}

export interface PageSnapshotReply {
  url: string;
  lines: string[];
  refs: Array<[string, string, string]>;
  outsideViewport: number;
  capped: boolean;
}

export interface PageResolveRequest {
  ref: string;
  mode: "point" | "select" | "focus-select" | "rect";
  deadlineMs: number;
  option?: string;
  /** For focus-select right after our own click: when the page replaced the
   *  element, use the editable element that now has focus and rebind the ref. */
  acceptFocused?: boolean;
}

export interface PageResolveReply {
  ok: boolean;
  stale?: boolean;
  reason?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  checked?: boolean;
  done?: boolean;
}

export interface PageQuietRequest {
  quietMs: number;
  maxMs: number;
}

export interface PageWaitRequest {
  kind: "text" | "textGone" | "selector" | "selectorGone" | "urlContains";
  value: string;
  timeoutMs: number;
}

const SHARED = `
  const S = (window.__bgAgent = window.__bgAgent || { seq: 0, byRef: new Map() });
  const INTERACTIVE = new Set(["button","link","textbox","searchbox","checkbox","radio","combobox",
    "listbox","option","menuitem","menuitemcheckbox","menuitemradio","slider","spinbutton","switch",
    "tab","textarea"]);
  const CONTEXT = new Set(["heading","dialog","alert","alertdialog","form","navigation","main","table"]);
  const TEXT_INPUTS = new Set(["text","email","password","tel","url","date","datetime-local","month",
    "time","week",""]);
  const BUTTON_INPUTS = new Set(["button","submit","reset","image"]);
  const SKIP_TAGS = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","HEAD","META","LINK","TITLE"]);

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A" || tag === "AREA") return el.hasAttribute("href") ? "link" : "";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden") return "";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (BUTTON_INPUTS.has(type)) return "button";
      return TEXT_INPUTS.has(type) ? "textbox" : "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "DIALOG") return "dialog";
    if (tag === "FORM") return "form";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "TABLE") return "table";
    if (el.isContentEditable) return "textbox";
    return "";
  }

  function ownText(el) {
    if (!el.querySelector || !el.querySelector("style,script,noscript")) {
      return (el.textContent || "").replace(/\\s+/g, " ").trim();
    }
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName.toUpperCase())) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return out.replace(/\\s+/g, " ").trim();
  }

  function nameOf(el, doc, fromContentsAllowed) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map(ownText);
      if (parts.length) return parts.join(" ");
    }
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    if (el.id) {
      const tag = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (tag) return ownText(tag);
    }
    const wrapping = el.closest ? el.closest("label") : null;
    if (wrapping) {
      const text = ownText(wrapping);
      if (text) return text;
    }
    const tagName = el.tagName;
    if (tagName === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (BUTTON_INPUTS.has(type) && el.value) return String(el.value);
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
    } else if (fromContentsAllowed) {
      const text = ownText(el);
      if (text) return text;
      const img = el.querySelector ? el.querySelector("img[alt]") : null;
      if (img && img.getAttribute("alt")) return String(img.getAttribute("alt")).trim();
      const inner = el.querySelector ? el.querySelector("[aria-label]") : null;
      if (inner) return String(inner.getAttribute("aria-label")).trim();
    }
    const title = el.getAttribute("title");
    return title && title.trim() ? title.trim() : "";
  }

  function clip(text) {
    return text.length > 120 ? text.slice(0, 120) + "\\u2026" : text;
  }

  function stateOf(el, role) {
    const parts = [];
    const value = el.value;
    if (typeof value === "string" && value !== "" && role !== "button" && el.tagName !== "OPTION") {
      parts.push('value="' + clip(value.replace(/\\s+/g, " ").trim()) + '"');
    }
    const ariaChecked = el.getAttribute("aria-checked");
    if (role === "checkbox" || role === "radio" || role === "switch") {
      parts.length = 0;
      parts.push("checked=" + String(ariaChecked !== null ? ariaChecked === "true" : el.checked === true));
    } else if (ariaChecked !== null) {
      parts.push("checked=" + String(ariaChecked === "true"));
    }
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded !== null) parts.push("expanded=" + String(expanded === "true"));
    if (el.required === true || el.getAttribute("aria-required") === "true") parts.push("required");
    return parts.length ? " " + parts.join(" ") : "";
  }

  function refFor(el, role, name) {
    const held = el.__bgRef;
    if (held && held.role === role && held.name === name) return held.id;
    const id = "e" + ++S.seq;
    el.__bgRef = { id: id, role: role, name: name };
    S.byRef.set(id, el);
    return id;
  }

  function findByRef(ref) {
    const cached = S.byRef.get(ref);
    if (cached && cached.isConnected) return cached;
    const stack = [document];
    while (stack.length) {
      const root = stack.pop();
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.__bgRef && el.__bgRef.id === ref) return el;
        if (el.tagName === "IFRAME") {
          let inner = null;
          try { inner = el.contentDocument; } catch (e) { inner = null; }
          if (inner) stack.push(inner);
        }
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    return null;
  }
`;

export const SNAPSHOT_FN = `(req) => {
  ${SHARED}
  const lines = [];
  const refs = [];
  let outside = 0;
  let visited = 0;
  let capped = false;
  const containers = new Set();
  const knownElements = new Set();
  const pointerDead = new Map();
  const collected = [];
  const GENERIC_NAME_MAX = 40;

  function pointerBlocked(el, view) {
    let node = el;
    const chain = [];
    while (node && node.nodeType === 1) {
      const known = pointerDead.get(node);
      if (known !== undefined) {
        for (const seen of chain) pointerDead.set(seen, known);
        return known;
      }
      if (view.getComputedStyle(node).pointerEvents === "none") {
        for (const seen of chain) pointerDead.set(seen, true);
        pointerDead.set(node, true);
        return true;
      }
      chain.push(node);
      node = node.parentElement;
    }
    for (const seen of chain) pointerDead.set(seen, false);
    return false;
  }

  const TRANSPARENT_CONTROLS = new Set(["SELECT","INPUT","TEXTAREA"]);

  function rendered(el, style) {
    const checkOpacity = !TRANSPARENT_CONTROLS.has(el.tagName);
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: checkOpacity, checkVisibilityCSS: true, contentVisibilityAuto: true });
    }
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && (!checkOpacity || Number(style.opacity) !== 0);
  }

  function walk(root, doc, view, offsetX, offsetY) {
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (++visited > req.maxNodes) { capped = true; return; }
      const el = all[i];
      if (SKIP_TAGS.has(el.tagName)) continue;
      const style = view.getComputedStyle(el);
      if (!rendered(el, style)) continue;

      if (el.tagName === "IFRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        if (inner && inner.body) {
          const box = el.getBoundingClientRect();
          walk(inner.body, inner, el.contentWindow, offsetX + box.left, offsetY + box.top);
          if (capped) return;
        }
        continue;
      }
      if (el.shadowRoot) {
        walk(el.shadowRoot, doc, view, offsetX, offsetY);
        if (capped) return;
      }

      const role = roleOf(el);
      const clickable = style.cursor === "pointer" || (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0);
      if (!role && !clickable) continue;
      const known = INTERACTIVE.has(role);
      if (!known && !CONTEXT.has(role) && !clickable) continue;
      if (req.interactiveOnly && !known && !clickable) continue;
      if ((known || clickable) && pointerBlocked(el, view)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const left = rect.left + offsetX;
      const top = rect.top + offsetY;
      const onScreen = rect.bottom + offsetY > 0 && rect.right + offsetX > 0
        && top < window.innerHeight && left < window.innerWidth;

      const landmark = !known && CONTEXT.has(role) && role !== "heading";
      const name = el.tagName === "SELECT" && el.labels && el.labels.length
        ? visibleLabelText(el.labels[0]) || clip(nameOf(el, doc, !landmark))
        : clip(nameOf(el, doc, !landmark));
      if (!known && !name) continue;
      collected.push({ el: el, role: role, name: name, known: known, onScreen: onScreen });
      if (known) knownElements.add(el);
      let up = el.parentElement;
      while (up && !containers.has(up)) { containers.add(up); up = up.parentElement; }
    }
  }

  walk(document.body || document.documentElement, document, window, 0, 0);

  function insideKnown(el) {
    for (let up = el.parentElement; up; up = up.parentElement) if (knownElements.has(up)) return true;
    return false;
  }

  function hiddenControlOf(el) {
    const label = el.tagName === "LABEL" ? el : el.closest ? el.closest("label") : null;
    const control = (label && label.control)
      || (el.querySelector ? el.querySelector("select,textarea,input:not([type=hidden])") : null);
    return control && !knownElements.has(control) ? control : null;
  }

  function visibleLabelText(el) {
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1 || node.tagName === "SELECT" || node.tagName === "OPTION" || SKIP_TAGS.has(node.tagName.toUpperCase())) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return clip(out.replace(/\\s+/g, " ").trim());
  }

  function labelsAKnownControl(el) {
    const label = el.tagName === "LABEL" ? el : el.closest ? el.closest("label") : null;
    const target = (label && label.control) || (el.htmlFor ? document.getElementById(el.htmlFor) : null);
    if (target && knownElements.has(target)) return true;
    const owned = el.querySelector ? el.querySelector("input,select,textarea,button,a[href]") : null;
    return !!owned && knownElements.has(owned);
  }

  const runs = [];
  let lastName = null;
  for (const item of collected) {
    const generic = !item.known && !CONTEXT.has(item.role);
    if (generic && (containers.has(item.el) || insideKnown(item.el))) continue;
    if (generic && item.name.length > GENERIC_NAME_MAX) continue;
    if (generic && labelsAKnownControl(item.el)) continue;
    if (generic && item.name === lastName) continue;
    lastName = item.name;
    if (req.viewportOnly && !item.onScreen) { outside++; continue; }
    const control = generic ? hiddenControlOf(item.el) : null;
    const target = control && control.tagName === "SELECT" ? control : item.el;
    const role = control ? roleOf(control) || "button" : item.known || CONTEXT.has(item.role) ? item.role : "button";
    const name = control && control.tagName === "SELECT" ? visibleLabelText(item.el) || item.name : item.name;
    const named = name ? ' "' + name + '"' : "";
    let line;
    if (item.known || !CONTEXT.has(item.role)) {
      const ref = refFor(target, role, name);
      refs.push([ref, role, name]);
      line = ref + " " + role + named + stateOf(target, role);
    } else {
      line = "- " + role + named;
    }
    const prev = runs[runs.length - 1];
    if (prev && prev.line === line) prev.count++;
    else runs.push({ line: line, count: 1 });
  }
  for (const run of runs) {
    if (run.count > 2) lines.push(run.line + " (\\u00d7" + run.count + ")");
    else for (let n = 0; n < run.count; n++) lines.push(run.line);
  }
  return { url: location.href, lines: lines, refs: refs, outsideViewport: outside, capped: capped };
}`;

export const RESOLVE_FN = `(req) => {
  ${SHARED}
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const labelTarget = (hit, el) => {
    let node = hit;
    while (node && node.nodeType === 1) {
      if (node === el) return true;
      if (node.tagName === "LABEL" && (node.control === el || node.htmlFor === el.id)) return true;
      node = node.parentElement;
    }
    return false;
  };
  const focusedEditable = () => {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (!active || active === document.body) return null;
    const tag = active.tagName;
    if (tag === "TEXTAREA" || active.isContentEditable) return active;
    if (tag === "INPUT" && !/^(button|checkbox|radio|submit|reset|file|image|range|color|hidden)$/i.test(active.type)) {
      return active;
    }
    return null;
  };
  return (async () => {
    const deadline = Date.now() + req.deadlineMs;
    let reason = "never became visible";
    let previous = null;
    for (;;) {
      let el = findByRef(req.ref);
      if (!el && req.mode === "focus-select" && req.acceptFocused) {
        el = focusedEditable();
        if (el) {
          el.__bgRef = { id: req.ref, role: el.__bgRef ? el.__bgRef.role : "", name: el.__bgRef ? el.__bgRef.name : "" };
          S.byRef.set(req.ref, el);
        }
      }
      if (!el) return { ok: false, stale: true };

      if (req.mode === "select") {
        const options = Array.from(el.options || []);
        const match = options.find((o) => o.value === req.option || o.label === req.option
          || (o.textContent || "").trim() === req.option);
        if (!match) return { ok: false, reason: 'no option matching "' + req.option + '"' };
        el.value = match.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, done: true };
      }
      if (req.mode === "rect") {
        const box = el.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return { ok: false, reason: "has no visible box" };
        return { ok: true, x: box.left, y: box.top, width: box.width, height: box.height };
      }
      if (req.mode === "focus-select") {
        el.focus();
        if (typeof el.select === "function") el.select();
        else {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return { ok: true, done: true };
      }

      if (typeof el.scrollIntoViewIfNeeded === "function") el.scrollIntoViewIfNeeded(false);
      else el.scrollIntoView({ block: "center", inline: "center" });
      await frame();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        reason = "has no visible box";
      } else if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
        reason = "is disabled";
      } else if (previous && Math.abs(previous.x - rect.x) < 1 && Math.abs(previous.y - rect.y) < 1) {
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const doc = el.ownerDocument;
        let hit = doc.elementFromPoint(x, y);
        while (hit && hit.tagName === "IFRAME" && hit.contentDocument) {
          const inner = hit.getBoundingClientRect();
          const next = hit.contentDocument.elementFromPoint(x - inner.left, y - inner.top);
          if (!next || next === hit) break;
          hit = next;
        }
        if (hit && !el.contains(hit) && !labelTarget(hit, el)) {
          reason = "is covered by another element";
        } else {
          return { ok: true, x: x, y: y, checked: el.checked === true
            || el.getAttribute("aria-checked") === "true" };
        }
      } else {
        reason = "kept moving";
      }
      previous = { x: rect.x, y: rect.y };
      if (Date.now() >= deadline) return { ok: false, reason: reason };
      await frame();
    }
  })();
}`;

export const QUIET_FN = `(req) => new Promise((resolve) => {
  const started = Date.now();
  let timer = setTimeout(done, req.quietMs);
  const cap = setTimeout(done, req.maxMs);
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(done, req.quietMs);
  });
  function done() {
    clearTimeout(timer);
    clearTimeout(cap);
    observer.disconnect();
    resolve(Date.now() - started);
  }
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    characterData: true });
})`;

export const WAIT_FN = `(req) => new Promise((resolve) => {
  const started = Date.now();
  const holds = () => {
    const body = document.body ? document.body.innerText || "" : "";
    if (req.kind === "text") return body.includes(req.value);
    if (req.kind === "textGone") return !body.includes(req.value);
    if (req.kind === "selector") return !!document.querySelector(req.value);
    if (req.kind === "selectorGone") return !document.querySelector(req.value);
    return location.href.includes(req.value);
  };
  const finish = (met) => {
    clearInterval(tick);
    clearTimeout(cap);
    observer.disconnect();
    resolve({ met: met, waitedMs: Date.now() - started });
  };
  const check = () => { if (holds()) finish(true); };
  const observer = new MutationObserver(check);
  const tick = setInterval(check, 100);
  const cap = setTimeout(() => finish(false), req.timeoutMs);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    characterData: true });
  check();
})`;

const FILLED_PASSWORD_FN =
  "const pw=(root)=>{if(!root||!root.querySelectorAll)return false;" +
  "for(const el of root.querySelectorAll('input[type=\"password\"]'))if(el.value)return true;" +
  "for(const el of root.querySelectorAll('*'))if(el.shadowRoot&&pw(el.shadowRoot))return true;return false;};";

const CONTROL_SELECTOR = 'button,input[type="submit"],input[type="image"],[role="button"],a';

/** Page expression: true when a click at (x, y) lands on a button or link while a password field holds a value. */
export function loginClickExpression(x: number, y: number): string {
  return `(()=>{${FILLED_PASSWORD_FN}if(!pw(document))return false;` +
    `let el=document.elementFromPoint(${Math.round(x)},${Math.round(y)});` +
    "while(el&&el.shadowRoot){const inner=el.shadowRoot.elementFromPoint(" + `${Math.round(x)},${Math.round(y)}` + ");if(!inner||inner===el)break;el=inner;}" +
    `for(let n=el;n;n=n.parentElement||(n.getRootNode&&n.getRootNode().host))if(n.matches&&n.matches(${JSON.stringify(CONTROL_SELECTOR)}))return true;return false;})()`;
}

/** Page expression: true when Enter in the focused field would submit a password. */
export const LOGIN_ENTER_EXPRESSION =
  `(()=>{${FILLED_PASSWORD_FN}let el=document.activeElement;while(el&&el.shadowRoot&&el.shadowRoot.activeElement)el=el.shadowRoot.activeElement;` +
  "if(!el||el.tagName!=='INPUT')return false;return el.form?pw(el.form):pw(document);})()";

/** Page expression: how many mouse moves this document has received, counted under a hidden window key. */
export function inputCounterExpression(key: string): string {
  return `(()=>{const k=${JSON.stringify(key)};if(!Object.prototype.hasOwnProperty.call(window,k)){` +
    "Object.defineProperty(window,k,{value:{n:0},enumerable:false});addEventListener('mousemove',()=>{window[k].n++;},true);}" +
    "return window[k].n;})()";
}

const EMBEDDED_SELECTOR = "iframe,frame,embed,object";

/** Page expression: a viewport point, (x, y) when clear, whose topmost element belongs to this document rather than an embedded frame; null when none is clear. */
export function probePointExpression(x: number, y: number): string {
  return `(()=>{const X=${Math.round(x)},Y=${Math.round(y)};` +
    `const clear=(px,py)=>{const el=document.elementFromPoint(px,py);return !!el&&!el.matches(${JSON.stringify(EMBEDDED_SELECTOR)});};` +
    "if(clear(X,Y))return{x:X,y:Y};const w=innerWidth,h=innerHeight;" +
    "for(const fy of [0.05,0.5,0.95])for(const fx of [0.05,0.5,0.95]){const px=Math.round(w*fx),py=Math.round(h*fy);if(clear(px,py)&&clear(px+1,py))return{x:px,y:py};}" +
    "return null;})()";
}

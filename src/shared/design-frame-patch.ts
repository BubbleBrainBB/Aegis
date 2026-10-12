/** Trusted frame code, kept as a literal so bundlers cannot add closure helpers. */
export const designFramePatchScript = String.raw`
const patchDocument = html => {
  // The parent sends sanitizeDesignHtml output, never generated scripts or frame chrome.
  const next = new DOMParser().parseFromString(html, 'text/html');
  if (next.querySelector('script,iframe,object,embed,meta,link,base,[data-aegis-frame]'))
    throw new Error('Unexpected active frame content');
  const owned = n => n.nodeType === 1 && n.hasAttribute('data-aegis-frame');
  const key = n => n.nodeType === 1 ? n.getAttribute('data-aegis-node-id') || n.id || null : null;
  const compatible = (a,b) => a.nodeType === b.nodeType &&
    (a.nodeType !== 1 || (a.localName === b.localName && a.namespaceURI === b.namespaceURI));
  const keyed = new Map();
  document.querySelectorAll('[data-aegis-node-id],[id]').forEach(n => keyed.set(key(n), n));
  const used = new Set();
  const scrolls = [...document.querySelectorAll('*')].filter(n => n.scrollTop || n.scrollLeft)
    .map(n => [n,n.scrollLeft,n.scrollTop]);
  const windowScroll = [scrollX,scrollY];
  const active = document.activeElement;
  const range = active && typeof active.selectionStart === 'number'
    ? [active.selectionStart,active.selectionEnd,active.selectionDirection] : null;
  const attrs = (a,b) => {
    for (const v of [...a.attributes]) if (!b.hasAttributeNS(v.namespaceURI,v.localName)) a.removeAttributeNS(v.namespaceURI,v.localName);
    for (const v of [...b.attributes]) if (a.getAttributeNS(v.namespaceURI,v.localName) !== v.value) a.setAttributeNS(v.namespaceURI,v.name,v.value);
  };
  const patch = (a,b) => {
    if (a.isEqualNode(b)) return;
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    const valueChanged = a.localName === 'input' && a.getAttribute('value') !== b.getAttribute('value');
    const checkedChanged = a.localName === 'input' && a.hasAttribute('checked') !== b.hasAttribute('checked');
    const textChanged = a.localName === 'textarea' && a.textContent !== b.textContent;
    attrs(a,b);
    children(a,b);
    if (valueChanged) a.value = b.getAttribute('value') || '';
    if (checkedChanged) a.checked = b.hasAttribute('checked');
    if (textChanged) a.value = b.textContent;
  };
  const children = (a,b) => {
    let cursor = a.firstChild;
    const kept = new Set();
    for (const want of [...b.childNodes]) {
      while (cursor && owned(cursor)) cursor = cursor.nextSibling;
      const k = key(want);
      let have = k ? keyed.get(k) : cursor;
      if (!have || used.has(have) || owned(have) || key(have) !== k || !compatible(have,want) || have.contains(a)) have = null;
      if (!have) have = document.importNode(want,false);
      used.add(have); kept.add(have);
      if (have !== cursor) a.insertBefore(have,cursor);
      patch(have,want);
      cursor = have.nextSibling;
    }
    for (const n of [...a.childNodes]) if (!owned(n) && !kept.has(n)) n.remove();
  };
  patch(document.documentElement,next.documentElement);
  if (active?.isConnected && document.activeElement !== active && active instanceof HTMLElement) active.focus({preventScroll:true});
  if (range && active?.isConnected) { try { active.setSelectionRange(...range); } catch {} }
  for (const [n,x,y] of scrolls) if (n.isConnected) { n.scrollLeft=x; n.scrollTop=y; }
  if (scrollX !== windowScroll[0] || scrollY !== windowScroll[1]) scrollTo(...windowScroll);
};
`;

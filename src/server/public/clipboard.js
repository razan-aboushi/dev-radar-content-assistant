/*
  Clipboard utility.

  navigator.clipboard is not something you can assume. It is undefined outside a
  secure context, and http://192.168.x.x:4311 — which is how you reach this
  dashboard from a phone on the same network — is not one, even though
  http://127.0.0.1 is. Firefox rejects writeText() from a handler it does not
  consider user-initiated, and any browser can deny the permission outright.

  So: try the modern API, fall back to a selected textarea and execCommand, and
  if both fail say which one failed and why. Never resolve as though it worked.

  Returns { ok: true } or { ok: false, reason: 'insecure'|'denied'|'unavailable' }.
  It never throws and never rejects.
*/
(function (global) {
  'use strict';

  function hasAsyncClipboard() {
    return Boolean(global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText);
  }

  /**
   * The pre-Clipboard-API approach, kept because it works in exactly the places
   * the modern one does not.
   *
   * readOnly plus a real (not zero) size stops iOS Safari from either refusing
   * the selection or scrolling the page to the offscreen node, and setting the
   * value before appending avoids a paint with the text visible.
   */
  function copyViaTextarea(text) {
    var doc = global.document;
    if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false;

    var textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';

    var previous = doc.activeElement;
    doc.body.appendChild(textarea);

    var copied = false;
    try {
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      copied = doc.execCommand('copy');
    } catch (error) {
      copied = false;
    } finally {
      doc.body.removeChild(textarea);
      // Focus goes back where it was, or a keyboard user is dumped at the top
      // of the document every time they press Copy.
      if (previous && typeof previous.focus === 'function') previous.focus();
    }
    return copied;
  }

  function isSecure() {
    if (global.isSecureContext !== undefined) return Boolean(global.isSecureContext);
    var protocol = global.location && global.location.protocol;
    var host = global.location && global.location.hostname;
    return protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  }

  /**
   * @param {string} text exactly what should land on the clipboard
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function copyText(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, reason: 'unavailable' };
    }

    if (hasAsyncClipboard()) {
      try {
        await global.navigator.clipboard.writeText(text);
        return { ok: true };
      } catch (error) {
        // Fall through: a rejection here is routine (permission, focus,
        // non-secure origin) and the textarea path often still works.
        if (copyViaTextarea(text)) return { ok: true };
        var denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        return { ok: false, reason: denied ? 'denied' : 'unavailable' };
      }
    }

    if (copyViaTextarea(text)) return { ok: true };
    return { ok: false, reason: isSecure() ? 'unavailable' : 'insecure' };
  }

  global.clipboard = {
    copyText: copyText,
    hasAsyncClipboard: hasAsyncClipboard,
    isSecureContext: isSecure,
  };
})(typeof window !== 'undefined' ? window : globalThis);

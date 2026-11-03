const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/**
 * Escapes a value for use in HTML text or a quoted attribute.
 * Bot names, token symbols, log messages and other server data must go through this
 * before being interpolated into innerHTML.
 */
export function escapeHtml(value) {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

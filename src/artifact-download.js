// RFC 6266 / RFC 5987 Content-Disposition for immutable artifact revisions.
// A web server can request a download but cannot choose a user's local directory.
export function artifactDeliveryHeaders(title, fallbackId, extension, download = false) {
  const ext = /^\.[a-z0-9]{1,12}$/.test(String(extension || "").toLowerCase()) ? extension.toLowerCase() : ".bin";
  const leaf = String(title || fallbackId || "artifact").replace(/\\/g, "/").split("/").at(-1);
  const sanitized = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 160) || "artifact";
  const name = sanitized.toLowerCase().endsWith(ext) ? sanitized : sanitized + ext;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return (download ? "attachment" : "inline") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

// save-file.js — hand the user a file. On an ordinary web page that is a download link. Inside a
// host that wraps the page (a claude.ai artifact) plain downloads are blocked, and the host's own
// `downloads` capability asks the viewer to confirm instead; it is used when the host offers it.

/** Returns 'saved' (host confirmed), 'declined' (viewer said no), or 'link' (browser download started). */
export async function saveFile(filename, blob) {
  const host = typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function' ? window.claude : null;
  if (host) {
    let downloads = null;
    try { downloads = await host.use('downloads'); } catch { /* not offered */ }
    if (downloads) {
      try { await downloads.save({ filename, data: blob }); return 'saved'; } catch (err) {
        if (err && (err.code === 'declined' || err.code === 'rate_limited')) return 'declined';
        // any other refusal: fall through to the plain link
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'link';
}

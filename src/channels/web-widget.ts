/**
 * A self-contained support chat widget, served at GET /. It keeps a session id in
 * localStorage (the conversation key so replies thread), POSTs each message to /web,
 * and renders casey's reply. No build step, no dependencies — drop it behind any
 * reverse proxy / tunnel and it's a live support channel.
 */
export const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IT Support</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --me:#2563eb; --them:#232732; --text:#e7e9ee; --dim:#8b90a0; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .chat { width:min(440px,94vw); height:min(640px,92vh); background:var(--panel); border-radius:14px;
          display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  header { padding:16px 18px; background:#11141a; border-bottom:1px solid #232732; }
  header b { font-size:15px; } header span { color:var(--dim); font-size:12.5px; display:block; margin-top:2px; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:82%; padding:9px 13px; border-radius:13px; white-space:pre-wrap; word-wrap:break-word; }
  .them { background:var(--them); align-self:flex-start; border-bottom-left-radius:4px; }
  .me   { background:var(--me); align-self:flex-end; border-bottom-right-radius:4px; }
  .meta { color:var(--dim); font-size:12px; align-self:center; }
  form { display:flex; gap:8px; padding:12px; border-top:1px solid #232732; background:#12151b; }
  #email { width:100%; padding:9px 12px; margin:0 12px 0; border:1px solid #2a2f3a; background:#12151b;
           color:var(--text); border-radius:9px; }
  .emailrow { padding:10px 0 0; }
  textarea { flex:1; resize:none; height:42px; padding:10px 12px; border:1px solid #2a2f3a; background:#0f1115;
             color:var(--text); border-radius:9px; font:inherit; }
  button { padding:0 16px; border:0; background:var(--me); color:#fff; border-radius:9px; cursor:pointer; font-weight:600; }
  button:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
  <div class="chat">
    <header><b>IT Support</b><span>We usually reply in a few seconds.</span></header>
    <div class="emailrow"><input id="email" type="email" placeholder="Your email (optional, so we can follow up)" /></div>
    <div id="log"><div class="meta">How can we help?</div></div>
    <form id="f">
      <textarea id="t" placeholder="Describe your issue…" autofocus></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </div>
<script>
  const log = document.getElementById('log'), form = document.getElementById('f'),
        ta = document.getElementById('t'), send = document.getElementById('send'),
        emailEl = document.getElementById('email');
  let sid = localStorage.getItem('casey_sid');
  if (!sid) { sid = 'web-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2)); localStorage.setItem('casey_sid', sid); }
  const saved = localStorage.getItem('casey_email'); if (saved) emailEl.value = saved;
  function add(text, who) { const d = document.createElement('div'); d.className = 'msg ' + who; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; }
  function note(text) { const d = document.createElement('div'); d.className = 'meta'; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text) return;
    if (emailEl.value.trim()) localStorage.setItem('casey_email', emailEl.value.trim());
    add(text, 'me'); ta.value = ''; send.disabled = true; note('…');
    try {
      const res = await fetch('/web', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ conversationId: sid, from: emailEl.value.trim() || sid, name: emailEl.value.trim() || undefined, text }) });
      const data = await res.json();
      log.querySelectorAll('.meta').forEach(m => { if (m.textContent === '…') m.remove(); });
      if (data.reply) add(data.reply, 'them'); else note('(no reply)');
    } catch (err) {
      log.querySelectorAll('.meta').forEach(m => { if (m.textContent === '…') m.remove(); });
      note('Connection error — please try again.');
    } finally { send.disabled = false; ta.focus(); }
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
</script>
</body>
</html>`;

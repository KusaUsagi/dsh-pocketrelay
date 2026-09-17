/**
 * 极简管理台 / 配对页 HTML。无外部资源，纯内联。
 */

export function landingPage(): string {
  return html5(
    "dsh-pocketrelay 中继",
    `<h1>dsh-pocketrelay 中继</h1>
     <p>手机：打开 <a href="/pair">/pair</a> 输入桌面端展示的 6 位配对码。</p>
     <p>管理：<a href="/admin">/admin</a>（需口令）。</p>`,
  )
}

export function pairPage(): string {
  return html5(
    "手机配对",
    `<h1>手机配对</h1>
     <form id="f">
       <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 位配对码" required autofocus />
       <button type="submit">配对</button>
     </form>
     <p id="m" style="color:#c00"></p>
     <script>
       document.getElementById('f').addEventListener('submit', async (e) => {
         e.preventDefault();
         const code = new FormData(e.target).get('code');
         const r = await fetch('/pair', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({code}) });
         const j = await r.json().catch(() => ({}));
         if (j.ok && j.deviceId) { location.href = '/d/' + j.deviceId + '/'; }
         else { document.getElementById('m').textContent = j.error || '配对失败'; }
       });
     </script>`,
  )
}

export function adminLoginPage(): string {
  return html5(
    "中继管理台",
    `<h1>中继管理台</h1>
     <form method="POST" action="/admin/login">
       <input name="password" type="password" placeholder="管理口令" required autofocus />
       <button type="submit">登录</button>
     </form>`,
  )
}

export interface AdminDeviceView {
  deviceId: string
  hostName: string
  createdAt: number
  online: boolean
}

export function adminDashboardHtml(devices: AdminDeviceView[]): string {
  const rows = devices
    .map(
      (d) =>
        `<tr><td>${esc(d.deviceId.slice(0, 8))}…</td><td>${esc(d.hostName)}</td><td>${d.online ? "在线" : "离线"}</td>` +
        `<td><form method="POST" action="/admin/revoke"><input type="hidden" name="deviceId" value="${esc(d.deviceId)}"><button type="submit">撤销</button></form></td></tr>`,
    )
    .join("")
  return html5(
    "中继管理台",
    `<h1>设备</h1><table border="1" cellpadding="6"><thead><tr><th>设备</th><th>主机名</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
  )
}

function html5(title: string, body: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body>${body}</body></html>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

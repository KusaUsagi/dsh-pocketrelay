/**
 * 手机端 Web UI（内联 HTML 字符串）。由 relay-server 在 `/` 提供给已配对手机。
 *
 * - 纯内联：无外部资源、无框架，单文件 HTML 文档字符串。
 * - 三栏移动布局：顶栏 + 内容区（会话列表 / 聊天详情 / 文件树 / 文件查看编辑）+ 底部标签栏。
 * - 所有来自主机/SDK 的字符串均经 textContent / createElement 渲染，绝不与 host 数据拼 innerHTML（XSS 安全）。
 * - 内联 JS 不经 tsc 类型检查（relay-server 为 Node-only，无 DOM lib）；保持短小、零依赖、仅用 fetch + DOM API。
 *
 * 仅产出 HTML；`/api/*` 路由与 `/` 挂载由 relay-server 其他模块实现。
 */

export function mobileAppHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e1014">
<meta name="color-scheme" content="dark">
<link rel="manifest" href="/manifest.webmanifest">
<title>DSH 远程</title>
<style>
:root{
  --bg:#0e1014;
  --surface:#161922;
  --surface-2:#1e222d;
  --surface-3:#262b37;
  --border:#2a2f3b;
  --border-soft:#222732;
  --text:#e7eaf0;
  --text-dim:#9aa3b2;
  --text-faint:#6b7280;
  --accent:#5b8cff;
  --accent-soft:rgba(91,140,255,.14);
  --danger:#ff6b6b;
  --warn:#f5a623;
  --success:#3ecf8e;
  --radius:12px;
  --radius-sm:8px;
  --tap:44px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,"SFMono-Regular","Cascadia Code","Source Code Pro",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;height:100%;}
html{background:var(--bg);}
body{
  background:var(--bg);
  color:var(--text);
  font-family:var(--font);
  font-size:16px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  text-size-adjust:100%;
  overscroll-behavior-y:none;
  overflow-x:hidden;
}
button{font-family:inherit;}
a{color:var(--accent);}

#dsh-mobile-app{
  display:flex;
  flex-direction:column;
  height:100vh;
  height:100dvh;
  max-width:680px;
  margin:0 auto;
  background:var(--bg);
  position:relative;
}

/* ---- 顶栏 ---- */
.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:10px 14px;
  padding-top:max(10px,env(safe-area-inset-top));
  background:var(--surface);
  border-bottom:1px solid var(--border);
  min-height:52px;
}
.topbar-title{font-weight:600;font-size:17px;letter-spacing:.2px;}
.status-pill{
  font-size:12px;
  padding:4px 10px;
  border-radius:999px;
  background:var(--surface-3);
  color:var(--text-dim);
  white-space:nowrap;
}
.status-pill.online{color:var(--success);}
.status-pill.offline{color:var(--danger);background:rgba(255,107,107,.12);}

/* ---- 离线横幅 ---- */
.offline-banner{
  background:rgba(245,166,35,.14);
  color:var(--warn);
  text-align:center;
  padding:8px 12px;
  font-size:13px;
  border-bottom:1px solid var(--border);
}

/* ---- 内容区 ---- */
.content{flex:1;position:relative;overflow:hidden;min-height:0;}
.pane{
  position:absolute;
  inset:0;
  display:flex;
  flex-direction:column;
  min-height:0;
}
.pane[hidden]{display:none!important;}
.pane-head{
  display:flex;
  align-items:center;
  gap:8px;
  padding:8px 12px;
  font-weight:600;
  font-size:15px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  min-height:48px;
}
.pane-head .ph-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.icon-btn{
  appearance:none;
  background:transparent;
  border:0;
  color:var(--accent);
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:var(--tap);
  min-height:var(--tap);
  padding:6px;
  border-radius:var(--radius-sm);
  font-size:14px;
}
.icon-btn:active{background:var(--surface-2);}
.icon-btn svg{width:22px;height:22px;display:block;}

/* ---- 列表 ---- */
.list{
  flex:1;
  overflow-y:auto;
  -webkit-overflow-scrolling:touch;
  padding:6px 0;
}
.list-item{
  display:flex;
  align-items:center;
  gap:12px;
  width:100%;
  padding:12px 14px;
  min-height:56px;
  background:transparent;
  border:0;
  border-bottom:1px solid var(--border-soft);
  color:var(--text);
  font:inherit;
  text-align:left;
  cursor:pointer;
}
.list-item:active{background:var(--surface-2);}
.list-item .li-ic{flex:0 0 auto;color:var(--text-dim);display:inline-flex;}
.list-item .li-ic svg{width:20px;height:20px;display:block;}
.list-item .li-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.list-item .li-title{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.list-item .li-sub{font-size:12px;color:var(--text-faint);}
.empty{padding:24px 14px;text-align:center;color:var(--text-faint);font-size:14px;}

/* ---- 面包屑 ---- */
.breadcrumb{
  display:flex;
  align-items:center;
  gap:4px;
  flex-wrap:wrap;
  padding:8px 12px;
  border-bottom:1px solid var(--border-soft);
  background:var(--surface);
  font-size:13px;
  overflow-x:auto;
}
.crumb{
  appearance:none;
  background:transparent;
  border:0;
  color:var(--accent);
  font:inherit;
  font-size:13px;
  padding:6px 8px;
  min-height:32px;
  cursor:pointer;
  border-radius:6px;
}
.crumb:active{background:var(--surface-2);}
.crumb.cur{color:var(--text-dim);cursor:default;}
.crumb-sep{color:var(--text-faint);}
.crumb-up{margin-left:auto;}

/* ---- 聊天 ---- */
.chat-scroll{
  flex:1;
  overflow-y:auto;
  -webkit-overflow-scrolling:touch;
  padding:12px 12px 16px;
  display:flex;
  flex-direction:column;
  gap:8px;
}
.bubble{
  max-width:85%;
  padding:9px 13px;
  border-radius:14px;
  font-size:15px;
  white-space:pre-wrap;
  overflow-wrap:break-word;
  word-break:break-word;
  line-height:1.45;
}
.b-model{
  align-self:flex-start;
  background:var(--surface-2);
  border-bottom-left-radius:5px;
  color:var(--text);
}
.b-user{
  align-self:flex-end;
  background:var(--accent);
  color:#fff;
  border-bottom-right-radius:5px;
}
.composer{
  display:flex;
  align-items:flex-end;
  gap:8px;
  padding:8px 10px;
  padding-bottom:max(8px,env(safe-area-inset-bottom));
  border-top:1px solid var(--border);
  background:var(--surface);
}
.composer textarea{
  flex:1;
  min-height:44px;
  max-height:140px;
  resize:none;
  padding:10px 12px;
  border-radius:14px;
  border:1px solid var(--border);
  background:var(--surface-2);
  color:var(--text);
  font:inherit;
  font-size:15px;
  line-height:1.4;
}
.composer textarea:focus{outline:none;border-color:var(--accent);}
.composer button[type=submit]{
  min-width:var(--tap);
  min-height:var(--tap);
  padding:0 16px;
  border:0;
  border-radius:14px;
  background:var(--accent);
  color:#fff;
  font:inherit;
  font-weight:600;
  font-size:15px;
  cursor:pointer;
}
.composer button[type=submit]:disabled{opacity:.55;cursor:default;}

/* ---- 文件查看 / 编辑 ---- */
.viewer{
  flex:1;
  margin:0;
  padding:14px;
  overflow:auto;
  -webkit-overflow-scrolling:touch;
  font-family:var(--mono);
  font-size:13px;
  line-height:1.55;
  white-space:pre-wrap;
  overflow-wrap:break-word;
  word-break:break-all;
  color:var(--text);
  background:var(--bg);
}
.editor-wrap{
  flex:1;
  display:flex;
  flex-direction:column;
  min-height:0;
}
.editor-wrap textarea{
  flex:1;
  margin:10px;
  padding:12px;
  border-radius:var(--radius-sm);
  border:1px solid var(--border);
  background:var(--surface-2);
  color:var(--text);
  font-family:var(--mono);
  font-size:13px;
  line-height:1.55;
  white-space:pre;
  overflow-wrap:normal;
  resize:none;
}
.editor-wrap textarea:focus{outline:none;border-color:var(--accent);}
.save-row{
  display:flex;
  justify-content:flex-end;
  gap:8px;
  padding:8px 12px;
  padding-bottom:max(8px,env(safe-area-inset-bottom));
  border-top:1px solid var(--border);
  background:var(--surface);
}
.save-row button{
  min-height:var(--tap);
  padding:0 18px;
  border:0;
  border-radius:10px;
  background:var(--accent);
  color:#fff;
  font:inherit;
  font-weight:600;
  cursor:pointer;
}

/* ---- 底部标签栏 ---- */
.tabbar{
  display:flex;
  border-top:1px solid var(--border);
  background:var(--surface);
  padding-bottom:env(safe-area-inset-bottom);
}
.tab{
  flex:1;
  appearance:none;
  background:transparent;
  border:0;
  color:var(--text-faint);
  font:inherit;
  font-size:12px;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:3px;
  min-height:56px;
  padding:6px 4px;
  cursor:pointer;
}
.tab svg{width:24px;height:24px;display:block;}
.tab.active{color:var(--accent);}
.tab.active .tab-ic{background:var(--accent-soft);}

/* ---- 401 失效遮罩 ---- */
.auth-expired{
  position:absolute;
  inset:0;
  z-index:50;
  background:rgba(8,10,14,.92);
  display:flex;
  align-items:center;
  justify-content:center;
  padding:24px;
}
.auth-expired[hidden]{display:none;}
.auth-card{
  width:100%;
  max-width:320px;
  text-align:center;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius);
  padding:28px 22px;
  display:flex;
  flex-direction:column;
  gap:14px;
}
.auth-title{font-size:18px;font-weight:600;}
.auth-desc{font-size:14px;color:var(--text-dim);}
.auth-link{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-height:var(--tap);
  padding:0 18px;
  border-radius:10px;
  background:var(--accent);
  color:#fff;
  text-decoration:none;
  font-weight:600;
}

/* ---- toast ---- */
.toast{
  position:absolute;
  left:50%;
  bottom:78px;
  transform:translateX(-50%);
  background:#000;
  color:#fff;
  padding:9px 16px;
  border-radius:8px;
  font-size:13px;
  z-index:40;
  max-width:80%;
  text-align:center;
}
.toast[hidden]{display:none;}
</style>
</head>
<body>
<div id="dsh-mobile-app">
  <header class="topbar">
    <div class="topbar-title">DSH 远程</div>
    <div class="status-pill" id="status-pill">—</div>
  </header>

  <div class="offline-banner" id="offline-banner" hidden>主机离线，将在下次操作时重试</div>

  <main class="content">
    <!-- 会话列表 -->
    <section class="pane" id="pane-sessions">
      <div class="pane-head"><span class="ph-title">会话</span></div>
      <div class="list" id="session-list" role="list"></div>
    </section>

    <!-- 聊天详情 -->
    <section class="pane" id="pane-chat" hidden>
      <div class="pane-head">
        <button type="button" class="icon-btn" id="chat-back" aria-label="返回会话列表">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <span class="ph-title" id="chat-title">会话</span>
      </div>
      <div class="chat-scroll" id="chat-events"></div>
      <form class="composer" id="composer">
        <textarea id="composer-text" placeholder="输入消息…" enterkeyhint="send" rows="1"></textarea>
        <button type="submit" id="composer-send">发送</button>
      </form>
    </section>

    <!-- 文件树 -->
    <section class="pane" id="pane-files" hidden>
      <div class="pane-head"><span class="ph-title">文件</span></div>
      <nav class="breadcrumb" id="file-breadcrumb" aria-label="路径"></nav>
      <div class="list" id="file-list" role="list"></div>
    </section>

    <!-- 文件查看 / 编辑 -->
    <section class="pane" id="pane-editor" hidden>
      <div class="pane-head">
        <button type="button" class="icon-btn" id="editor-back" aria-label="返回文件列表">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <span class="ph-title" id="editor-title">文件</span>
        <button type="button" class="icon-btn" id="editor-edit">编辑</button>
      </div>
      <pre class="viewer" id="viewer"></pre>
      <div class="editor-wrap" id="editor-wrap" hidden>
        <textarea id="editor-text" spellcheck="false" aria-label="编辑文件内容"></textarea>
        <div class="save-row">
          <button type="button" id="editor-save">保存</button>
        </div>
      </div>
    </section>
  </main>

  <nav class="tabbar" aria-label="主导航">
    <button type="button" class="tab active" data-tab="chat" id="tab-chat">
      <span class="tab-ic" style="display:inline-flex;padding:4px 14px;border-radius:999px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </span>
      <span>会话</span>
    </button>
    <button type="button" class="tab" data-tab="files" id="tab-files">
      <span class="tab-ic" style="display:inline-flex;padding:4px 14px;border-radius:999px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </span>
      <span>文件</span>
    </button>
  </nav>

  <div class="auth-expired" id="auth-expired" hidden>
    <div class="auth-card">
      <div class="auth-title">会话已失效</div>
      <div class="auth-desc">手机与中继的配对已过期，请重新配对。</div>
      <a class="auth-link" href="/pair">重新配对</a>
    </div>
  </div>

  <div class="toast" id="toast" hidden></div>
</div>

<script>
(function(){
  'use strict';

  var EP = {
    sessions: '/api/sessions',
    history:  '/api/history',
    message:  '/api/message',
    files:    '/api/files',
    file:     '/api/file'
  };

  var S = {
    tab: 'chat',
    sessionId: null,
    path: '',
    file: null,
    sending: false,
    pollTimer: null,
    pollDeadline: 0,
    lastEventCount: -1,
    lastChangeAt: 0
  };

  function $(id){ return document.getElementById(id); }
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function show(n){ if (n) n.hidden = false; }
  function hide(n){ if (n) n.hidden = true; }

  function escUrl(s){ return encodeURIComponent(String(s)); }

  /* ---- 请求封装：401/503 特判，其余统一解析 ---- */
  function request(method, url, body){
    var opts = { method: method, headers: { 'accept': 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined){
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function(r){
      if (r.status === 401){ onUnauthorized(); throw new Error('401'); }
      if (r.status === 503){ onOffline(); throw new Error('503'); }
      hideOffline();
      if (r.status >= 400){
        return r.text().catch(function(){ return ''; }).then(function(t){
          var msg;
          try { var j = JSON.parse(t); msg = j.error || j.message || t; } catch(e){ msg = t || ('HTTP ' + r.status); }
          toast('请求失败 (' + r.status + ')：' + msg);
          throw new Error(msg);
        });
      }
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') >= 0) return r.json();
      return r.text();
    });
  }

  /* ---- 全局状态提示 ---- */
  function onUnauthorized(){
    stopPoll();
    show($('auth-expired'));
  }
  function onOffline(){
    show($('offline-banner'));
    setStatus('offline');
  }
  function hideOffline(){
    hide($('offline-banner'));
    setStatus('online');
  }
  function setStatus(s){
    var p = $('status-pill');
    p.className = 'status-pill ' + s;
    p.textContent = (s === 'online') ? '在线' : (s === 'offline' ? '离线' : '—');
  }
  var toastTimer = null;
  function toast(msg){
    var t = $('toast');
    t.textContent = msg;
    show(t);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ hide(t); }, 2200);
  }

  /* ---- 标签切换 ---- */
  function switchTab(name){
    S.tab = name;
    document.querySelectorAll('.tab').forEach(function(t){
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    if (name === 'chat'){
      if (S.sessionId){ show($('pane-chat')); hide($('pane-sessions')); }
      else { show($('pane-sessions')); hide($('pane-chat')); }
      hide($('pane-files')); hide($('pane-editor'));
    } else if (name === 'files'){
      show($('pane-files')); hide($('pane-editor'));
      hide($('pane-sessions')); hide($('pane-chat'));
    }
  }
  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click', function(){ switchTab(t.getAttribute('data-tab')); });
  });

  /* ---- 会话列表 ---- */
  function loadSessions(){
    request('GET', EP.sessions).then(function(data){
      // relay wraps every data-res as HTTP 200 { ok:true, data:<host value> };
      // session/list returns { items:[...] }. Unwrap before reading items.
      var body = (data && data.data != null) ? data.data : data;
      var list = $('session-list');
      list.textContent = '';
      var items = (body && body.items) || (Array.isArray(body) ? body : []);
      if (!items.length){ list.appendChild(el('div', 'empty', '暂无会话')); return; }
      items.forEach(function(it){
        var id = (it && (it.sessionId != null || it.id != null)) ? (it.sessionId != null ? it.sessionId : it.id) : String(it);
        var title = (it && (it.title || it.id || it.sessionId)) || String(it);
        var sub = (it && it.updatedAt) ? new Date(it.updatedAt).toLocaleString() : '';
        var row = el('button', 'list-item');
        row.type = 'button';
        row.setAttribute('role', 'listitem');
        row.appendChild(iconSpan('chat'));
        var main = el('div', 'li-main');
        main.appendChild(el('span', 'li-title', String(title)));
        if (sub) main.appendChild(el('span', 'li-sub', sub));
        row.appendChild(main);
        row.addEventListener('click', function(){ openSession(String(id), String(title)); });
        list.appendChild(row);
      });
    }).catch(function(){});
  }

  /* ---- 聊天详情 ---- */
  function openSession(id, title){
    S.sessionId = id;
    stopPoll();
    $('chat-title').textContent = title || id;
    show($('pane-chat')); hide($('pane-sessions'));
    $('chat-events').textContent = '';
    request('GET', EP.history + '?sessionId=' + escUrl(id)).then(function(data){
      // relay wraps every data-res as { ok:true, data:<host value> };
      // session/page returns { records:[...], hasMore }. Each record is
      // { type:'event', event:{ type, seq, time, data, ... } } — see
      // dsh-session/lib/index.js:209 deriveEventMessage for the official
      // event → message projection we mirror in recordToMessage below.
      var body = (data && data.data != null) ? data.data : data;
      var evs = (body && body.records) || (body && body.events) || (Array.isArray(body) ? body : []);
      S.lastEventCount = evs.length;
      renderEvents(evs);
    }).catch(function(){});
  }

  function renderEvents(evs){
    var box = $('chat-events');
    box.textContent = '';
    if (!evs.length){ box.appendChild(el('div', 'empty', '暂无消息')); return; }
    evs.forEach(function(rec){
      // records are { type:'event', event:{type, seq, time, data,...} }.
      // Project to a chat bubble only for message-bearing events; skip
      // tool/step/turn/compaction etc. (mirrors deriveEventMessage).
      var msg = recordToMessage(rec);
      if (msg == null) return;
      var b = el('div', 'bubble ' + (msg.role === 'user' ? 'b-user' : 'b-model'));
      b.textContent = msg.text;
      box.appendChild(b);
    });
    box.scrollTop = box.scrollHeight;
  }

  /* Map one session/page record to a {role,text} chat message or null.
   * Mirrors dsh-session deriveEventMessage + content-text extraction; returns
   * null for non-message events (filtered out of the chat view). */
  function recordToMessage(rec){
    if (rec == null || typeof rec !== 'object') return null;
    // records are { type:'event', event }; be lenient for raw event shapes.
    var ev = rec.event || rec;
    if (ev == null || typeof ev !== 'object') return null;
    var type = ev.type;
    if (typeof type !== 'string') return null;
    var data = ev.data;
    if (type === 'user/message'){
      return { role: 'user', text: extractMessageText(data) };
    }
    if (type === 'assistant/message' || type === 'system/message'){
      var m = data && data.message;
      if (m && m.content && m.content.length === 0) return null;
      return { role: type === 'system/message' ? 'model' : 'model', text: extractMessageText(m) };
    }
    if (type === 'tool/result'){
      return { role: 'model', text: extractMessageText(data && data.message) };
    }
    return null;
  }

  /* Concatenate the text blocks of a dsh message's content[].
   * 'message' may be the raw content array, or { content: [...] }, or a
   * bare string; lenient in either direction. */
  function extractMessageText(message){
    if (message == null) return '';
    if (typeof message === 'string') return message;
    var content = Array.isArray(message) ? message : message.content;
    if (!Array.isArray(content)) return JSON.stringify(message);
    var parts = [];
    for (var i = 0; i < content.length; i++){
      var b = content[i];
      if (b == null) continue;
      if (typeof b === 'string') { parts.push(b); continue; }
      if (typeof b === 'object'){
        if (typeof b.text === 'string') parts.push(b.text);
        else if (typeof b.content === 'string') parts.push(b.content);
        else parts.push(JSON.stringify(b));
      }
    }
    return parts.join('');
  }

  function setSending(v){
    S.sending = v;
    var btn = $('composer-send');
    var ta = $('composer-text');
    if (v){ btn.disabled = true; btn.textContent = '发送中…'; ta.disabled = true; }
    else { btn.disabled = false; btn.textContent = '发送'; ta.disabled = false; }
  }

  function sendMessage(id, text){
    setSending(true);
    request('POST', EP.message, { sessionId: id, text: text }).then(function(data){
      if (data && data.ok){
        $('composer-text').value = '';
        startPoll(id);
      } else {
        toast('发送失败');
      }
    }).catch(function(){ /* 401/503/网络已处理 */ })
    .then(function(){ setSending(false); }, function(){ setSending(false); });
  }

  /* ---- 模型输出轮询：每 2s 拉一次，最长 60s；~6s 无新事件提前停 ---- */
  function startPoll(id){
    stopPoll();
    S.pollDeadline = Date.now() + 60000;
    S.lastChangeAt = Date.now();
    pollTick(id);
    S.pollTimer = setInterval(function(){ pollTick(id); }, 2000);
  }
  function stopPoll(){
    if (S.pollTimer){ clearInterval(S.pollTimer); S.pollTimer = null; }
  }
  function pollTick(id){
    if (Date.now() > S.pollDeadline){ stopPoll(); return; }
    request('GET', EP.history + '?sessionId=' + escUrl(id)).then(function(data){
      var body = (data && data.data != null) ? data.data : data;
      var evs = (body && body.records) || (body && body.events) || (Array.isArray(body) ? body : []);
      renderEvents(evs);
      if (evs.length !== S.lastEventCount){
        S.lastEventCount = evs.length;
        S.lastChangeAt = Date.now();
      }
      if (Date.now() - S.lastChangeAt > 6000){ stopPoll(); return; }
      if (Date.now() > S.pollDeadline){ stopPoll(); return; }
    }).catch(function(){ /* 401/503 已处理；瞬时错误忽略，下个 tick 重试 */ });
  }

  /* ---- 文件树 ---- */
  function loadFiles(path){
    S.path = path || '';
    var url = EP.files + (S.path ? ('?path=' + escUrl(S.path)) : '');
    request('GET', url).then(function(data){
      // relay wraps every data-res as { ok:true, data:<host value> };
      // file-list returns the listDir array directly (no items/entries
      // wrapper). Unwrap before falling back to legacy shapes.
      var body = (data && data.data != null) ? data.data : data;
      var arr = Array.isArray(body) ? body
              : (body && body.items) || (body && body.entries) || [];
      renderBreadcrumb(S.path);
      renderFileList(arr, S.path);
    }).catch(function(){});
  }

  function renderBreadcrumb(path){
    var bc = $('file-breadcrumb');
    bc.textContent = '';
    var root = el('button', 'crumb', '根');
    root.type = 'button';
    root.addEventListener('click', function(){ loadFiles(''); });
    bc.appendChild(root);
    if (path){
      var segs = path.split('/').filter(function(s){ return !!s; });
      var acc = '';
      segs.forEach(function(s, i){
        acc = acc ? (acc + '/' + s) : s;
        bc.appendChild(el('span', 'crumb-sep', '/'));
        if (i === segs.length - 1){
          bc.appendChild(el('span', 'crumb cur', s));
        } else {
          var p = acc;
          var b = el('button', 'crumb', s);
          b.type = 'button';
          b.addEventListener('click', function(){ loadFiles(p); });
          bc.appendChild(b);
        }
      });
      var up = el('button', 'crumb crumb-up', '..');
      up.type = 'button';
      up.addEventListener('click', function(){
        var parts = path.split('/').filter(function(s){ return !!s; });
        parts.pop();
        loadFiles(parts.join('/'));
      });
      bc.appendChild(up);
    }
  }

  function renderFileList(arr, path){
    var list = $('file-list');
    list.textContent = '';
    if (!arr.length){ list.appendChild(el('div', 'empty', '空目录')); return; }
    arr.forEach(function(entry){
      var name = (entry && entry.name != null) ? entry.name : String(entry);
      var isDir = !!(entry && (entry.dir === true || entry.isDirectory === true ||
        entry.type === 'dir' || entry.type === 'directory'));
      var row = el('button', 'list-item');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.appendChild(iconSpan(isDir ? 'folder' : 'file'));
      row.appendChild(el('span', 'li-title', String(name)));
      row.addEventListener('click', function(){
        var full = path ? (path + '/' + name) : name;
        if (isDir){ loadFiles(full); } else { openFile(full, String(name)); }
      });
      list.appendChild(row);
    });
  }

  /* ---- 文件查看 / 编辑 ---- */
  function openFile(path, name){
    S.file = { path: path, content: '' };
    show($('pane-editor')); hide($('pane-files'));
    hide($('editor-wrap')); show($('viewer'));
    $('editor-title').textContent = name || path;
    $('viewer').textContent = '加载中…';
    request('GET', EP.file + '?path=' + escUrl(path)).then(function(data){
      // relay wraps file-read result as { ok:true, data:<text string> }.
      // Unwrap before checking legacy content/text fields.
      var body = (data && data.data != null) ? data.data : data;
      var content = '';
      if (typeof body === 'string') content = body;
      else if (body && body.content != null) content = String(body.content);
      else if (body && body.text != null) content = String(body.text);
      S.file = { path: path, content: content };
      $('viewer').textContent = content;
    }).catch(function(){ $('viewer').textContent = '加载失败'; });
  }

  /* ---- 图标（静态 SVG，无 host 数据） ---- */
  function iconSpan(kind){
    var span = document.createElement('span');
    span.className = 'li-ic';
    var svg = '';
    if (kind === 'folder'){
      svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    } else if (kind === 'file'){
      svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
    } else {
      svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    }
    span.innerHTML = svg;
    return span;
  }

  /* ---- 事件绑定 ---- */
  $('chat-back').addEventListener('click', function(){
    stopPoll();
    S.sessionId = null;
    show($('pane-sessions')); hide($('pane-chat'));
  });

  $('composer').addEventListener('submit', function(e){
    e.preventDefault();
    if (!S.sessionId || S.sending) return;
    var text = $('composer-text').value;
    if (!text || !text.trim()) return;
    sendMessage(S.sessionId, text);
  });

  $('composer-text').addEventListener('input', function(){
    var ta = this;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });

  $('editor-edit').addEventListener('click', function(){
    if (!S.file) return;
    hide($('viewer')); show($('editor-wrap'));
    $('editor-text').value = S.file.content || '';
    $('editor-text').focus();
  });

  $('editor-save').addEventListener('click', function(){
    if (!S.file) return;
    var content = $('editor-text').value;
    var path = S.file.path;
    var btn = $('editor-save');
    btn.disabled = true; btn.textContent = '保存中…';
    request('PUT', EP.file, { path: path, content: content }).then(function(data){
      if (data && data.ok){
        S.file.content = content;
        toast('已保存');
        $('viewer').textContent = content;
        hide($('editor-wrap')); show($('viewer'));
      } else {
        toast('保存失败');
      }
    }).catch(function(){ /* 401/503/网络已处理 */ })
    .then(function(){ btn.disabled = false; btn.textContent = '保存'; }, function(){ btn.disabled = false; btn.textContent = '保存'; });
  });

  $('editor-back').addEventListener('click', function(){
    hide($('pane-editor')); show($('pane-files'));
  });

  /* ---- 初始化 ---- */
  setStatus('online');
  switchTab('chat');
  loadSessions();
  loadFiles('');
})();
</script>
</body>
</html>`
}

/* app.js — モバイルアプリのロジック */
(function () {
  'use strict';

  var GAS_URL = (window.KAKEIBO_CONFIG || {}).GAS_URL || '';
  var TOKEN_KEY = 'kakeibo_token';
  var pendingFiles = [];

  var el = function (id) { return document.getElementById(id); };
  var yen = function (n) { return '¥' + (Math.round(Number(n) || 0)).toLocaleString('ja-JP'); };

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }

  // ===== API =====
  function apiGet(action, params) {
    var url = GAS_URL + '?action=' + encodeURIComponent(action) + '&token=' + encodeURIComponent(getToken());
    if (params) for (var k in params) url += '&' + k + '=' + encodeURIComponent(params[k]);
    return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); });
  }
  function apiPost(payload) {
    payload.token = getToken();
    // text/plain にしてCORSプリフライトを回避
    return fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  // ===== 合言葉 =====
  function ensureAuth() {
    if (getToken()) { el('authView').classList.add('hidden'); return true; }
    el('authView').classList.remove('hidden');
    return false;
  }

  el('saveTokenBtn').addEventListener('click', function () {
    var t = el('tokenInput').value.trim();
    if (!t) { el('authError').textContent = '合言葉を入力してください'; return; }
    setToken(t);
    // ping で検証
    apiGet('ping').then(function (res) {
      if (res && res.ok) { el('authView').classList.add('hidden'); loadSummary(); }
      else { localStorage.removeItem(TOKEN_KEY); el('authError').textContent = '合言葉が違うようです'; }
    }).catch(function () {
      el('authError').textContent = '接続できません。URL設定を確認してください';
    });
  });

  // ===== ファイル選択・プレビュー =====
  el('fileInput').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    files.forEach(function (f) { pendingFiles.push(f); });
    renderPreviews();
  });

  function renderPreviews() {
    var box = el('previewList');
    box.innerHTML = '';
    pendingFiles.forEach(function (f) {
      var img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      box.appendChild(img);
    });
    el('uploadBtn').disabled = pendingFiles.length === 0;
  }

  // ===== アップロード =====
  el('uploadBtn').addEventListener('click', function () {
    if (!pendingFiles.length) return;
    var btn = el('uploadBtn');
    btn.disabled = true;
    var status = el('uploadStatus');
    status.className = 'status';
    status.textContent = 'アップロード中… 0/' + pendingFiles.length;

    var queue = pendingFiles.slice();
    var done = 0, errors = 0;

    function next() {
      if (!queue.length) {
        status.className = 'status ' + (errors ? 'err' : 'ok');
        status.textContent = errors
          ? (done + '件成功 / ' + errors + '件失敗')
          : (done + '件アップロード完了。22:30に反映されます。');
        pendingFiles = [];
        renderPreviews();
        return;
      }
      var f = queue.shift();
      toBase64(f).then(function (b64) {
        return apiPost({ action: 'upload', filename: f.name, mimeType: f.type || 'image/jpeg', dataBase64: b64 });
      }).then(function (res) {
        if (res && res.ok) done++; else errors++;
        status.textContent = 'アップロード中… ' + (done + errors) + '/' + (done + errors + queue.length);
        next();
      }).catch(function () { errors++; next(); });
    }
    next();
  });

  function toBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = reader.result;
        var comma = s.indexOf(',');
        resolve(comma >= 0 ? s.substring(comma + 1) : s);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ===== サマリ =====
  function loadSummary() {
    apiGet('summary').then(function (s) {
      if (!s || s.error) { el('recentList').innerHTML = '<li class="muted">取得できません</li>'; return; }
      el('summaryMonth').textContent = (s.month || '今月') + ' のサマリ';
      el('summaryUpdated').textContent = s.generated_at ? ('更新 ' + s.generated_at.substring(5, 16).replace('T', ' ')) : '';
      var t = s.totals || {};
      el('totalAll').textContent = yen(t.all);
      el('totalDaily').textContent = yen(t.daily);
      el('totalExtra').textContent = yen(t.extraordinary);

      var rb = el('reviewBadge');
      if (s.needs_review_count > 0) {
        rb.classList.remove('hidden');
        rb.textContent = '⚠ 要確認の取引が ' + s.needs_review_count + ' 件あります（ダッシュボードで修正できます）';
      } else { rb.classList.add('hidden'); }

      var list = el('recentList');
      var recent = s.recent || [];
      if (!recent.length) { list.innerHTML = '<li class="muted">まだ取引がありません</li>'; return; }
      list.innerHTML = '';
      recent.forEach(function (r) {
        var li = document.createElement('li');
        var tag = r.status === '要確認'
          ? '<span class="tag review">要確認</span>'
          : '<span class="tag ' + (r.expense_type === '臨時' ? 'extra' : 'daily') + '">' + (r.expense_type || '') + '</span>';
        li.innerHTML = '<span class="r-store">' + escapeHtml(r.store || '(店名不明)') + tag + '</span>'
          + '<span class="r-amt">' + yen(r.total) + '</span>';
        list.appendChild(li);
      });
    }).catch(function () {
      el('recentList').innerHTML = '<li class="muted">接続エラー</li>';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  el('reloadBtn').addEventListener('click', loadSummary);

  // ===== 初期化 =====
  if (!GAS_URL || GAS_URL.indexOf('<<') === 0) {
    el('uploadStatus').textContent = 'config.js に GAS_URL を設定してください';
  }
  if (ensureAuth()) loadSummary();
})();

/* app.js — モバイルアプリのロジック（随時処理・読み取り結果のタブ表示） */
(function () {
  'use strict';

  var CFG = window.KAKEIBO_CONFIG || {};
  var GAS_URL = CFG.GAS_URL || '';
  var WEB_URL = CFG.WEB_URL || '';
  var TOKEN_KEY = 'kakeibo_token';
  var pendingFiles = [];
  var recentData = [];   // 直近3件のレシート
  var activeTab = 0;

  var el = function (id) { return document.getElementById(id); };
  var yen = function (n) { return '¥' + (Math.round(Number(n) || 0)).toLocaleString('ja-JP'); };

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }

  function currentMonth() {
    var d = new Date();
    var m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }

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
    apiGet('ping').then(function (res) {
      if (res && res.ok) { el('authView').classList.add('hidden'); loadRecent(); }
      else { localStorage.removeItem(TOKEN_KEY); el('authError').textContent = '合言葉が違うようです'; }
    }).catch(function () {
      el('authError').textContent = '接続できません。URL設定を確認してください';
    });
  });

  // ===== ファイル選択・プレビュー（撮影 / ギャラリー選択の両対応） =====
  function onPick(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    files.forEach(function (f) { pendingFiles.push(f); });
    e.target.value = ''; // 同じファイルを続けて選べるようにリセット
    renderPreviews();
  }
  el('cameraInput').addEventListener('change', onPick);
  el('fileInput').addEventListener('change', onPick);

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

  // ===== アップロード（都度OCR・読み取り状況を即表示） =====
  el('uploadBtn').addEventListener('click', function () {
    if (!pendingFiles.length) return;
    el('uploadBtn').disabled = true;
    var status = el('uploadStatus');
    status.className = 'status';
    var total = pendingFiles.length;

    // 進捗リストを結果エリアに表示（撮った写真が読めているか一目で分かるように）
    el('recentTabs').innerHTML = '';
    var panel = el('recentPanel');
    panel.innerHTML = '';
    var progress = document.createElement('ul');
    progress.className = 'progress-list';
    panel.appendChild(progress);

    var rows = pendingFiles.map(function (f) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="p-name">' + escapeHtml(f.name || 'レシート') + '</span>'
        + '<span class="p-state"><span class="spinner"></span>読み取り中…</span>';
      progress.appendChild(li);
      return li;
    });

    var queue = pendingFiles.map(function (f, i) { return { file: f, row: rows[i] }; });
    var done = 0, errors = 0, review = 0, dup = 0, idx = 0;

    function setRow(row, cls, text) {
      row.querySelector('.p-state').innerHTML = '<span class="dot ' + cls + '"></span>' + escapeHtml(text);
    }

    function finish() {
      var parts = [done + '件取り込み'];
      if (review) parts.push('要確認' + review + '件');
      if (dup) parts.push('重複' + dup + '件');
      if (errors) parts.push('失敗' + errors + '件');
      status.className = 'status ' + (errors ? 'err' : 'ok');
      status.textContent = parts.join(' / ');
      pendingFiles = [];
      renderPreviews();
      loadRecent(); // サーバから直近3件を取り直してタブ表示に戻す
    }

    function step() {
      if (!queue.length) { finish(); return; }
      var item = queue.shift();
      idx++;
      status.textContent = '読み取り中… ' + idx + '/' + total;
      toBase64(item.file).then(function (b64) {
        return apiPost({ action: 'upload', filename: item.file.name, mimeType: item.file.type || 'image/jpeg', dataBase64: b64 });
      }).then(function (res) {
        if (res && res.ok) {
          done++;
          var t = res.transaction || {};
          if (res.duplicate) { dup++; setRow(item.row, 'review', '重複（取込済み）'); }
          else if (t.status === '要確認') { review++; setRow(item.row, 'review', '要確認 ' + escapeHtml(t.store || '') + ' ' + yen(t.total)); }
          else { setRow(item.row, 'ok', (escapeHtml(t.store || '(店名不明)')) + ' ' + yen(t.total)); }
        } else {
          errors++;
          setRow(item.row, 'err', '失敗: ' + escapeHtml((res && res.error) || '読み取れませんでした'));
        }
        step();
      }).catch(function () {
        errors++;
        setRow(item.row, 'err', '通信エラー');
        step();
      });
    }
    step();
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

  // ===== 直近3レシートのタブ表示 =====
  function loadRecent() {
    var panel = el('recentPanel');
    apiGet('transactions', { month: currentMonth() }).then(function (res) {
      if (!res || res.error) { el('recentTabs').innerHTML = ''; panel.innerHTML = '<p class="muted">取得できませんでした</p>'; return; }
      var list = (res.transactions || []).slice().sort(function (a, b) {
        return (b.scanned_at || '').localeCompare(a.scanned_at || '');
      }).slice(0, 3);
      recentData = list;
      activeTab = 0;
      renderTabs();
    }).catch(function () {
      el('recentTabs').innerHTML = '';
      panel.innerHTML = '<p class="muted">接続エラー</p>';
    });
  }

  function renderTabs() {
    var tabs = el('recentTabs');
    var panel = el('recentPanel');
    tabs.innerHTML = '';
    if (!recentData.length) {
      panel.innerHTML = '<p class="muted">まだレシートがありません。写真をアップロードすると、ここに読み取り結果が出ます。</p>';
      return;
    }
    recentData.forEach(function (t, i) {
      var b = document.createElement('button');
      b.className = 'tab' + (i === activeTab ? ' active' : '');
      var label = (t.store || '(店名不明)');
      if (label.length > 8) label = label.substring(0, 8) + '…';
      b.innerHTML = escapeHtml(label) + (t.status === '要確認' ? ' <span class="tab-flag">要確認</span>' : '');
      b.addEventListener('click', function () { activeTab = i; renderTabs(); });
      tabs.appendChild(b);
    });
    panel.innerHTML = receiptDetailHtml(recentData[activeTab]);
  }

  function receiptDetailHtml(t) {
    if (!t) return '';
    var statusTag = t.status === '要確認'
      ? '<span class="tag review">要確認</span>'
      : '<span class="tag ' + (t.expense_type === '臨時' ? 'extra' : 'daily') + '">' + escapeHtml(t.expense_type || '確定') + '</span>';
    var head = ''
      + '<div class="rc-head">'
      + '  <div class="rc-store">' + escapeHtml(t.store || '(店名不明)') + statusTag + '</div>'
      + '  <div class="rc-total">' + yen(t.total) + '</div>'
      + '</div>'
      + '<div class="rc-meta muted small">'
      + escapeHtml(t.purchase_date || '日付不明')
      + (t.purchase_time ? ' ' + escapeHtml(t.purchase_time) : '')
      + '　/　' + escapeHtml(t.category || '')
      + (t.confidence != null ? '　/　確度 ' + Math.round(t.confidence * 100) + '%' : '')
      + '</div>';

    var items = t.items || [];
    var body;
    if (items.length) {
      var rows = items.map(function (it) {
        var q = (it.qty != null && it.qty !== '') ? ' ×' + it.qty : '';
        return '<li><span class="i-name">' + escapeHtml(it.name || '') + escapeHtml(q) + '</span>'
          + '<span class="i-price">' + (it.price != null ? yen(it.price) : '—') + '</span></li>';
      }).join('');
      body = '<ul class="item-list">' + rows + '</ul>';
    } else {
      body = '<p class="muted small">品目明細なし（総額のみ）</p>';
    }
    return head + body;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ===== 下スワイプで更新（pull-to-refresh） =====
  (function setupPullToRefresh() {
    var ptr = el('ptr');
    var ptrText = el('ptrText');
    var startY = 0, pulling = false, dist = 0;
    var THRESHOLD = 70;

    document.addEventListener('touchstart', function (e) {
      if (window.scrollY <= 0 && e.touches.length === 1) {
        startY = e.touches[0].clientY; pulling = true; dist = 0;
      } else { pulling = false; }
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0 && window.scrollY <= 0) {
        var h = Math.min(dist, 90);
        ptr.style.height = h + 'px';
        ptr.classList.add('visible');
        ptrText.textContent = dist > THRESHOLD ? '離して更新' : '下に引いて更新';
      }
    }, { passive: true });

    document.addEventListener('touchend', function () {
      if (!pulling) return;
      pulling = false;
      if (dist > THRESHOLD) {
        ptrText.textContent = '更新中…';
        ptr.style.height = '36px';
        loadRecent();
        setTimeout(resetPtr, 600);
      } else {
        resetPtr();
      }
    });

    function resetPtr() {
      ptr.classList.remove('visible');
      ptr.style.height = '0px';
      ptrText.textContent = '下に引いて更新';
    }
  })();

  // ===== 初期化 =====
  if (WEB_URL) el('webLink').setAttribute('href', WEB_URL);

  if (!GAS_URL || GAS_URL.indexOf('<<') === 0) {
    el('uploadStatus').textContent = 'config.js に GAS_URL を設定してください';
  }
  if (ensureAuth()) loadRecent();
})();

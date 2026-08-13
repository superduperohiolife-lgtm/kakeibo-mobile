/* app.js — 写真で家計簿（スマホ版）
 *
 * 3タブ構成:
 *   １．撮る … 撮影とアップロードに特化。結果は 可否＋店名＋金額 だけ。要確認は「直す」へ誘導
 *   ２．直す … 要確認の修正（月をまたいで全件）と直近の読み取り。明細は手入力で編集できる
 *   ３．見る … 集計と分類のみ。要確認の個別リストは出さない（件数はタブのバッジ）
 *
 * 明細の帳尻はサーバ側（Ocr.gs / reconcileItems_）が持つ。
 * 画面から送るのは実明細だけで、「消費税」「不明分」の行はサーバが作り直す。
 */
(function () {
  'use strict';

  var CFG = window.KAKEIBO_CONFIG || {};
  var GAS_URL = CFG.GAS_URL || '';
  var TOKEN_KEY = 'kakeibo_token';

  var DAILY_CATS = ['ライフライン', '食費', '日用品', '衣料・服飾', '外食', '交通', '医療・健康', '行政手数料', '雑費'];
  var EXTRA_CATS = ['家電', '家具・インテリア', '調理・食器', '生活用品（大型）', '自転車・乗り物', '旅行・レジャー', '車関連', '住宅・修繕', '冠婚葬祭', '医療・税金・保険（高額/年払い）', 'その他臨時'];
  var ALL_CATS = DAILY_CATS.concat(EXTRA_CATS);

  var pendingFiles = [];
  var activeView = 'captureView';
  var fixSeg = 'review';
  var reviewData = [];
  var recentData = [];
  var selMonth = currentMonth();
  var loaded = { fix: false, see: false };

  var el = function (id) { return document.getElementById(id); };
  var yen = function (n) { return '¥' + (Math.round(Number(n) || 0)).toLocaleString('ja-JP'); };
  /** 明細行用。マイナス（値引き・不明分の超過）を「−¥1,270」の形で出す */
  var yenSigned = function (n) {
    var v = Math.round(Number(n) || 0);
    return (v < 0 ? '−' : '') + '¥' + Math.abs(v).toLocaleString('ja-JP');
  };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function currentMonth() {
    var d = new Date(), m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }
  function addMonth(ym, delta) {
    var p = ym.split('-'), d = new Date(+p[0], +p[1] - 1 + delta, 1), m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }
  function monthJa(ym) {
    var p = (ym || '').split('-');
    return p.length === 2 ? (p[0] + '年' + (+p[1]) + '月') : (ym || '—');
  }
  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var hh = ('0' + d.getHours()).slice(-2), mi = ('0' + d.getMinutes()).slice(-2);
    return '更新 ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mi;
  }

  // ===== 要確認の理由表示 =====
  function reviewText(t) {
    if (!t || t.status !== '要確認') return '';
    if (t.review_summary) return t.review_summary;
    if (t.review_reasons && t.review_reasons.length) {
      return t.review_reasons.map(function (r) {
        return (r.label || r.code || '') + (r.detail ? ' ' + r.detail : '');
      }).join(' / ');
    }
    return '内容を確認してください';
  }
  function reviewNoteHtml(t) {
    if (!t || t.status !== '要確認') return '';
    var rs = t.review_reasons || [];
    if (!rs.length) return '<div class="review-note"><b>要確認</b>　' + escapeHtml(reviewText(t)) + '</div>';
    return '<div class="review-note"><ul>' + rs.map(function (r) {
      var head = escapeHtml((r.label || r.code || '') + (r.detail ? ' ' + r.detail : ''));
      return '<li><b>' + head + '</b>' + (r.hint ? '<span class="hint-line">' + escapeHtml(r.hint) + '</span>' : '') + '</li>';
    }).join('') + '</ul></div>';
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
  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

  // ===== 合言葉 =====
  function ensureAuth() {
    if (getToken()) { el('authView').classList.add('hidden'); showChrome(true); return true; }
    el('authView').classList.remove('hidden');
    showChrome(false);
    return false;
  }
  function showChrome(on) {
    el('bottomNav').classList.toggle('hidden', !on);
    ['captureView', 'fixView', 'seeView'].forEach(function (v) {
      el(v).classList.toggle('hidden', !on || activeView !== v);
    });
  }
  el('saveTokenBtn').addEventListener('click', function () {
    var t = el('tokenInput').value.trim();
    if (!t) { el('authError').textContent = '合言葉を入力してください'; return; }
    localStorage.setItem(TOKEN_KEY, t);
    apiGet('ping').then(function (res) {
      if (res && res.ok) { el('authView').classList.add('hidden'); showChrome(true); refreshBadge(); }
      else { localStorage.removeItem(TOKEN_KEY); el('authError').textContent = '合言葉が違うようです'; }
    }).catch(function () { el('authError').textContent = '接続できません。URL設定を確認してください'; });
  });

  // ===== タブ =====
  Array.prototype.forEach.call(document.querySelectorAll('.nav-tab'), function (btn) {
    btn.addEventListener('click', function () { switchView(btn.getAttribute('data-target')); });
  });
  function switchView(target) {
    activeView = target;
    Array.prototype.forEach.call(document.querySelectorAll('.nav-tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-target') === target);
    });
    ['captureView', 'fixView', 'seeView'].forEach(function (v) { el(v).classList.toggle('hidden', v !== target); });
    el('appTitle').textContent = target === 'fixView' ? '直す' : (target === 'seeView' ? '見る' : '写真で家計簿');
    window.scrollTo(0, 0);
    if (target === 'fixView' && !loaded.fix) loadFix();
    if (target === 'seeView' && !loaded.see) loadSee();
  }

  // ===================================================================
  // １．撮る
  // ===================================================================
  function onPick(e) {
    Array.prototype.slice.call(e.target.files || []).forEach(function (f) { pendingFiles.push(f); });
    e.target.value = '';
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

  el('uploadBtn').addEventListener('click', function () {
    if (!pendingFiles.length) return;
    el('uploadBtn').disabled = true;
    el('shotSummary').classList.add('hidden');

    var list = el('shotList');
    list.innerHTML = '';
    var rows = pendingFiles.map(function (f) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="spinner-line"><span class="spinner"></span>読み取り中… ' + escapeHtml(f.name || 'レシート') + '</div>';
      list.appendChild(li);
      return li;
    });

    var queue = pendingFiles.map(function (f, i) { return { file: f, row: rows[i] }; });
    var done = 0, errors = 0, review = 0, dup = 0;

    function paint(row, mark, name, amount, why) {
      var html = '<div class="line"><span class="mark">' + mark + '</span>'
        + '<span class="name">' + escapeHtml(name) + '</span>'
        + (amount != null ? '<span class="amt">' + yen(amount) + '</span>' : '') + '</div>';
      if (why) {
        html += '<div class="why">' + escapeHtml(why) + '</div>'
          + '<div class="go"><button class="ghost mini" data-go-fix="1">直すで確認 ›</button></div>';
      }
      row.innerHTML = html;
      var b = row.querySelector('[data-go-fix]');
      if (b) b.addEventListener('click', function () { switchView('fixView'); loadFix(); });
    }

    function finish() {
      var parts = [];
      parts.push('<span class="ok">' + done + '件 取り込み</span>');
      if (review) parts.push('<span class="ng">要確認 ' + review + '件</span>');
      if (dup) parts.push('<span class="ng">重複 ' + dup + '件</span>');
      if (errors) parts.push('<span class="err">失敗 ' + errors + '件</span>');
      var s = el('shotSummary');
      s.innerHTML = parts.join('');
      s.classList.remove('hidden');
      pendingFiles = [];
      renderPreviews();
      loaded.fix = false; loaded.see = false;   // 次に開くとき取り直す
      refreshBadge();
    }

    function step() {
      if (!queue.length) { finish(); return; }
      var item = queue.shift();
      toBase64(item.file).then(function (b64) {
        return apiPost({ action: 'upload', filename: item.file.name, mimeType: item.file.type || 'image/jpeg', dataBase64: b64 });
      }).then(function (res) {
        if (res && res.ok) {
          var t = res.transaction || {};
          if (res.duplicate) { dup++; paint(item.row, '⚠️', (t.store || 'レシート') + '（取込済み）', t.total, '同じレシートが既にあります'); }
          else if (t.status === '要確認') { done++; review++; paint(item.row, '⚠️', t.store || '(店名不明)', t.total, reviewText(t)); }
          else { done++; paint(item.row, '✅', t.store || '(店名不明)', t.total, ''); }
        } else {
          errors++;
          paint(item.row, '⛔', '読み取れませんでした', null, (res && res.error) || '');
        }
        step();
      }).catch(function () {
        errors++;
        paint(item.row, '⛔', '通信エラー', null, '');
        step();
      });
    }
    step();
  });

  function toBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = reader.result, comma = s.indexOf(',');
        resolve(comma >= 0 ? s.substring(comma + 1) : s);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ===================================================================
  // ２．直す
  // ===================================================================
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () { setSeg(b.getAttribute('data-seg')); });
  });
  function setSeg(seg) {
    fixSeg = seg;
    el('segReview').classList.toggle('on', seg === 'review');
    el('segRecent').classList.toggle('on', seg === 'recent');
    el('reviewCard').classList.toggle('hidden', seg !== 'review');
    el('recentCard').classList.toggle('hidden', seg !== 'recent');
  }

  function loadFix() {
    loaded.fix = true;
    el('reviewList').innerHTML = '<li class="muted small">読み込み中…</li>';
    el('recentList').innerHTML = '<li class="muted small">読み込み中…</li>';

    apiGet('reviews').then(function (res) {
      reviewData = (res && res.transactions) || [];
      renderReviewList();
      setBadge(reviewData.length);
    }).catch(function () { el('reviewList').innerHTML = '<li class="muted small">接続エラー</li>'; });

    apiGet('transactions', { month: currentMonth() }).then(function (res) {
      var list = ((res && res.transactions) || []).slice().sort(function (a, b) {
        return String(b.scanned_at || '').localeCompare(String(a.scanned_at || ''));
      }).slice(0, 10);
      recentData = list.map(function (t) { t.month = res.month; return t; });
      renderRecentList();
    }).catch(function () { el('recentList').innerHTML = '<li class="muted small">接続エラー</li>'; });
  }

  function renderReviewList() {
    el('reviewCount').textContent = reviewData.length ? reviewData.length + '件' : '';
    var ul = el('reviewList');
    ul.innerHTML = '';
    if (!reviewData.length) {
      ul.innerHTML = '<li class="muted small">要確認はありません。</li>';
      return;
    }
    reviewData.forEach(function (t, i) {
      ul.appendChild(txRow(t, reviewText(t), 'review', i));
    });
  }
  function renderRecentList() {
    var ul = el('recentList');
    ul.innerHTML = '';
    if (!recentData.length) { ul.innerHTML = '<li class="muted small">まだ取引がありません。</li>'; return; }
    recentData.forEach(function (t, i) {
      ul.appendChild(txRow(t, '', 'recent', i));
    });
  }
  function txRow(t, why, src, idx) {
    var li = document.createElement('li');
    var tag = t.status === '要確認'
      ? '<span class="tag review">要確認</span>'
      : '<span class="tag ok">' + escapeHtml(t.expense_type || '確定') + '</span>';
    li.innerHTML = '<div class="main">'
      + '<div class="store">' + escapeHtml(t.store || '(店名不明)') + (src === 'recent' ? tag : '') + '</div>'
      + (why ? '<div class="why">' + escapeHtml(why) + '</div>' : '')
      + '<div class="sub">' + escapeHtml((t.purchase_date || '日付不明').replace(/^\d{4}-/, '')) + '　' + escapeHtml(t.category || '') + '</div>'
      + '</div>'
      + '<div class="amt">' + yen(t.total) + '</div><div class="chev">›</div>';
    li.addEventListener('click', function () { openSheet(src, idx); });
    return li;
  }

  // ===== 修正シート =====
  var cur = null, curSrc = null, curIdx = -1;

  function openSheet(src, idx) {
    var t = (src === 'review' ? reviewData : recentData)[idx];
    if (!t) return;
    curSrc = src; curIdx = idx;
    // 実明細だけを編集対象にする（消費税・不明分はサーバが作り直す）
    cur = {
      id: t.id, month: t.month || currentMonth(),
      store: t.store || '', purchase_date: t.purchase_date || '',
      total: (typeof t.total === 'number') ? t.total : 0,
      tax: (typeof t.tax === 'number') ? t.tax : 0,
      expense_type: t.expense_type === '臨時' ? '臨時' : '日常',
      category: t.category || '雑費',
      status: t.status || '確定',
      note: reviewNoteHtml(t),
      original_currency: t.original_currency, original_total: t.original_total, fx_rate: t.fx_rate,
      items: (t.items || []).filter(function (i) { return !i.auto; })
        .map(function (i) { return { name: i.name || '', price: Number(i.price) || 0 }; })
    };
    el('sheetBody').innerHTML = sheetHtml(cur);
    bindSheet();
    renderItems();
    el('sheet').classList.remove('hidden');
    el('sheetBg').classList.remove('hidden');
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    el('sheet').classList.add('hidden');
    el('sheetBg').classList.add('hidden');
    document.body.classList.remove('sheet-open');
    cur = null;
  }
  el('sheetCancel').addEventListener('click', closeSheet);
  el('sheetBg').addEventListener('click', closeSheet);

  function sheetHtml(t) {
    var cats = ALL_CATS.map(function (c) {
      return '<option' + (c === t.category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    }).join('');
    var fx = (t.original_currency && t.original_currency !== 'JPY')
      ? '<p class="muted xsmall" style="margin:-4px 0 8px">元通貨 ' + escapeHtml(t.original_currency) + ' ' + t.original_total + '（レート ' + t.fx_rate + ' で換算）</p>' : '';
    return t.note
      + '<label class="fld">店名</label><input id="f_store" type="text" value="' + escapeHtml(t.store) + '">'
      + '<div class="fld-row">'
      + '  <div><label class="fld">日付</label><input id="f_date" type="date" value="' + escapeHtml(t.purchase_date) + '"></div>'
      + '  <div><label class="fld">金額（円）</label><input id="f_total" type="number" inputmode="numeric" value="' + t.total + '"></div>'
      + '</div>' + fx
      + '<div class="fld-row">'
      + '  <div><label class="fld">区分</label><select id="f_type"><option' + (t.expense_type === '日常' ? ' selected' : '') + '>日常</option><option' + (t.expense_type === '臨時' ? ' selected' : '') + '>臨時</option></select></div>'
      + '  <div><label class="fld">状態</label><select id="f_status"><option' + (t.status === '確定' ? ' selected' : '') + '>確定</option><option' + (t.status === '要確認' ? ' selected' : '') + '>要確認</option></select></div>'
      + '</div>'
      + '<label class="fld">カテゴリ</label><select id="f_cat">' + cats + '</select>'
      + '<label class="fld" style="margin-top:14px">品目明細</label>'
      + '<div class="item-editor" id="itemEditor"></div>'
      + '<div class="item-tally" id="itemTally"></div>'
      + '<button class="add-item" id="addItemBtn">＋ 品目を追加</button>'
      + '<button class="del-btn" id="delTxBtn">この取引を削除</button>';
  }
  function bindSheet() {
    el('f_total').addEventListener('input', function () {
      cur.total = Number(this.value) || 0;
      renderItems();
    });
    el('addItemBtn').addEventListener('click', function () {
      cur.items.push({ name: '', price: 0 });
      renderItems();
      var ns = document.querySelectorAll('#itemEditor .item-row:not(.auto) input.i-name');
      if (ns.length) ns[ns.length - 1].focus();
    });
    el('delTxBtn').addEventListener('click', function () {
      if (!confirm('この取引を削除しますか？元に戻せません。')) return;
      apiPost({ action: 'delete_txn', month: cur.month, id: cur.id }).then(function (res) {
        if (res && res.ok) { closeSheet(); loaded.see = false; loadFix(); }
        else alert('削除に失敗: ' + ((res && res.error) || ''));
      }).catch(function () { alert('通信エラー'); });
    });
  }

  /** 明細エディタ。実明細＋（税抜表記なら消費税）＋不明分 を常に総額に一致させて表示する */
  function renderItems() {
    var box = el('itemEditor');
    var rows = cur.items.map(function (it, i) {
      return '<div class="item-row">'
        + '<input class="i-name" type="text" placeholder="品名" value="' + escapeHtml(it.name) + '" data-i="' + i + '" data-f="name">'
        + '<input class="i-price" type="number" inputmode="numeric" value="' + it.price + '" data-i="' + i + '" data-f="price">'
        + '<button class="i-del" data-del="' + i + '" aria-label="削除">🗑</button>'
        + '</div>';
    }).join('');

    var sum = cur.items.reduce(function (a, x) { return a + (Number(x.price) || 0); }, 0);
    var auto = '';
    var tax = Number(cur.tax) || 0;
    if (cur.items.length && tax > 0 && Math.abs(sum + tax - cur.total) < Math.abs(sum - cur.total)) {
      auto += autoRow('消費税', tax); sum += tax;
    }
    var gap = cur.total - sum;
    if (cur.items.length && gap !== 0) { auto += autoRow('不明分', gap); sum += gap; }

    box.innerHTML = rows + auto;
    Array.prototype.forEach.call(box.querySelectorAll('input[data-i]'), function (inp) {
      inp.addEventListener('change', function () {
        var i = +this.getAttribute('data-i'), f = this.getAttribute('data-f');
        cur.items[i][f] = (f === 'price') ? (Number(this.value) || 0) : this.value;
        renderItems();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () { cur.items.splice(+this.getAttribute('data-del'), 1); renderItems(); });
    });

    var tally = el('itemTally');
    if (!cur.items.length) {
      tally.className = 'item-tally';
      tally.innerHTML = '<span class="muted small" style="font-weight:400">品目明細なし（総額のみ）</span><span></span>';
    } else {
      var ok = (sum === Math.round(cur.total));
      tally.className = 'item-tally ' + (ok ? 'matched' : 'unmatched');
      tally.innerHTML = '<span>明細合計</span><span>' + yen(sum) + (ok ? '　＝ 総額' : '　/　総額 ' + yen(cur.total)) + '</span>';
    }
  }
  function autoRow(name, price) {
    return '<div class="item-row auto">'
      + '<input class="i-name" type="text" value="' + name + '" readonly>'
      + '<input class="i-price" type="text" value="' + yenSigned(price).replace('¥', '') + '" readonly>'
      + '<button class="i-del">🗑</button></div>';
  }

  el('sheetSave').addEventListener('click', function () {
    if (!cur) return closeSheet();
    var btn = el('sheetSave');
    btn.disabled = true;
    var fields = {
      store: el('f_store').value,
      purchase_date: el('f_date').value,
      total: Number(el('f_total').value) || 0,
      expense_type: el('f_type').value,
      category: el('f_cat').value,
      status: el('f_status').value,
      items: cur.items.map(function (i) { return { name: i.name, price: Number(i.price) || 0, qty: null, category: '' }; })
    };
    apiPost({ action: 'correct', month: cur.month, id: cur.id, fields: fields }).then(function (res) {
      btn.disabled = false;
      if (!res || !res.ok) { alert('保存に失敗: ' + ((res && res.error) || '')); return; }
      closeSheet();
      loaded.see = false;
      loadFix();
    }).catch(function () { btn.disabled = false; alert('通信エラー'); });
  });

  // ===== バッジ =====
  function setBadge(n) {
    var b = el('navBadge');
    if (n > 0) { b.textContent = n; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }
  function refreshBadge() {
    apiGet('reviews').then(function (res) {
      reviewData = (res && res.transactions) || [];
      setBadge(reviewData.length);
      if (activeView === 'fixView') renderReviewList();
    }).catch(function () {});
  }

  // ===================================================================
  // ３．見る
  // ===================================================================
  el('monthPrev').addEventListener('click', function () { selMonth = addMonth(selMonth, -1); loadSee(); });
  el('monthNext').addEventListener('click', function () {
    if (selMonth >= currentMonth()) return;
    selMonth = addMonth(selMonth, 1); loadSee();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.toggle'), function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-target');
      var tbl = el(id), chart = tbl.previousElementSibling;
      var showTable = tbl.classList.contains('hidden');
      tbl.classList.toggle('hidden', !showTable);
      if (chart) chart.classList.toggle('hidden', showTable);
      b.textContent = showTable ? 'グラフで見る' : '表で見る';
    });
  });

  function loadSee() {
    loaded.see = true;
    el('monthText').textContent = monthJa(selMonth);
    el('monthNext').disabled = (selMonth >= currentMonth());
    el('monthGenerated').textContent = '読み込み中…';

    var isCurrent = (selMonth === currentMonth());
    (isCurrent ? apiGet('dashboard') : apiGet('overview', { month: selMonth }))
      .then(function (res) {
        if (!res || res.error) { seeError((res && res.error) || '取得できませんでした'); return; }
        // dashboard.json が古い月のものだったらライブ集計に切り替える
        if (isCurrent && res.month !== selMonth) return apiGet('overview', { month: selMonth }).then(renderSee);
        renderSee(res, isCurrent);
      })
      .catch(function () { seeError('接続エラー'); });
  }
  function seeError(msg) {
    el('monthGenerated').textContent = '';
    el('catC').innerHTML = '<p class="muted small">' + escapeHtml(msg) + '</p>';
    el('dayC').innerHTML = ''; el('difC').innerHTML = '';
  }

  function renderSee(d, isCurrent) {
    d = d || {};
    var totals = d.totals || { all: 0, daily: 0, extraordinary: 0 };
    var prev = d.prev || null;
    el('monthGenerated').textContent = isCurrent ? fmtStamp(d.generated_at) : 'ライブ集計';

    el('totAll').textContent = yen(totals.all);
    el('totDaily').textContent = yen(totals.daily);
    el('totExtra').textContent = yen(totals.extraordinary);
    setDelta('dltAll', totals.all, prev && prev.totals ? prev.totals.all : null);
    setDelta('dltDaily', totals.daily, prev && prev.totals ? prev.totals.daily : null);
    setDelta('dltExtra', totals.extraordinary, prev && prev.totals ? prev.totals.extraordinary : null);
    el('prevNote').textContent = (prev && prev.totals)
      ? '前月（' + monthJa(prev.month) + ' ' + yen(prev.totals.all) + '）との比較。'
      : '前月のデータがないため比較なし。';

    renderCategory(d.by_category || [], prev ? (prev.by_category || []) : []);
    renderDaily(d.daily_trend || []);
    renderDiff(d.by_category || [], prev ? (prev.by_category || []) : [], prev ? prev.month : null);
    renderPlan(d.plan_vs_actual || []);
    renderAnalysis(isCurrent ? d.analysis : null);
  }

  function setDelta(id, now, before) {
    var e = el(id);
    if (before == null) { e.textContent = ''; e.className = 'delta'; return; }
    if (!before) { e.textContent = now ? '新規' : ''; e.className = 'delta up'; return; }
    var r = (now - before) / before * 100;
    var mark = r >= 0 ? '▲' : '▼';
    e.textContent = mark + ' ' + Math.abs(r).toFixed(r >= 100 ? 0 : 1) + '%';
    e.className = 'delta ' + (r >= 0 ? 'up' : 'down');
  }

  function prevAmount(list, cat) {
    for (var i = 0; i < list.length; i++) if (list[i].category === cat) return list[i].amount;
    return 0;
  }

  function renderCategory(cats, prevCats) {
    var box = el('catC');
    if (!cats.length) { box.innerHTML = '<p class="muted small">この月のデータはまだありません。</p>'; el('catT').innerHTML = ''; return; }
    var max = Math.max.apply(null, cats.map(function (c) { return Number(c.amount) || 0; })) || 1;
    box.innerHTML = cats.map(function (c) {
      var before = prevAmount(prevCats, c.category), diff = c.amount - before;
      var lbl = !before ? '<span class="up xsmall">新規</span>'
        : (diff > 0 ? '<span class="up xsmall">▲' + yen(diff) + '</span>'
          : (diff < 0 ? '<span class="down xsmall">▼' + yen(-diff) + '</span>' : ''));
      return '<div class="bar-row">'
        + '<div class="bar-head"><span class="bar-name">' + escapeHtml(c.category || '未分類') + ' ' + lbl + '</span>'
        + '<span class="bar-val">' + yen(c.amount) + '</span></div>'
        + '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, (c.amount / max * 100)) + '%"></div></div>'
        + '</div>';
    }).join('');
    el('catT').innerHTML = '<table class="tbl"><thead><tr><th>カテゴリ</th><th class="n">当月</th><th class="n">前月</th><th class="n">増減</th></tr></thead><tbody>'
      + cats.map(function (c) {
        var b = prevAmount(prevCats, c.category), df = c.amount - b;
        return '<tr><td>' + escapeHtml(c.category) + '</td><td class="n">' + yen(c.amount) + '</td><td class="n">' + yen(b) + '</td><td class="n">' + (df >= 0 ? '+' : '−') + yen(Math.abs(df)).slice(1) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderDaily(trend) {
    var box = el('dayC');
    if (!trend.length) { box.innerHTML = '<p class="muted small">この月のデータはまだありません。</p>'; el('dayT').innerHTML = ''; return; }
    var max = Math.max.apply(null, trend.map(function (t) { return Number(t.amount) || 0; })) || 1;
    var cols = trend.map(function (t) {
      var dy = Number(t.daily) || 0, ex = Number(t.extraordinary) || 0;
      var day = (t.date || '').split('-')[2];
      var h1 = dy / max * 100, h2 = ex / max * 100;
      return '<div class="col">'
        + '<div class="tip">' + (+day) + '日　日常 ' + yen(dy) + '／臨時 ' + yen(ex) + '</div>'
        + (h2 > 0 ? '<div class="seg-e" style="height:' + h2 + '%"></div>' : '')
        + '<div class="seg-d' + (h2 > 0 ? '' : ' top') + '" style="height:' + h1 + '%"></div>'
        + '</div>';
    }).join('');
    var first = (trend[0].date || '').split('-')[2], last = (trend[trend.length - 1].date || '').split('-')[2];
    var peak = trend.slice().sort(function (a, b) { return (b.amount || 0) - (a.amount || 0); })[0];
    box.innerHTML = '<div class="cols">' + cols + '</div>'
      + '<div class="axis"><span>' + (+first) + '日</span><span>' + (+last) + '日</span></div>'
      + (peak ? '<div class="peak">最多: ' + (+peak.date.split('-')[2]) + '日 ' + yen(peak.amount) + '</div>' : '');
    // タップでもツールチップを出す
    Array.prototype.forEach.call(box.querySelectorAll('.col'), function (c) {
      c.addEventListener('click', function () {
        var on = c.classList.contains('on');
        Array.prototype.forEach.call(box.querySelectorAll('.col'), function (x) { x.classList.remove('on'); });
        if (!on) c.classList.add('on');
      });
    });
    el('dayT').innerHTML = '<table class="tbl"><thead><tr><th>日</th><th class="n">日常</th><th class="n">臨時</th><th class="n">計</th></tr></thead><tbody>'
      + trend.map(function (t) {
        return '<tr><td>' + (+(t.date || '').split('-')[2]) + '日</td><td class="n">' + yen(t.daily) + '</td><td class="n">' + yen(t.extraordinary) + '</td><td class="n">' + yen(t.amount) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderDiff(cats, prevCats, prevMonth) {
    var box = el('difC');
    el('difNote').textContent = prevMonth ? (monthJa(prevMonth) + '→' + monthJa(selMonth) + 'の増減。増えた項目が上。') : '';
    if (!prevCats.length && !cats.length) { box.innerHTML = '<p class="muted small">比較できるデータがありません。</p>'; el('difT').innerHTML = ''; return; }
    var names = {};
    cats.forEach(function (c) { names[c.category] = true; });
    prevCats.forEach(function (c) { names[c.category] = true; });
    var diffs = Object.keys(names).map(function (n) {
      return { category: n, diff: prevAmount(cats, n) - prevAmount(prevCats, n) };
    }).filter(function (d) { return d.diff !== 0; }).sort(function (a, b) { return b.diff - a.diff; });
    if (!diffs.length) { box.innerHTML = '<p class="muted small">前月との差はありません。</p>'; el('difT').innerHTML = ''; return; }
    var max = Math.max.apply(null, diffs.map(function (d) { return Math.abs(d.diff); })) || 1;
    box.innerHTML = '<ul class="diff-list">' + diffs.map(function (d) {
      var w = Math.abs(d.diff) / max * 50;
      var seg = d.diff > 0
        ? '<span class="diff-seg" style="left:50%;width:' + w + '%;background:var(--data-2)"></span>'
        : '<span class="diff-seg" style="right:50%;width:' + w + '%;background:var(--data)"></span>';
      return '<li><span class="diff-name">' + escapeHtml(d.category) + '</span>'
        + '<span class="diff-bar">' + seg + '</span>'
        + '<span class="diff-val ' + (d.diff > 0 ? 'up' : 'down') + '">' + (d.diff > 0 ? '▲' : '▼') + ' ' + yen(Math.abs(d.diff)) + '</span></li>';
    }).join('') + '</ul>';
    el('difT').innerHTML = '<table class="tbl"><thead><tr><th>カテゴリ</th><th class="n">増減</th></tr></thead><tbody>'
      + diffs.map(function (d) { return '<tr><td>' + escapeHtml(d.category) + '</td><td class="n">' + (d.diff >= 0 ? '+' : '−') + yen(Math.abs(d.diff)).slice(1) + '</td></tr>'; }).join('')
      + '</tbody></table>';
  }

  function renderPlan(plans) {
    var box = el('planChart');
    if (!plans.length) { box.innerHTML = '<p class="muted small" style="text-align:center;padding:10px 0">予定支出が登録されていません</p>'; return; }
    box.innerHTML = plans.map(function (p) {
      var planned = Number(p.planned) || 0, actual = Number(p.actual) || 0;
      var ratio = planned > 0 ? actual / planned : (actual > 0 ? 1.5 : 0);
      var pct = Math.max(2, Math.min(100, Math.round(ratio * 100)));
      var over = planned > 0 && actual > planned;
      return '<div class="plan-row">'
        + '<div class="plan-head"><span class="plan-cat">' + escapeHtml(p.category || '') + '</span>'
        + '<span class="plan-num">実績 <b>' + yen(actual) + '</b> / 予定 ' + yen(planned) + '</span></div>'
        + '<div class="plan-track"><div class="plan-fill' + (over ? ' over' : '') + '" style="width:' + pct + '%"></div></div>'
        + '<div class="plan-pct' + (over ? ' over' : '') + '">' + (planned > 0 ? Math.round(ratio * 100) + '%' : '予算未設定') + (over ? '（予算超過）' : '') + '</div>'
        + '</div>';
    }).join('');
  }

  function renderAnalysis(analysis) {
    var body = el('analysisBody'), meta = el('analysisMeta');
    if (analysis && analysis.text) {
      body.textContent = analysis.text;
      body.classList.remove('muted');
      meta.textContent = fmtStamp(analysis.generated_at);
    } else {
      body.textContent = '「分析を実行」を押すと、その月の支出傾向をClaudeがまとめます。';
      body.classList.add('muted');
      meta.textContent = '';
    }
  }

  el('analyzeBtn').addEventListener('click', function () {
    var btn = el('analyzeBtn');
    btn.disabled = true; btn.textContent = '分析中…';
    apiPost({ action: 'analyze', month: selMonth }).then(function (res) {
      btn.disabled = false; btn.textContent = '分析を実行';
      if (res && res.text) renderAnalysis(res);
      else alert('分析に失敗: ' + ((res && res.error) || ''));
    }).catch(function () { btn.disabled = false; btn.textContent = '分析を実行'; alert('通信エラー'); });
  });

  // ===== 下スワイプで更新 =====
  (function setupPullToRefresh() {
    var ptr = el('ptr'), ptrText = el('ptrText');
    var startY = 0, pulling = false, dist = 0, THRESHOLD = 70;
    document.addEventListener('touchstart', function (e) {
      if (document.body.classList.contains('sheet-open')) { pulling = false; return; }
      if (window.scrollY <= 0 && e.touches.length === 1) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
      else pulling = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0 && window.scrollY <= 0) {
        ptr.style.height = Math.min(dist, 90) + 'px';
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
        if (activeView === 'seeView') loadSee();
        else if (activeView === 'fixView') loadFix();
        else refreshBadge();
        setTimeout(reset, 600);
      } else reset();
      function reset() {
        ptr.classList.remove('visible');
        ptr.style.height = '0px';
        ptrText.textContent = '下に引いて更新';
      }
    });
  })();

  // ===== 初期化 =====
  if (!GAS_URL || GAS_URL.indexOf('<<') === 0) {
    el('shotList').innerHTML = '<li class="error">config.js に GAS_URL を設定してください</li>';
  }
  setSeg('review');
  if (ensureAuth()) refreshBadge();
})();

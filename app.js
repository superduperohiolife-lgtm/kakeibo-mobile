/* app.js — モバイルアプリのロジック
 * ・撮るビュー: レシート撮影/選択 → アップロード → 即時OCR結果を直近3件タブ表示
 * ・家計簿ビュー: GAS から集計を取得してダッシュボード表示（月切替対応）
 *   当月 = action=dashboard（AI分析つき・アップロード毎に更新）
 *   過去月 = action=overview&month=YYYY-MM（ライブ集計・分析なし）
 *
 * 【2026-08 改訂】
 *   ・要確認に「何が懸案か」を表す理由（明細不足 −5,786円 など）を必ず表示する
 *   ・取引をタップして修正・削除できる編集モーダルを追加（スマホだけで完結させる）
 */
(function () {
  'use strict';

  var CFG = window.KAKEIBO_CONFIG || {};
  var GAS_URL = CFG.GAS_URL || '';
  var WEB_URL = CFG.WEB_URL || '';
  var TOKEN_KEY = 'kakeibo_token';
  var pendingFiles = [];
  var recentData = [];   // 直近3件のレシート（撮るビュー）
  var activeTab = 0;

  var selMonth = currentMonth();   // 家計簿ビューで表示中の月
  var activeView = 'captureView';
  var dashLoaded = false;

  var DAILY_CATS = ['ライフライン', '食費', '日用品', '衣料・服飾', '外食', '交通', '医療・健康', '行政手数料', '雑費'];
  var EXTRA_CATS = ['家電', '家具・インテリア', '調理・食器', '生活用品（大型）', '自転車・乗り物', '旅行・レジャー', '車関連', '住宅・修繕', '冠婚葬祭', '医療・税金・保険（高額/年払い）', 'その他臨時'];

  // カテゴリ色（安定した割り当て。未知カテゴリはパレットを循環）
  var CAT_COLORS = {
    '食費': '#1f7a5a', '日用品': '#3f9b78', '外食': '#b5651d', '交通': '#5b8bb0',
    '医療・健康': '#c0654f', 'ライフライン': '#7a6cc4', '行政手数料': '#8a8f8c', '雑費': '#8a8f8c'
  };
  var PALETTE = ['#1f7a5a', '#b5651d', '#5b8bb0', '#c0654f', '#7a6cc4', '#3f9b78', '#8a8f8c', '#c99a2e'];
  function catColor(name, i) { return CAT_COLORS[name] || PALETTE[i % PALETTE.length]; }

  var el = function (id) { return document.getElementById(id); };
  var yen = function (n) { return '¥' + (Math.round(Number(n) || 0)).toLocaleString('ja-JP'); };
  // 明細行用。マイナス（値引き・不明分の超過）を「−¥1,270」の形で出す
  var yenSigned = function (n) {
    var v = Math.round(Number(n) || 0);
    return (v < 0 ? '−' : '') + '¥' + Math.abs(v).toLocaleString('ja-JP');
  };

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }

  function currentMonth() {
    var d = new Date();
    var m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }
  function addMonth(ym, delta) {
    var p = ym.split('-'); var y = +p[0], m = +p[1] - 1 + delta;
    var d = new Date(y, m, 1);
    var mm = d.getMonth() + 1;
    return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : mm);
  }
  function monthJa(ym) {
    var p = (ym || '').split('-');
    return p.length === 2 ? (p[0] + '年' + (+p[1]) + '月') : (ym || '—');
  }
  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var m = d.getMonth() + 1, day = d.getDate();
    var hh = ('0' + d.getHours()).slice(-2), mi = ('0' + d.getMinutes()).slice(-2);
    return '更新 ' + m + '/' + day + ' ' + hh + ':' + mi;
  }

  // ===== 要確認の理由表示 =====
  // 旧データ（理由フィールドがない取引）でも壊れないよう、なければ既定文言にフォールバック。
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
  /** 理由＋「何を確認すればよいか」の手引きを1行ずつ */
  function reviewDetailHtml(t) {
    if (!t || t.status !== '要確認') return '';
    var rs = t.review_reasons || [];
    if (!rs.length) return '<div class="review-note"><b>要確認</b>　' + escapeHtml(reviewText(t)) + '</div>';
    var lines = rs.map(function (r) {
      var head = escapeHtml((r.label || r.code || '') + (r.detail ? ' ' + r.detail : ''));
      return '<li><b>' + head + '</b>' + (r.hint ? '<span class="rv-hint">' + escapeHtml(r.hint) + '</span>' : '') + '</li>';
    }).join('');
    return '<div class="review-note"><ul class="rv-list">' + lines + '</ul></div>';
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
    if (getToken()) { el('authView').classList.add('hidden'); showChrome(true); return true; }
    el('authView').classList.remove('hidden');
    showChrome(false);
    return false;
  }
  function showChrome(on) {
    // 認証前はタブナビと各ビューを隠す
    el('bottomNav').classList.toggle('hidden', !on);
    el('captureView').classList.toggle('hidden', !on || activeView !== 'captureView');
    el('dashboardView').classList.toggle('hidden', !on || activeView !== 'dashboardView');
  }

  el('saveTokenBtn').addEventListener('click', function () {
    var t = el('tokenInput').value.trim();
    if (!t) { el('authError').textContent = '合言葉を入力してください'; return; }
    setToken(t);
    apiGet('ping').then(function (res) {
      if (res && res.ok) { el('authView').classList.add('hidden'); showChrome(true); loadRecent(); }
      else { localStorage.removeItem(TOKEN_KEY); el('authError').textContent = '合言葉が違うようです'; }
    }).catch(function () {
      el('authError').textContent = '接続できません。URL設定を確認してください';
    });
  });

  // ===== ビュー切替（下部タブ） =====
  Array.prototype.forEach.call(document.querySelectorAll('.nav-tab'), function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-target');
      switchView(target);
    });
  });
  function switchView(target) {
    activeView = target;
    Array.prototype.forEach.call(document.querySelectorAll('.nav-tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-target') === target);
    });
    el('captureView').classList.toggle('hidden', target !== 'captureView');
    el('dashboardView').classList.toggle('hidden', target !== 'dashboardView');
    window.scrollTo(0, 0);
    if (target === 'dashboardView' && !dashLoaded) { dashLoaded = true; loadDashboard(); }
  }

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

    function setRow(row, cls, text, sub) {
      row.querySelector('.p-state').innerHTML = '<span class="dot ' + cls + '"></span>' + escapeHtml(text);
      if (sub) {
        var n = document.createElement('div');
        n.className = 'p-review';
        n.textContent = sub;
        row.appendChild(n);
      }
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
      loadRecent();          // 撮るビューの直近3件を更新
      dashLoaded = false;    // 家計簿を次に開くとき再取得（集計が変わっているため）
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
          else if (t.status === '要確認') {
            review++;
            setRow(item.row, 'review', (t.store || '(店名不明)') + ' ' + yen(t.total), '要確認: ' + reviewText(t));
          }
          else { setRow(item.row, 'ok', (t.store || '(店名不明)') + ' ' + yen(t.total)); }
        } else {
          errors++;
          setRow(item.row, 'err', '失敗: ' + ((res && res.error) || '読み取れませんでした'));
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

  // ===== 直近3レシートのタブ表示（撮るビュー） =====
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
    panel.innerHTML = receiptDetailHtml(recentData[activeTab])
      + '<button class="edit-btn" id="recentEditBtn">この取引を修正</button>';
    var eb = el('recentEditBtn');
    if (eb) eb.addEventListener('click', function () {
      openTxEditor(recentData[activeTab], currentMonth(), loadRecent);
    });
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
      + '</div>'
      + reviewDetailHtml(t);

    // 明細は「消費税」「不明分」を含めて総額とぴったり合うようサーバ側で組んである
    var items = t.items || [];
    var body;
    if (items.length) {
      var rows = items.map(function (it) {
        var q = (it.qty != null && it.qty !== '') ? ' ×' + it.qty : '';
        var cls = it.auto ? ' class="auto"' : '';
        return '<li' + cls + '><span class="i-name">' + escapeHtml(it.name || '') + escapeHtml(q) + '</span>'
          + '<span class="i-price">' + (it.price != null ? yenSigned(it.price) : '—') + '</span></li>';
      }).join('');
      var sum = items.reduce(function (a, it) { return a + (Number(it.price) || 0); }, 0);
      var matched = (sum === Math.round(Number(t.total) || 0));
      body = '<ul class="item-list">' + rows + '</ul>'
        + '<div class="item-sum' + (matched ? ' matched' : ' unmatched') + '">'
        + '<span>明細合計</span>'
        + '<span>' + yen(sum) + (matched ? '　＝ 総額' : '　/　総額 ' + yen(t.total)) + '</span>'
        + '</div>';
    } else {
      body = '<p class="muted small">品目明細なし（総額のみ）</p>';
    }
    return head + body;
  }

  // ===== 家計簿ダッシュボード =====
  el('monthPrev').addEventListener('click', function () { selMonth = addMonth(selMonth, -1); loadDashboard(); });
  el('monthNext').addEventListener('click', function () {
    if (selMonth >= currentMonth()) return;
    selMonth = addMonth(selMonth, 1); loadDashboard();
  });

  function normalizeDash(d) {
    d = d || {};
    return {
      month: d.month || selMonth,
      generated_at: d.generated_at || null,
      totals: d.totals || { all: 0, daily: 0, extraordinary: 0 },
      by_category: d.by_category || [],
      daily_trend: d.daily_trend || [],
      plan_vs_actual: d.plan_vs_actual || [],
      needs_review_count: d.needs_review_count || 0,
      needs_review_breakdown: d.needs_review_breakdown || [],
      needs_review_transactions: d.needs_review_transactions || [],
      recent_transactions: d.recent_transactions || [],
      analysis: d.analysis || { generated_at: null, text: '' }
    };
  }

  function loadDashboard() {
    el('monthText').textContent = monthJa(selMonth);
    el('monthNext').disabled = (selMonth >= currentMonth());
    el('monthGenerated').textContent = '読み込み中…';
    setDashLoading();

    var isCurrent = (selMonth === currentMonth());
    var req = isCurrent
      ? apiGet('dashboard')
      : apiGet('overview', { month: selMonth });

    req.then(function (res) {
      if (!res || res.error) { renderDashError((res && res.error) || '取得できませんでした'); return; }
      renderDashboard(normalizeDash(res), isCurrent);
    }).catch(function () {
      renderDashError('接続エラー');
    });
  }

  function setDashLoading() {
    el('catChart').innerHTML = '<p class="muted small">読み込み中…</p>';
    el('trendChart').innerHTML = '<p class="muted small">読み込み中…</p>';
    el('planChart').innerHTML = '<p class="muted small">読み込み中…</p>';
    el('dashRecent').innerHTML = '<li class="muted">読み込み中…</li>';
  }
  function renderDashError(msg) {
    el('monthGenerated').textContent = '';
    el('totAll').textContent = el('totDaily').textContent = el('totExtra').textContent = '¥0';
    el('reviewBadge').classList.add('hidden');
    el('reviewCard').classList.add('hidden');
    el('catChart').innerHTML = '<p class="muted small">' + escapeHtml(msg) + '</p>';
    el('trendChart').innerHTML = '';
    el('planCard').classList.add('hidden');
    el('analysisCard').classList.add('hidden');
    el('dashRecent').innerHTML = '<li class="muted">' + escapeHtml(msg) + '</li>';
  }

  function renderDashboard(d, isCurrent) {
    // 見出し
    el('monthGenerated').textContent = isCurrent ? fmtStamp(d.generated_at) : 'ライブ集計';

    // 合計
    el('totAll').textContent = yen(d.totals.all);
    el('totDaily').textContent = yen(d.totals.daily);
    el('totExtra').textContent = yen(d.totals.extraordinary);

    // 要確認（件数バッジ＋理由別内訳＋一覧）
    renderReview(d);

    renderCatChart(d.by_category);
    renderTrend(d.daily_trend);
    renderPlan(d.plan_vs_actual);
    renderAnalysis(isCurrent ? d.analysis : null);
    renderDashRecent(d.recent_transactions);
  }

  /** 要確認カード: 件数・理由別内訳・該当取引（タップで修正） */
  function renderReview(d) {
    var rb = el('reviewBadge');
    var card = el('reviewCard');
    if (!d.needs_review_count) {
      rb.classList.add('hidden');
      card.classList.add('hidden');
      return;
    }
    var breakdown = d.needs_review_breakdown || [];
    rb.textContent = '⚠️ 要確認 ' + d.needs_review_count + ' 件'
      + (breakdown.length ? '（' + breakdown.map(function (b) { return b.label + b.count; }).join('・') + '）' : '');
    rb.classList.remove('hidden');

    var list = d.needs_review_transactions || [];
    if (!list.length) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');

    el('reviewChips').innerHTML = breakdown.map(function (b) {
      return '<span class="chip">' + escapeHtml(b.label) + ' ' + b.count + '</span>';
    }).join('');

    var ul = el('reviewList');
    ul.innerHTML = '';
    list.forEach(function (t) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="r-main">'
        + '<div class="r-store">' + escapeHtml(t.store || '(店名不明)') + '</div>'
        + '<div class="r-why">' + escapeHtml(reviewText(t)) + '</div>'
        + '<div class="r-sub">' + escapeHtml(t.purchase_date || '日付不明') + '　' + escapeHtml(t.category || '') + '</div>'
        + '</div><div class="r-amt">' + yen(t.total) + '</div>';
      li.addEventListener('click', function () { openTxEditor(t, d.month, loadDashboard); });
      ul.appendChild(li);
    });
  }

  function renderCatChart(cats) {
    var box = el('catChart');
    if (!cats.length) { box.innerHTML = '<p class="muted small">この月のデータはまだありません。</p>'; return; }
    var max = Math.max.apply(null, cats.map(function (c) { return Number(c.amount) || 0; })) || 1;
    box.innerHTML = cats.map(function (c, i) {
      var pct = Math.max(3, Math.round((Number(c.amount) || 0) / max * 100));
      return '<div class="bar-row">'
        + '<div class="bar-head"><span class="bar-cat">' + escapeHtml(c.category || '未分類') + '</span>'
        + '<span class="bar-val">' + yen(c.amount) + '</span></div>'
        + '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + catColor(c.category, i) + '"></div></div>'
        + '</div>';
    }).join('');
  }

  function renderTrend(trend) {
    var box = el('trendChart');
    if (!trend.length) { box.innerHTML = '<p class="muted small">この月のデータはまだありません。</p>'; return; }
    var max = Math.max.apply(null, trend.map(function (t) { return Number(t.amount) || 0; })) || 1;
    var bars = trend.map(function (t) {
      var h = Math.max(2, Math.round((Number(t.amount) || 0) / max * 100));
      var label = (t.date || '') + '　' + yen(t.amount);
      return '<div class="tb" style="height:' + h + '%" title="' + escapeHtml(label) + '"></div>';
    }).join('');
    var first = trend[0].date ? (+trend[0].date.split('-')[2]) + '日' : '';
    var last = trend[trend.length - 1].date ? (+trend[trend.length - 1].date.split('-')[2]) + '日' : '';
    var peak = trend.slice().sort(function (a, b) { return (b.amount || 0) - (a.amount || 0); })[0];
    var peakStr = peak && peak.date ? ('最多: ' + (+peak.date.split('-')[2]) + '日 ' + yen(peak.amount)) : '';
    box.innerHTML = '<div class="trend-bars">' + bars + '</div>'
      + '<div class="trend-axis"><span>' + escapeHtml(first) + '</span><span>' + escapeHtml(last) + '</span></div>'
      + (peakStr ? '<div class="trend-peak">' + escapeHtml(peakStr) + '</div>' : '');
  }

  function renderPlan(plans) {
    var card = el('planCard');
    var box = el('planChart');
    if (!plans.length) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    box.innerHTML = plans.map(function (p) {
      var planned = Number(p.planned) || 0;
      var actual = Number(p.actual) || 0;
      var ratio = planned > 0 ? actual / planned : (actual > 0 ? 1.5 : 0);
      var pct = Math.max(2, Math.min(100, Math.round(ratio * 100)));
      var over = planned > 0 && actual > planned;
      var pctText = planned > 0 ? Math.round(ratio * 100) + '%' : '予算未設定';
      return '<div class="plan-row">'
        + '<div class="plan-head"><span class="plan-cat">' + escapeHtml(p.category || '') + '</span>'
        + '<span class="plan-num">実績 <b>' + yen(actual) + '</b> / 予定 ' + yen(planned) + '</span></div>'
        + '<div class="plan-track"><div class="plan-fill' + (over ? ' over' : '') + '" style="width:' + pct + '%"></div></div>'
        + '<div class="plan-pct' + (over ? ' over' : '') + '">' + escapeHtml(pctText) + (over ? '（予算超過）' : '') + '</div>'
        + '</div>';
    }).join('');
  }

  function renderAnalysis(analysis) {
    var card = el('analysisCard');
    if (!analysis || !analysis.text) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    el('analysisBody').textContent = analysis.text;
    el('analysisMeta').textContent = fmtStamp(analysis.generated_at);
  }

  function renderDashRecent(list) {
    var ul = el('dashRecent');
    ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="muted">まだ取引がありません。</li>'; return; }
    list.slice(0, 10).forEach(function (t) {
      var tag = t.status === '要確認'
        ? '<span class="tag review">要確認</span>'
        : '<span class="tag ' + (t.expense_type === '臨時' ? 'extra' : 'daily') + '">' + escapeHtml(t.expense_type || '') + '</span>';
      var li = document.createElement('li');
      li.innerHTML = '<div class="r-main"><div class="r-store">' + escapeHtml(t.store || '(店名不明)') + tag + '</div>'
        + (t.status === '要確認' ? '<div class="r-why">' + escapeHtml(reviewText(t)) + '</div>' : '')
        + '<div class="r-sub">' + escapeHtml(t.purchase_date || '') + '　' + escapeHtml(t.category || '') + '</div></div>'
        + '<div class="r-amt">' + yen(t.total) + '</div>';
      li.addEventListener('click', function () { openTxEditor(t, selMonth, loadDashboard); });
      ul.appendChild(li);
    });
  }

  // ===== 取引の修正モーダル（スマホで完結させるための追加） =====
  var modalSave = null;
  function showModal(title, bodyHtml, onSave) {
    el('modalTitle').textContent = title;
    el('modalBody').innerHTML = bodyHtml;
    modalSave = onSave;
    el('modal').classList.remove('hidden');
    document.body.classList.add('modal-open');
  }
  function hideModal() {
    el('modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
    modalSave = null;
  }
  el('modalCancel').addEventListener('click', hideModal);
  el('modalSave').addEventListener('click', function () {
    if (!modalSave) return hideModal();
    var btn = el('modalSave');
    btn.disabled = true;
    var p = modalSave();
    if (p && p.then) p.then(function () { btn.disabled = false; hideModal(); })
      .catch(function () { btn.disabled = false; alert('保存に失敗しました'); });
    else { btn.disabled = false; hideModal(); }
  });

  function openTxEditor(t, month, afterSave) {
    if (!t || !t.id) return;
    var cats = DAILY_CATS.concat(EXTRA_CATS).map(function (c) {
      return '<option' + (c === t.category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    }).join('');
    var itemsHtml = (t.items && t.items.length)
      ? '<div class="fld-note muted small">明細: ' + t.items.map(function (i) { return escapeHtml(i.name || '') + ' ' + yenSigned(i.price || 0); }).join(' / ')
        + '<br>（金額を直すと「不明分」が自動で計算し直され、明細合計は常に総額と一致します）</div>'
      : '';
    var fxHtml = (t.original_currency && t.original_currency !== 'JPY')
      ? '<div class="fld-note muted small">元通貨 ' + escapeHtml(t.original_currency) + ' ' + t.original_total + '（レート ' + t.fx_rate + ' で換算）</div>'
      : '';

    var body = reviewDetailHtml(t)
      + '<label class="fld">店名</label><input id="m_store" type="text" value="' + escapeHtml(t.store || '') + '">'
      + '<label class="fld">日付</label><input id="m_date" type="date" value="' + escapeHtml(t.purchase_date || '') + '">'
      + '<label class="fld">金額（円）</label><input id="m_total" type="number" inputmode="numeric" value="' + (t.total != null ? t.total : '') + '">'
      + fxHtml
      + '<label class="fld">区分</label><select id="m_type"><option' + (t.expense_type === '日常' ? ' selected' : '') + '>日常</option><option' + (t.expense_type === '臨時' ? ' selected' : '') + '>臨時</option></select>'
      + '<label class="fld">カテゴリ</label><select id="m_cat">' + cats + '</select>'
      + '<label class="fld">状態</label><select id="m_status"><option' + (t.status === '確定' ? ' selected' : '') + '>確定</option><option' + (t.status === '要確認' ? ' selected' : '') + '>要確認</option></select>'
      + itemsHtml
      + '<button id="m_delete" class="del-btn">この取引を削除</button>';

    showModal('取引の修正', body, function () {
      var fields = {
        store: el('m_store').value,
        purchase_date: el('m_date').value,
        total: Number(el('m_total').value) || 0,
        expense_type: el('m_type').value,
        category: el('m_cat').value,
        status: el('m_status').value
      };
      return apiPost({ action: 'correct', month: month, id: t.id, fields: fields }).then(function (res) {
        if (!res || !res.ok) { alert('保存に失敗: ' + ((res && res.error) || '')); return; }
        dashLoaded = false;
        if (afterSave) afterSave();
      });
    });

    var del = el('m_delete');
    if (del) del.addEventListener('click', function () {
      if (!confirm('この取引を削除しますか？元に戻せません。')) return;
      apiPost({ action: 'delete_txn', month: month, id: t.id }).then(function (res) {
        if (res && res.ok) { hideModal(); dashLoaded = false; if (afterSave) afterSave(); }
        else alert('削除に失敗: ' + ((res && res.error) || ''));
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
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
      if (document.body.classList.contains('modal-open')) { pulling = false; return; }
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
        if (activeView === 'dashboardView') loadDashboard(); else loadRecent();
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
  if (!GAS_URL || GAS_URL.indexOf('<<') === 0) {
    el('uploadStatus').textContent = 'config.js に GAS_URL を設定してください';
  }
  if (ensureAuth()) loadRecent();
})();

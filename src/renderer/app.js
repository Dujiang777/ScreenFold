/**
 * 屏风 ScreenFold — 渲染进程 (v3)
 *
 * ── 交互原则（v2 定的，v3 继续遵守）─────────────────────────────────────
 *   1. 日常使用零操作 —— 鼠标移进来就显示，移走就收回，不用按任何键。
 *   2. 其余全部可点 —— 操作条 + 状态栏 + 右键菜单，三处入口，都有中文标签。
 *   3. 鼠标位置由主进程真实探测 —— 视频区是独立 webview，宿主收不到它上面的事件。
 *
 * ── v3 加强的三件事 ────────────────────────────────────────────────────
 *   A. **自洽**：标签的文件名 / 面具里的源码 / 窗口标题，三者永远同一个文件。
 *      上一版切到别的站点，标签换了名字但代码没换，从背后扫一眼就是破绽。
 *   B. **顺手**：倍速、净化、双击钉住、每个来源独立记住音量与倍速。
 *   C. **活的**：状态栏的行列号、语言、构建指示、测试计数都会随状态真实变化。
 *
 * 整个应用依然只有两种状态：
 *   MASKED  显示假代码 —— 默认态，也是最安全的状态
 *   LIVE    显示真画面 —— 只有你主动要的时候才是
 */
(function () {
  'use strict';

  var SH = window.SCREENFOLD;
  var M = window.SF_MASKS;

  var IDLE_MS = 2200;     // 鼠标静止这么久 → 收起操作条、隐藏指针
  var HOVER_DELAY = 180;  // 移进来后等这么久才露画面（避免只是路过）

  var MASK_ZH = {
    code: '源码', diff: '代码评审', log: '构建日志', test: '跑单测', git: '提交历史'
  };

  var LANG_LABEL = {
    typescript: 'TypeScript',
    typescriptreact: 'TypeScript React'
  };

  // ── 净化：注进页面里的 CSS ────────────────────────────────────────────────
  // 目的只有一个：把这个小窗口里最容易「一眼看出来是视频网站」的东西盖掉 ——
  // 登录引导浮层、下载 App 横幅、开屏广告、以及那种很粗的系统滚动条。
  // 故意写得很保守：只按类名关键字命中，不做布局级猜测，免得把正文也吃掉。
  var CLEAN_CSS = [
    '[class*="login-guide"],[class*="loginGuide"],[class*="login-mask"],',
    '[class*="download-app"],[class*="downloadApp"],[class*="open-app"],',
    '[class*="openapp"],[id*="openApp"],[class*="app-download"],',
    '[class*="guide-layer"],[class*="ad-banner"],[class*="adBanner"],',
    '[class*="splash-ad"],[class*="popup-ad"],[class*="float-ad"],',
    '[class*="floatAd"],[class*="interstitial"]',
    '{display:none!important}',
    '::-webkit-scrollbar{width:6px;height:6px}',
    '::-webkit-scrollbar-track{background:transparent}',
    '::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}',
    '::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.32)}',
    'html{overscroll-behavior:none}'
  ].join('');

  // ── DOM ───────────────────────────────────────────────────────────────────
  var shell = document.getElementById('shell');
  var tabsEl = document.getElementById('tabs');
  var canvas = document.getElementById('canvas');
  var frame = document.getElementById('frame');
  var gutter = document.getElementById('gutter');
  var maskBody = document.getElementById('maskBody');
  var maskLayer = document.getElementById('maskLayer');
  var liveLayer = document.getElementById('liveLayer');
  var liveBoot = document.getElementById('liveBoot');
  var bootText = document.getElementById('bootText');
  var dimEl = document.getElementById('dim');
  var dock = document.getElementById('dock');
  var eyeBtn = document.getElementById('eye');
  var sbSource = document.getElementById('sbSource');
  var sbSize = document.getElementById('sbSize');
  var sbMaskBtn = document.getElementById('sbMaskBtn');
  var sbCursor = document.getElementById('sbCursor');
  var sbBranch = document.getElementById('sbBranch');
  var sbLang = document.getElementById('sbLang');
  var sbDirty = document.getElementById('sbDirty');
  var sbBuild = document.getElementById('sbBuild');
  var sbBuildDot = document.getElementById('sbBuildDot');
  var toastEl = document.getElementById('toast');
  var palette = document.getElementById('palette');
  var palInput = document.getElementById('palInput');
  var palList = document.getElementById('palList');
  var settingsEl = document.getElementById('settings');
  var siteListEl = document.getElementById('siteList');
  var hotkeyListEl = document.getElementById('hotkeyList');
  var cfgPathEl = document.getElementById('cfgPath');
  var menuEl = document.getElementById('ctxmenu');
  var cmHead = document.getElementById('cmHead');
  var cmTitle = document.getElementById('cmTitle');
  var cmBack = document.getElementById('cmBack');
  var cmList = document.getElementById('cmList');

  // ── 状态 ──────────────────────────────────────────────────────────────────
  var S = {
    cfg: {},
    sites: [],
    site: null,
    mask: 'code',
    loading: false,
    mouseIn: false,
    mouseY: -1,
    idle: false,
    hovered: false,
    pinned: false,
    peekUntil: 0,
    overlay: false,
    userMuted: false,
    revealed: null,
    unmountMask: null,
    webview: null,
    presets: {},
    presetOrder: [],
    masks: {},
    rates: [1, 1.25, 1.5, 2],
    hotkeys: [],
    hotkeyFailures: [],
    dockForce: null,
    dockHintUntil: 0,
    chromeH: 52,
    stats: 0,          // 测试面具跑出来的用例数，用于状态栏
    buildFlash: 0
  };

  var enterTimer = null;
  var leaveTimer = null;
  var toastTimer = null;
  var rateTimer = null;
  var cleanSheets = [];

  // ── 工具 ──────────────────────────────────────────────────────────────────
  // quiet：自检 / 自动化驱动时把提示条静音。不然每张截图里都挂着一句
  // 「面具：源码」，既是噪声又盖住内容。
  function toast(msg, ms) {
    if (S.quiet) return;
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 1700);
  }

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function findSite(id) {
    for (var i = 0; i < S.sites.length; i++) if (S.sites[i].id === id) return S.sites[i];
    return S.sites[0];
  }

  // 严格版：找不到就返回 null，别把「失效的标签」错认成第一个站点
  function siteById(id) {
    for (var i = 0; i < S.sites.length; i++) if (S.sites[i].id === id) return S.sites[i];
    return null;
  }

  function curFile() { return S.site ? S.site.file : 'feed.aggregator.ts'; }
  function curLang() { return S.site ? S.site.lang : 'typescript'; }

  function contentH() {
    return Math.max(0, window.innerHeight - S.chromeH);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  核心：该不该露出画面
  // ══════════════════════════════════════════════════════════════════════════
  function shouldReveal() {
    if (S.cfg.lockMask) return false;            // 死锁：任何操作都不露
    if (S.overlay) return false;                 // 浮层打开时不露
    if (S.pinned) return true;                   // 钉住了
    if (Date.now() < S.peekUntil) return true;   // 闪现中
    if (S.cfg.peekOnHover && S.hovered) return true; // 鼠标移进来
    return false;
  }

  function apply(force) {
    var reveal = shouldReveal();

    if (force || reveal !== S.revealed) {
      S.revealed = reveal;

      // 瞬时切换，不加过渡 —— 绝不留「正在淡出」的中间帧
      liveLayer.classList.toggle('off', !reveal);
      maskLayer.classList.toggle('off', reveal);
      gutter.classList.toggle('collapsed', reveal);
      shell.classList.toggle('live', reveal);

      eyeBtn.classList.toggle('live', reveal);
      syncAudio();
      updateBoot();
      updateCursorClass();
      updatePinUI();
      if (reveal) pumpRate();
    }
  }

  function updateBoot() {
    var show = S.loading && S.revealed;
    liveBoot.classList.toggle('on', !!show);
  }

  // 画面收起 → 静音；这是「藏起来」的最后一道保险
  function syncAudio() {
    if (!S.webview || !S.webview.setAudioMuted) return;
    var shouldMute = S.userMuted || (!S.revealed && S.cfg.muteOnHide);
    try { S.webview.setAudioMuted(!!shouldMute); } catch (e) { /* webview 未就绪 */ }
  }

  setInterval(function () { apply(); updateDock(); }, 120);

  // ══════════════════════════════════════════════════════════════════════════
  //  鼠标进出 / 空闲（由主进程真实探测后推过来）
  // ══════════════════════════════════════════════════════════════════════════
  function onCursor(cmd) {
    var inside = !!cmd.inside;
    var wasIn = S.mouseIn;

    clearTimeout(enterTimer);
    clearTimeout(leaveTimer);

    S.mouseIn = inside;
    if (typeof cmd.y === 'number') S.mouseY = cmd.y;
    else if (!inside) S.mouseY = -1;

    // 刚进来 → 让操作条露一次脸，这是「发现入口」的唯一时机
    if (inside && !wasIn) S.dockHintUntil = Date.now() + 2600;

    if (inside) {
      if (S.cfg.peekOnHover) {
        enterTimer = setTimeout(function () { S.hovered = true; apply(true); }, HOVER_DELAY);
      }
    } else {
      S.hovered = false;
      closeMenu();
      if (palette.classList.contains('on')) closePalette();
      var ms = S.cfg.hideOnLeave;
      if (ms == null) ms = 400;

      // 「移开后」两种伪装（cfg.onLeave）：
      //   mask —— 盖上代码面具，外壳还在（默认，最稳）
      //   hide —— 连窗口一起藏掉，屏幕上什么都不剩
      // 钉住画面 / 菜单设置开着的时候不藏 —— 那两种情况用户显然还在用。
      if (S.cfg.onLeave === 'hide' && !S.pinned && !S.overlay) {
        apply(true);                       // 先把面具盖上，别让「藏起来」之前闪一帧画面
        if (ms <= 0) SF.hide();
        else leaveTimer = setTimeout(function () { SF.hide(); }, ms);
      } else if (ms <= 0) {
        apply(true);
      } else {
        leaveTimer = setTimeout(function () { apply(true); }, ms);
      }
    }
    updateDock();
  }

  function setIdle(v) {
    if (S.idle === !!v) return;
    S.idle = !!v;
    updateDock();
    updateCursorClass();
  }

  // 操作条什么时候浮出来：
  //   鼠标刚进窗口 → 露一次（教你入口在哪）
  //   之后只在鼠标移到窗口底部那一条才出现 —— 免得看片时老挡着画面
  var DOCK_ZONE = 38;

  function updateDock() {
    var show;
    if (S.dockForce !== null) {
      show = S.dockForce;
    } else if (S.overlay || !S.mouseIn || S.idle) {
      show = false;
    } else {
      show = Date.now() < S.dockHintUntil || S.mouseY >= window.innerHeight - DOCK_ZONE;
    }
    dock.classList.toggle('on', !!show);
  }

  function updateCursorClass() {
    shell.classList.toggle('nocursor', !!(S.revealed && S.cfg.hideCursor && S.idle));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  菜单 —— 右键 / 操作条 / 状态栏 共用一套，带子菜单
  // ══════════════════════════════════════════════════════════════════════════
  var MENU = { open: false, stack: [], opt: null };

  function syncOverlay() {
    S.overlay = MENU.open || palette.classList.contains('on') || settingsEl.classList.contains('on');
  }

  function openMenu(items, opt) {
    MENU.open = true;
    MENU.opt = opt || {};
    MENU.stack = [{ title: (opt && opt.title) || '', items: items }];
    menuEl.classList.add('on');
    renderMenu();
    positionMenu();
    closePalette();
    syncOverlay();
    apply(true);
    updateDock();
  }

  function closeMenu() {
    if (!MENU.open) return;
    MENU.open = false;
    MENU.stack = [];
    menuEl.classList.remove('on');
    syncOverlay();
    apply(true);
    updateDock();
  }

  // 点同一个锚点 = 开/关；刚被「点外面」关掉的，300ms 内不再重开
  function menuToggle(anchor, itemsFn, title) {
    if (MENU.open && MENU.opt && MENU.opt.anchor === anchor) { closeMenu(); return; }
    if (Date.now() - (MENU.closedAt || 0) < 300) return;
    openMenu(itemsFn(), { anchor: anchor, title: title });
  }

  function renderMenu() {
    var f = MENU.stack[MENU.stack.length - 1];
    if (!f) return;
    cmList.innerHTML = '';

    var deep = MENU.stack.length > 1;
    cmHead.hidden = !deep;
    cmTitle.textContent = f.title || '';
    cmBack.style.visibility = deep ? 'visible' : 'hidden';

    f.items.forEach(function (it) {
      if (it.kind === 'sep') { cmList.appendChild(el('div', 'cm-sep')); return; }
      if (it.kind === 'head') { cmList.appendChild(el('div', 'cm-hd', it.label)); return; }

      var row = el('button', 'cm-item' + (it.checked ? ' on' : '') + (it.danger ? ' danger' : ''));
      row.type = 'button';
      row.appendChild(el('span', 'cm-lab', it.label));
      if (it.hint) row.appendChild(el('span', 'cm-hint', it.hint));
      if (it.checked) row.appendChild(el('span', 'cm-ck', '\u2713'));
      if (it.sub) row.appendChild(el('i', 'cm-caret'));

      row.addEventListener('click', function () {
        if (it.sub) {
          var sub = typeof it.sub === 'function' ? it.sub() : it.sub;
          MENU.stack.push({ title: it.label, items: sub });
          renderMenu();
          positionMenu();
          return;
        }
        closeMenu();
        if (it.action) it.action();
      });
      cmList.appendChild(row);
    });
  }

  function positionMenu() {
    var w = menuEl.offsetWidth;
    var h = menuEl.offsetHeight;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var opt = MENU.opt || {};
    var x;
    var y;

    if (opt.at) {
      x = opt.at.x;
      y = opt.at.y;
    } else if (opt.anchor && opt.anchor.getBoundingClientRect) {
      var r = opt.anchor.getBoundingClientRect();
      x = r.left;
      y = r.top - h - 5;
      if (y < 4) y = r.bottom + 5;
    } else {
      x = 8;
      y = 40;
    }

    x = Math.max(4, Math.min(x, W - w - 4));
    y = Math.max(4, Math.min(y, H - h - 4));
    menuEl.style.left = Math.round(x) + 'px';
    menuEl.style.top = Math.round(y) + 'px';
  }

  cmBack.addEventListener('click', function () {
    if (MENU.stack.length > 1) {
      MENU.stack.pop();
      renderMenu();
      positionMenu();
    }
  });

  // ── 菜单内容 ──────────────────────────────────────────────────────────────
  function sourceItems() {
    var real = S.cfg.showRealNames !== false;
    return S.sites.map(function (s) {
      return {
        label: real ? s.real : s.file,
        hint: real ? s.file : (s.ratio === 'short' ? '竖屏' : '横屏'),
        checked: s.id === S.cfg.siteId,
        action: function () { activateSite(s.id); }
      };
    }).concat([
      { kind: 'sep' },
      { label: '搜来源…', hint: '列表里找', action: openPalette }
    ]);
  }

  function maskItems() {
    return M.order.map(function (k) {
      var def = null;
      for (var i = 0; i < S.masksList.length; i++) {
        if (S.masksList[i].id === k) def = S.masksList[i];
      }
      return {
        label: MASK_ZH[k] || k,
        hint: def ? def.label : '',
        checked: S.mask === k,
        action: function () { setMask(k); }
      };
    });
  }

  function sizeItems() {
    var list = S.presetOrder.map(function (k) {
      var p = S.presets[k];
      return {
        label: p.label,
        hint: p.w + '\u00d7' + p.h,
        checked: S.cfg.preset === k,
        action: function () { pickPreset(k); }
      };
    });
    list.push({ kind: 'sep' });
    if (S.cfg.preset === 'free') {
      list.push({ kind: 'head', label: '当前：你自己拖出来的 ' + window.innerWidth + '\u00d7' + contentH() });
    }
    list.push({
      label: '重置为默认大小',
      hint: '竖屏小',
      action: function () { pickPreset('short'); }
    });
    return list;
  }

  function rateItems() {
    return S.rates.map(function (r) {
      return {
        label: r + '\u00d7',
        hint: r === 1 ? '正常速度' : '只看重点',
        checked: Math.abs(currentRate() - r) < 0.001,
        action: function () { setRate(r); }
      };
    });
  }

  // 「鼠标移开后变成什么」—— 两种都列出来，点一下就能切
  function onLeaveItems() {
    var cur = S.cfg.onLeave === 'hide' ? 'hide' : 'mask';
    return [
      {
        label: '变回代码',
        hint: '外壳留在原地',
        checked: cur === 'mask',
        action: function () { setOnLeave('mask'); }
      },
      {
        label: '整个窗口藏掉',
        hint: '托盘图标 / Alt+V 叫回来',
        checked: cur === 'hide',
        action: function () { setOnLeave('hide'); }
      }
    ];
  }

  function ctxItems() {
    return [
      { label: '换来源', hint: curFile(), sub: sourceItems },
      { label: '换面具', hint: MASK_ZH[S.mask] || S.mask, sub: maskItems },
      { label: '换尺寸', hint: window.innerWidth + '\u00d7' + contentH(), sub: sizeItems },
      { label: '播放速度', hint: currentRate() + '\u00d7', sub: rateItems },
      {
        label: '移开后',
        hint: S.cfg.onLeave === 'hide' ? '整窗藏掉' : '变回代码',
        sub: onLeaveItems
      },
      { kind: 'sep' },
      {
        label: S.pinned ? '松开画面' : '钉住画面',
        hint: S.pinned ? '恢复自动收回' : '不自动收回',
        checked: S.pinned,
        action: function () { togglePin(); }
      },
      { label: '立刻收回', action: function () { panic(); } },
      {
        label: '净化页面',
        hint: '去浮层 / 细滚动条',
        checked: !!S.cfg.clean,
        action: function () { setClean(!S.cfg.clean); }
      },
      {
        label: '锁死面具',
        hint: '怎么移都不露',
        checked: !!S.cfg.lockMask,
        action: function () {
          S.cfg.lockMask = !S.cfg.lockMask;
          SF.patchConfig({ lockMask: S.cfg.lockMask });
          toast(S.cfg.lockMask ? '已锁死，鼠标移进来也不露画面' : '已解锁');
          closeMenu();
          apply(true);
        }
      },
      { kind: 'sep' },
      { label: '设置…', action: openSettings },
      { label: '用系统浏览器打开', action: function () { if (S.site) SF.openExternal(S.site.url); } },
      { label: '退出屏风', danger: true, action: function () { SF.quit(); } }
    ];
  }

  function updateSizeLabel() {
    sbSize.textContent = window.innerWidth + '\u00d7' + contentH();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  标签栏 —— 每一个「文件」就是一个站点
  // ══════════════════════════════════════════════════════════════════════════
  function renderTabs() {
    tabsEl.innerHTML = '';
    var ids = S.cfg.openTabs || [];
    ids.forEach(function (id) {
      var site = siteById(id);
      if (!site) return;

      var t = el('div', 'tab' + (id === S.cfg.siteId ? ' active' : ''));
      t.title = site.real + '  ·  ' + site.file;
      var dot = el('span', 'dot');
      dot.style.color = site.dot || '#8ab4ff';
      var name = el('span', 'fname', site.file);
      var x = el('span', 'x', '\u00d7');

      t.appendChild(dot);
      t.appendChild(name);
      t.appendChild(x);

      t.addEventListener('click', function (e) {
        if (e.target === x) { closeTab(id); return; }
        activateSite(id);
      });
      tabsEl.appendChild(t);
    });

    var act = tabsEl.querySelector('.tab.active');
    if (act && act.scrollIntoView) {
      try { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* noop */ }
    }
  }

  function openTab(id) {
    var list = S.cfg.openTabs || [];
    if (list.indexOf(id) === -1) {
      list.push(id);
      S.cfg.openTabs = list;
      SF.patchConfig({ openTabs: list });
    }
  }

  function closeTab(id) {
    var list = (S.cfg.openTabs || []).filter(function (x) { return x !== id; });
    if (!list.length) list = [S.cfg.siteId];
    S.cfg.openTabs = list;
    SF.patchConfig({ openTabs: list });
    if (id === S.cfg.siteId) activateSite(list[0]);
    else renderTabs();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  站点
  // ══════════════════════════════════════════════════════════════════════════
  function activateSite(id, opts) {
    var site = findSite(id);
    if (!site) return;
    opts = opts || {};

    S.site = site;
    S.cfg.siteId = id;
    openTab(id);
    SF.setSite(id);
    SF.sync({ siteId: id });

    // 每个来源的音量 / 倍速 / 净化各记各的
    applySitePrefs(site.id);

    renderTabs();
    remountFollowedMasks();
    mountWebview(site);
    autoFit(site);
    updateStatusBar();
    apply(true);

    if (!opts.silent) toast(site.real + '  \u00b7  ' + site.file);

    // 第一次进这个来源才提示一次 —— 比如抖音要扫码登录
    if (site.hint && !opts.noHint) {
      S.cfg.seenSite = S.cfg.seenSite || {};
      if (!S.cfg.seenSite[site.id]) {
        S.cfg.seenSite[site.id] = 1;
        SF.patchConfig({ seenSite: S.cfg.seenSite });
        setTimeout(function () { toast(site.hint, 4200); }, opts.silent ? 1400 : 900);
      }
    }
  }

  // 竖屏站点 → 竖屏窗口，横屏站点 → 横屏窗口。
  // 用户自己拖过尺寸的话，就不动他的大小，只把高度对齐到新比例。
  function autoFit(site) {
    if (!S.cfg.autoFit) return;

    if (S.cfg.preset === 'free') {
      SF.fitRatio(site.ratio).then(function (b) {
        if (b) updateSizeLabel();
        setTimeout(fitStage, 40);
        apply(true);
      });
      return;
    }

    var cur = S.presets[S.cfg.preset];
    if (!cur) return;
    if (cur.ratio === site.ratio) return;

    // 同比例里挑一个「宽度跟当前最接近」的预设，而不是固定跳那一档。
    // 固定跳的旧行为很突兀：用户特意把窗口调成「细条」(168)，只是切个来源，
    // 窗口就"啪"地弹回横屏 528 —— 主观感受就是「我设的尺寸老是被吃掉」。
    var target = null;
    var best = Infinity;
    S.presetOrder.forEach(function (k) {
      var p = S.presets[k];
      if (!p || p.ratio !== site.ratio) return;
      var d = Math.abs(p.w - cur.w);
      if (d < best) { best = d; target = k; }
    });
    if (!target) target = site.ratio === 'short' ? 'short' : 'wide';
    if (target === S.cfg.preset) return;
    S.cfg.preset = target;
    SF.setPreset(target);
    setTimeout(function () { fitStage(); updateSizeLabel(); }, 60);
  }

  function pickPreset(name) {
    S.cfg.preset = name;
    SF.setPreset(name);
    var p = S.presets[name];
    toast('窗口：' + (p ? p.label + '  ' + p.w + '\u00d7' + p.h : name));
    setTimeout(function () { fitStage(); updateSizeLabel(); apply(true); }, 70);
  }

  // ── 每个来源自己的偏好 ────────────────────────────────────────────────────
  function sitePref(id) {
    S.cfg.perSite = S.cfg.perSite || {};
    return S.cfg.perSite[id] || null;
  }

  function saveSitePref(id, patch) {
    S.cfg.perSite = S.cfg.perSite || {};
    var cur = S.cfg.perSite[id] || {};
    S.cfg.perSite[id] = Object.assign({}, cur, patch);
    var payload = {};
    payload.perSite = S.cfg.perSite;
    SF.patchConfig(payload);
  }

  function applySitePrefs(id) {
    var p = sitePref(id);
    S.userMuted = p && typeof p.muted === 'boolean' ? p.muted : false;
    S.cfg.rate = p && p.rate ? p.rate : (S.cfg.rate || 1);
    S.cfg.clean = p && typeof p.clean === 'boolean' ? p.clean : S.cfg.clean !== false;
    S.cfg.volume = p && p.volume ? p.volume : (S.cfg.volume || 70);

    var mb = $('dkMute');
    if (mb) mb.classList.toggle('on', !!S.userMuted);
    updateRateLabel();
    updateCleanButton();
    syncAudio();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  画面
  // ══════════════════════════════════════════════════════════════════════════
  var bootTimer = null;

  // 有些站点（抖音这类 SPA）会一直挂着后台请求，did-stop-loading 迟迟不来。
  // 所以加载态必须带超时兜底，否则遮罩会一直挡着画面不出来。
  function setLoading(v) {
    S.loading = !!v;
    clearTimeout(bootTimer);
    if (S.loading) {
      bootTimer = setTimeout(function () {
        S.loading = false;
        updateBoot();
        syncAudio();
      }, 6000);
    }
    updateBoot();
  }

  function mountWebview(site) {
    frame.innerHTML = '';
    S.webview = null;
    cleanSheets = [];
    if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }

    if (!site.url) {
      bootText.textContent = 'No source';
      setLoading(false);
      return;
    }
    setLoading(true);

    var wv = document.createElement('webview');
    wv.setAttribute('src', site.url);
    wv.setAttribute('partition', 'persist:sf-' + site.id);
    wv.setAttribute('useragent', site.ua === 'desktop' ? SH.DESKTOP_UA : SH.MOBILE_UA);
    wv.setAttribute('allowpopups', 'false');
    // 外壳页面就在 file:// 下，用相对位置推 preload 的绝对 URL
    try {
      wv.setAttribute('preload', new URL('../preload/guest.js', location.href).href);
    } catch (e) { /* 推不出来就算了，双击钉住会退化成不可用 */ }
    wv.style.width = '100%';
    wv.style.height = '100%';

    // 页面把鼠标事件全吃了，双击只能从 guest 那边捞回来（见 preload/guest.js）
    wv.addEventListener('ipc-message', function (e) {
      if (e.channel !== 'sf-guest') return;
      var msg = e.args && e.args[0];
      if (msg && msg.type === 'dblclick' && S.cfg.doubleClickPin !== false) togglePin();
    });

    bootText.textContent = 'Compiling ' + site.file + '\u2026';

    wv.addEventListener('did-start-loading', function () { setLoading(true); });
    wv.addEventListener('did-stop-loading', function () {
      setLoading(false);
      afterLoad();
    });
    wv.addEventListener('did-finish-load', function () {
      setLoading(false);
      afterLoad();
    });
    wv.addEventListener('did-fail-load', function (e) {
      setLoading(false);
      if (e && e.errorCode === -3) return; // 用户主动取消，忽略
      toast('加载失败：右键 → 换来源，或点操作条上的刷新', 2600);
    });

    frame.appendChild(wv);
    S.webview = wv;
    fitStage();
  }

  function afterLoad() {
    syncAudio();
    applyVolume(S.cfg.volume);
    pumpRate();
    applyClean();
  }

  function applyVolume(v) {
    if (!S.webview || !S.webview.executeJavaScript) return;
    var vol = Math.max(0, Math.min(1, (Number(v) || 0) / 100));
    var js =
      '(function(){var v=' + vol + ';' +
      'document.querySelectorAll("video,audio").forEach(function(m){' +
      'try{m.volume=v;}catch(e){}});return v;})()';
    try { S.webview.executeJavaScript(js).catch(function () { }); } catch (e) { /* noop */ }
  }

  // ── 倍速 ────────────────────────────────────────────────────────────────
  function currentRate() {
    return S.cfg.rate || 1;
  }

  function pumpRate() {
    if (!S.webview || !S.webview.executeJavaScript) return;
    var r = currentRate();
    var js =
      '(function(){var r=' + r + ';var n=0;' +
      'document.querySelectorAll("video,audio").forEach(function(m){' +
      'try{if(m.playbackRate!==r){m.playbackRate=r;n++;}}catch(e){}});return n;})()';
    try { S.webview.executeJavaScript(js).catch(function () { }); } catch (e) { /* noop */ }
  }

  // SPA 换视频时 playbackRate 会被重置，所以露着的时候隔几秒补一次
  function startRatePump() {
    if (rateTimer) clearInterval(rateTimer);
    rateTimer = setInterval(function () {
      if (S.revealed) pumpRate();
    }, 3000);
  }

  function setRate(r) {
    S.cfg.rate = r;
    saveSitePref(S.cfg.siteId, { rate: r });
    updateRateLabel();
    pumpRate();
    toast('播放速度 ' + r + '\u00d7');
  }

  function updateRateLabel() {
    var b = $('dkRate');
    if (!b) return;
    var t = b.querySelector('.dk-t');
    var r = currentRate();
    if (t) t.textContent = r === 1 ? '倍速' : r + '\u00d7';
    b.classList.toggle('on', r !== 1);
  }

  // ── 净化 ────────────────────────────────────────────────────────────────
  function applyClean() {
    if (!S.webview || !S.webview.insertCSS) return;
    // 先把上一次插的撤掉，避免来回切换越插越多
    cleanSheets.forEach(function (key) {
      try { S.webview.removeInsertedCSS(key); } catch (e) { /* noop */ }
    });
    cleanSheets = [];
    if (S.cfg.clean === false) return;
    try {
      var p = S.webview.insertCSS(CLEAN_CSS);
      if (p && p.then) {
        p.then(function (key) { if (key) cleanSheets.push(key); }).catch(function () { });
      }
    } catch (e) { /* noop */ }
  }

  function setClean(on) {
    S.cfg.clean = !!on;
    saveSitePref(S.cfg.siteId, { clean: !!on });
    updateCleanButton();
    applyClean();
    toast(on ? '已净化：浮层和广告盖掉了' : '已还原原页面');
  }

  function updateCleanButton() {
    var b = $('dkClean');
    if (!b) return;
    b.classList.toggle('on', S.cfg.clean !== false);
  }

  // 「移开后」= 变代码 / 整窗隐藏。改完立刻按新规则重算一次显示状态，
  // 下次鼠标移出去就走新模式（不在这里主动藏 —— 用户此刻正站在窗口上，
  // 突然消失比「下次移开才生效」更吓人）。
  function setOnLeave(v) {
    S.cfg.onLeave = v === 'hide' ? 'hide' : 'mask';
    SF.patchConfig({ onLeave: S.cfg.onLeave });
    toast(S.cfg.onLeave === 'hide'
      ? '已设置：鼠标移开就整窗藏掉（托盘图标或 Alt+V 叫回来）'
      : '已设置：鼠标移开就变回代码');
    apply(true);
  }

  // 内容按比例铺满容器，多余部分裁掉 —— 不留黑边
  function fitStage() {
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    if (!cw || !ch) return;
    var ratio = S.site && S.site.ratio === 'short' ? 9 / 16 : 16 / 9;
    var w;
    var h;
    if (cw / ch > ratio) {
      w = cw;
      h = cw / ratio;
    } else {
      h = ch;
      w = ch * ratio;
    }
    w = Math.round(w);
    h = Math.round(h);

    // 居中用 left/top 算，不能用 transform —— 见 style.css 里 #frame 的注释
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.left = Math.round((cw - w) / 2) + 'px';
    frame.style.top = Math.round((ch - h) / 2) + 'px';

    // webview 也写成明确像素：% 在 OOPIF 上是另一个已知的尺寸传播不稳定点
    if (S.webview) {
      S.webview.style.width = w + 'px';
      S.webview.style.height = h + 'px';
    }

    var d = S.cfg.dimLive || 0;
    dimEl.style.opacity = d > 0 ? Math.min(0.85, d) : 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  面具
  // ══════════════════════════════════════════════════════════════════════════
  // 哪些面具的内容取自「当前文件」—— 切站点时必须重挂，否则文件名和内容对不上
  var FILE_BOUND = { code: 1, diff: 1, log: 1 };

  function mountMask(id) {
    if (S.unmountMask) {
      try { S.unmountMask(); } catch (e) { /* noop */ }
      S.unmountMask = null;
    }
    S.mask = id || 'code';
    var m = M[S.mask] || M.code;

    // 清掉上一个面具留下的味道（终端类面具会加 is-term 之类的类）
    maskBody.className = '';
    maskBody.style.paddingTop = '4px';
    gutter.classList.remove('collapsed');

    S.unmountMask = m.mount(maskBody, gutter, {
      setCursor: function (ln, col) {
        // 元素缺失时不能抛 —— 面具在 mount 里就会调一次，抛出去整个面具都挂不上
        // （这个坑真的踩过：diff / git 两个面具因此完全没渲染出来）
        if (!sbCursor) return;
        var txt = 'Ln ' + ln + ', Col ' + col;
        if (sbCursor.textContent !== txt) sbCursor.textContent = txt;
      },
      setStats: function (n) {
        S.stats = n;
        updateStatusBar();
      }
    }, { file: curFile(), lang: curLang() });

    updateStatusBar();
    syncTitle();
  }

  // 切站点时：如果当前面具是按文件取的，重挂一次让内容跟上标签
  function remountFollowedMasks() {
    if (S.cfg.maskFollowsFile === false) return;
    if (!FILE_BOUND[S.mask]) return;
    mountMask(S.mask);
  }

  function setMask(id) {
    S.cfg.mask = id;
    SF.patchConfig({ mask: id });
    mountMask(id);
    apply(true);
    toast('面具：' + (MASK_ZH[id] || id));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  状态栏 / 窗口标题 —— 让外壳看起来「正在工作」
  // ══════════════════════════════════════════════════════════════════════════
  var DIRTY = { code: 2, diff: 7, log: 0, test: 0, git: 0 };

  function updateStatusBar() {
    sbLang.textContent = LANG_LABEL[curLang()] || 'TypeScript';
    if (sbDirty) sbDirty.textContent = 'M ' + (DIRTY[S.mask] || 0);
    if (sbMaskBtn) sbMaskBtn.title = '换面具（现在：' + (MASK_ZH[S.mask] || S.mask) + '）';
    if (sbSource) sbSource.title = '看哪个（点一下换来源）';
    if (sbBuild) {
      sbBuild.title = S.mask === 'test'
        ? '测试：已跑 ' + S.stats + ' 个用例'
        : '构建：上次成功';
      if (sbBuildDot) sbBuildDot.classList.toggle('busy', S.mask === 'test');
    }
  }

  // 窗口标题 = Alt+Tab / 任务管理器里看到的东西，必须和标签对得上
  function syncTitle() {
    var f = curFile();
    var project = S.cfg.project || 'inkstack';
    var t;
    if (S.mask === 'diff') t = f + ' (Changes) \u2014 ' + project + ' \u2014 Visual Studio Code';
    else if (S.mask === 'log' || S.mask === 'test') t = f + ' \u2014 Terminal \u2014 ' + project;
    else if (S.mask === 'git') t = 'Git Graph \u2014 ' + project;
    else t = f + ' \u2014 ' + project + ' \u2014 Visual Studio Code';
    // 两边都设：document.title 是 Electron 里真正驱动窗口标题的东西
    // （页面一有 <title>，setTitle 就会被它盖掉），setTitle 负责立刻生效。
    document.title = t;
    SF.setTitle(t);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  钉住 / 收回
  // ══════════════════════════════════════════════════════════════════════════
  function togglePin() {
    S.pinned = !S.pinned;
    S.peekUntil = 0;
    updatePinUI();
    apply(true);
    toast(S.pinned ? '已钉住 · 不再自动收回' : '已松开 · 移开鼠标就收回');
  }

  function updatePinUI() {
    $('dkPin').classList.toggle('on', S.pinned);
    eyeBtn.classList.toggle('live', S.pinned || S.revealed);
    var t = eyeBtn.querySelector('.eye-t');
    if (t) t.textContent = S.pinned ? '已钉' : '钉住';
  }

  function panic() {
    S.pinned = false;
    S.peekUntil = 0;
    S.hovered = false;
    closeMenu();
    closePalette();
    closeSettings();
    syncOverlay();
    updatePinUI();
    apply(true);
    toast('已收回', 900);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  快速打开
  // ══════════════════════════════════════════════════════════════════════════
  var palSel = 0;
  var palItems = [];

  function openPalette() {
    palette.classList.add('on');
    palInput.value = '';
    renderPalette('');
    setTimeout(function () { palInput.focus(); }, 10);
    syncOverlay();
    apply(true);
    updateDock();
  }

  function closePalette() {
    palette.classList.remove('on');
    syncOverlay();
    apply(true);
  }

  function renderPalette(q) {
    q = (q || '').toLowerCase();
    palList.innerHTML = '';
    palItems = [];
    var openIds = S.cfg.openTabs || [];

    function pushHead(text) { palList.appendChild(el('div', 'pitem head', text)); }

    function pushSite(site) {
      var it = el('div', 'pitem' + (site.id === S.cfg.siteId ? ' sel' : ''));
      var dot = el('span', 'pdot');
      dot.style.background = site.dot || '#8ab4ff';
      it.appendChild(dot);
      it.appendChild(el('span', 'pname', site.file));
      it.appendChild(el('span', 'pmeta', site.real));
      it.addEventListener('click', function () {
        activateSite(site.id);
        closePalette();
      });
      palList.appendChild(it);
      palItems.push({ node: it, site: site });
    }

    if (!q) {
      pushHead('已打开');
      openIds.map(siteById).filter(Boolean).forEach(pushSite);
      pushHead('全部来源');
      S.sites.forEach(function (s) { if (openIds.indexOf(s.id) === -1) pushSite(s); });
    } else {
      var hits = S.sites.filter(function (s) {
        return (
          s.file.toLowerCase().indexOf(q) >= 0 ||
          s.real.toLowerCase().indexOf(q) >= 0 ||
          s.id.indexOf(q) >= 0
        );
      });
      if (!hits.length) palList.appendChild(el('div', 'pitem head', '没有匹配'));
      hits.forEach(pushSite);
    }

    palSel = 0;
    highlightPal();
  }

  function highlightPal() {
    palItems.forEach(function (p, i) { p.node.classList.toggle('sel', i === palSel); });
    if (palItems[palSel] && palItems[palSel].node.scrollIntoView) {
      try { palItems[palSel].node.scrollIntoView({ block: 'nearest' }); } catch (e) { /* noop */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  设置
  // ══════════════════════════════════════════════════════════════════════════
  function openSettings() {
    settingsEl.classList.add('on');
    renderSettings();
    syncOverlay();
    apply(true);
    updateDock();
  }

  function closeSettings() {
    settingsEl.classList.remove('on');
    syncOverlay();
    apply(true);
  }

  function seg(container, options, current, onPick) {
    container.innerHTML = '';
    options.forEach(function (o) {
      var b = el('button', o.value === current ? 'on' : '', o.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(container.children, function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        onPick(o.value);
      });
      container.appendChild(b);
    });
  }

  function sw(btn, on, onToggle) {
    btn.classList.toggle('on', !!on);
    btn.onclick = function () {
      var next = !btn.classList.contains('on');
      btn.classList.toggle('on', next);
      onToggle(next);
    };
  }

  function renderSettings() {
    var c = S.cfg;

    sw($('swHover'), c.peekOnHover, function (v) {
      c.peekOnHover = v;
      SF.patchConfig({ peekOnHover: v });
      if (!v) { S.hovered = false; apply(true); }
    });

    var rngLeave = $('rngLeave');
    rngLeave.value = c.hideOnLeave;
    $('numLeave').textContent = c.hideOnLeave === 0 ? '立刻' : (c.hideOnLeave / 1000).toFixed(1) + 's';
    rngLeave.oninput = function () {
      c.hideOnLeave = Number(rngLeave.value);
      $('numLeave').textContent = c.hideOnLeave === 0 ? '立刻' : (c.hideOnLeave / 1000).toFixed(1) + 's';
      SF.patchConfig({ hideOnLeave: c.hideOnLeave });
    };

    seg($('segOnLeave'), [
      { value: 'mask', label: '变代码' },
      { value: 'hide', label: '藏起来' }
    ], c.onLeave === 'hide' ? 'hide' : 'mask', function (v) { setOnLeave(v); });

    var rngDim = $('rngDim');
    rngDim.value = Math.round((c.dimLive || 0) * 100);
    $('numDim').textContent = rngDim.value + '%';
    rngDim.oninput = function () {
      c.dimLive = rngDim.value / 100;
      $('numDim').textContent = rngDim.value + '%';
      SF.patchConfig({ dimLive: c.dimLive });
      fitStage();
    };

    sw($('swCursor'), c.hideCursor, function (v) {
      c.hideCursor = v;
      SF.patchConfig({ hideCursor: v });
      updateCursorClass();
    });

    $('btnSizeMenu').onclick = function () {
      openMenu(sizeItems(), { anchor: $('btnSizeMenu'), title: '窗口大小' });
    };

    var rngOp = $('rngOpacity');
    rngOp.value = Math.round((c.opacity || 1) * 100);
    $('numOpacity').textContent = rngOp.value + '%';
    rngOp.oninput = function () {
      c.opacity = rngOp.value / 100;
      $('numOpacity').textContent = rngOp.value + '%';
      SF.setOpacity(c.opacity);
    };

    seg($('segTop'), [
      { value: 'floating', label: '置顶' },
      { value: 'screen-saver', label: '最高' },
      { value: 'off', label: '不置顶' }
    ], c.alwaysOnTop, function (v) {
      c.alwaysOnTop = v;
      SF.setAlwaysOnTop(v);
    });

    seg($('segMask'), M.order.map(function (k) {
      return { value: k, label: MASK_ZH[k] || k };
    }), c.mask, function (v) {
      c.mask = v;
      SF.patchConfig({ mask: v });
      mountMask(v);
    });

    sw($('swFollow'), c.maskFollowsFile !== false, function (v) {
      c.maskFollowsFile = v;
      SF.patchConfig({ maskFollowsFile: v });
      if (v) remountFollowedMasks();
    });

    sw($('swReal'), c.showRealNames !== false, function (v) {
      c.showRealNames = v;
      SF.patchConfig({ showRealNames: v });
      toast(v ? '菜单里会显示真实站点名' : '菜单里只显示文件名');
    });

    sw($('swClean'), c.clean !== false, function (v) { setClean(v); });

    sw($('swDbl'), c.doubleClickPin !== false, function (v) {
      c.doubleClickPin = v;
      SF.patchConfig({ doubleClickPin: v });
    });

    sw($('swGuard'), c.screenGuard, function (v) {
      c.screenGuard = v;
      SF.setScreenGuard(v);
      toast(v ? '录屏保护已开启' : '录屏保护已关闭');
    });
    sw($('swBlur'), c.hideOnBlur, function (v) {
      c.hideOnBlur = v;
      SF.patchConfig({ hideOnBlur: v });
    });
    sw($('swMuteOnHide'), c.muteOnHide, function (v) {
      c.muteOnHide = v;
      SF.patchConfig({ muteOnHide: v });
      syncAudio();
    });
    sw($('swLock'), c.lockMask, function (v) {
      c.lockMask = v;
      SF.patchConfig({ lockMask: v });
      apply(true);
    });

    renderSiteList();
    renderHotkeys();
    if (cfgPathEl) cfgPathEl.textContent = S.cfgPath || '';
  }

  function renderSiteList() {
    siteListEl.innerHTML = '';
    S.sites.forEach(function (s) {
      var row = el('div', 'si' + (s.id === S.cfg.siteId ? ' on' : ''));
      var dot = el('span', 'pdot');
      dot.style.background = s.dot || '#8ab4ff';
      dot.style.width = '5px';
      dot.style.height = '5px';
      dot.style.borderRadius = '50%';
      dot.style.flex = 'none';
      row.appendChild(dot);
      row.appendChild(el('span', 'sn', s.file));
      row.appendChild(el('span', 'sr', s.real));
      row.addEventListener('click', function () {
        activateSite(s.id);
        renderSiteList();
      });
      siteListEl.appendChild(row);
    });
  }

  function renderHotkeys() {
    hotkeyListEl.innerHTML = '';
    S.hotkeys.forEach(function (h) {
      var row = el('div', 'srow');
      row.appendChild(el('div', 'slabel', h.desc));
      var ctl = el('div', 'sctl');
      var bad = (S.hotkeyFailures || []).indexOf(h.acc) >= 0;
      var k = el('span', 'hk' + (bad ? ' pending' : ''), h.acc);
      if (bad) k.title = '已被其它软件占用（不影响使用）';
      ctl.appendChild(k);
      row.appendChild(ctl);
      hotkeyListEl.appendChild(row);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  来自主进程的指令
  // ══════════════════════════════════════════════════════════════════════════
  function handleCmd(cmd) {
    if (!cmd) return;
    switch (cmd.type) {
      case 'cursor':
        onCursor(cmd.inside);
        break;

      case 'idle':
        setIdle(cmd.idle);
        break;

      case 'ctxmenu': {
        // 视频区是独立 webview，右键事件在那边被主进程接住后转发过来。
        // 坐标是 webview 视口坐标，换算成窗口坐标。
        var fr = frame.getBoundingClientRect();
        openMenu(ctxItems(), { at: { x: fr.left + cmd.x, y: fr.top + cmd.y } });
        break;
      }

      case 'pin-toggle':
        togglePin();
        break;

      case 'peek':
        S.pinned = false;
        S.peekUntil = Date.now() + (S.cfg.peekMs || 5000);
        updatePinUI();
        apply(true);
        break;

      case 'panic':
        panic();
        break;

      case 'blur':
        S.mouseIn = false;
        S.hovered = false;
        clearTimeout(enterTimer);
        clearTimeout(leaveTimer);
        if (S.cfg.hideOnBlur) {
          S.pinned = false;
          S.peekUntil = 0;
        }
        closeMenu();
        closePalette();
        closeSettings();
        syncOverlay();
        updatePinUI();
        updateDock();
        apply(true);
        break;

      case 'focus':
        apply(true);
        break;

      case 'mask':
        if (cmd.value === 'on') {
          S.pinned = false;
          S.peekUntil = 0;
          S.hovered = false;
          updatePinUI();
          apply(true);
        }
        break;

      case 'site':
        activateSite(cmd.value);
        break;

      case 'preset':
        S.cfg.preset = cmd.value;
        setTimeout(function () { fitStage(); updateSizeLabel(); }, 60);
        break;

      case 'free-size':
        setTimeout(updateSizeLabel, 20);
        break;

      case 'config':
        S.cfg = cmd.value;
        // 设置面板开着的话要跟着刷新 —— 托盘也能改同一批配置，
        // 不重渲染会出现「托盘改了、面板上还是旧值」的错位
        if (settingsEl.classList.contains('on')) renderSettings();
        apply(true);
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  事件
  // ══════════════════════════════════════════════════════════════════════════
  function bindEvents() {
    // ── 右键：整个窗口都能出菜单
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (MENU.open) { closeMenu(); return; }
      if (S.overlay) return; // 设置面板里右键不弹
      openMenu(ctxItems(), { at: { x: e.clientX, y: e.clientY } });
    });

    // ── 菜单点外面关掉
    document.addEventListener('pointerdown', function (e) {
      if (!MENU.open) return;
      if (menuEl.contains(e.target)) return;
      MENU.closedAt = Date.now();
      closeMenu();
    }, true);

    // ── 标签栏按钮
    $('btnAdd').addEventListener('click', openPalette);
    $('btnMask').addEventListener('click', function () { menuToggle($('btnMask'), maskItems, '藏起来时显示什么'); });
    $('btnSettings').addEventListener('click', openSettings);
    $('btnCloseSettings').addEventListener('click', closeSettings);
    $('btnQuit').addEventListener('click', function () { SF.quit(); });
    eyeBtn.addEventListener('click', togglePin);

    // ── 状态栏：每一项都能点
    sbSource.addEventListener('click', function () { menuToggle(sbSource, sourceItems, '看哪个'); });
    sbMaskBtn.addEventListener('click', function () { menuToggle(sbMaskBtn, maskItems, '藏起来时显示什么'); });
    sbSize.addEventListener('click', function () { menuToggle(sbSize, sizeItems, '窗口大小'); });

    // ── 操作条
    $('dkSource').addEventListener('click', function () { menuToggle($('dkSource'), sourceItems, '看哪个'); });
    $('dkMask').addEventListener('click', function () { menuToggle($('dkMask'), maskItems, '藏起来时显示什么'); });
    $('dkSize').addEventListener('click', function () { menuToggle($('dkSize'), sizeItems, '窗口大小'); });
    $('dkRate').addEventListener('click', function () { menuToggle($('dkRate'), rateItems, '播放速度'); });
    $('dkClean').addEventListener('click', function () { setClean(S.cfg.clean === false); });
    $('dkPin').addEventListener('click', togglePin);
    $('dkReload').addEventListener('click', function () {
      if (S.webview && S.webview.reload) S.webview.reload();
      toast('已刷新');
    });
    $('dkSettings').addEventListener('click', openSettings);
    $('dkMute').addEventListener('click', function () {
      S.userMuted = !S.userMuted;
      $('dkMute').classList.toggle('on', S.userMuted);
      saveSitePref(S.cfg.siteId, { muted: S.userMuted });
      syncAudio();
      toast(S.userMuted ? '已静音' : '已取消静音');
    });

    // ── 双击画面 = 钉住 / 松开（比去找那个按钮快）
    canvas.addEventListener('dblclick', function (e) {
      if (S.cfg.doubleClickPin === false) return;
      if (S.overlay) return;
      if (e.target.closest && e.target.closest('#dock')) return;
      togglePin();
    });

    // ── 滚轮：画面露出时把滚轮交给页面；窗口没露画面就用来换来源
    canvas.addEventListener('wheel', function (e) {
      if (S.revealed || S.overlay) return;   // 交给 webview 自己滚
      if (Math.abs(e.deltaY) < 12) return;
      var ids = S.cfg.openTabs || [];
      if (ids.length < 2) return;
      var i = ids.indexOf(S.cfg.siteId);
      var dir = e.deltaY > 0 ? 1 : -1;
      if (i < 0) i = 0;
      activateSite(ids[(i + dir + ids.length) % ids.length]);
    }, { passive: true });

    // ── 快速打开
    palInput.addEventListener('input', function () { renderPalette(this.value); });
    palInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        palSel = Math.min(palSel + 1, palItems.length - 1);
        highlightPal();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        palSel = Math.max(palSel - 1, 0);
        highlightPal();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (palItems[palSel]) {
          activateSite(palItems[palSel].site.id);
          closePalette();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
      }
    });
    palette.addEventListener('click', function (e) {
      if (e.target === palette) closePalette();
    });

    // ── 窗口内键盘（都不是必须的，顺手而已 —— 因为窗口内按键不会漏给别的程序）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (MENU.open) return closeMenu();
        if (palette.classList.contains('on')) return closePalette();
        if (settingsEl.classList.contains('on')) return closeSettings();
        return panic();
      }
      if (e.ctrlKey || e.metaKey) {
        var k = e.key.toLowerCase();
        if (k === 'p') {
          e.preventDefault();
          palette.classList.contains('on') ? closePalette() : openPalette();
          return;
        }
        if (e.key === ',') {
          e.preventDefault();
          settingsEl.classList.contains('on') ? closeSettings() : openSettings();
          return;
        }
        if (k === 'r') {
          e.preventDefault();
          if (S.webview && S.webview.reload) S.webview.reload();
          return;
        }
        if (k === 'd') {
          e.preventDefault();
          togglePin();
          return;
        }
      }
      // 数字 1~5 直接换面具
      if (/^[1-5]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
        var ids = M.order;
        var idx = Number(e.key) - 1;
        if (ids[idx]) setMask(ids[idx]);
      }
    });

    // ── 尺寸变化
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        fitStage();
        layoutClass();
        updateSizeLabel();
      });
      ro.observe(canvas);
    }
    window.addEventListener('resize', function () {
      fitStage();
      layoutClass();
      updateSizeLabel();
      if (MENU.open) positionMenu();
    });
  }

  function layoutClass() {
    var w = window.innerWidth;
    shell.classList.toggle('compact', w < 372);
    shell.classList.toggle('micro', w < 262);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  启动
  // ══════════════════════════════════════════════════════════════════════════
  function boot() {
    SF.onCmd(handleCmd);

    SF.init().then(function (data) {
      S.cfg = data.config;
      S.sites = data.sites;
      S.presets = data.presets;
      S.presetOrder = SH.PRESET_ORDER;
      S.masksList = data.masks || [];
      S.masks = data.masks;
      S.rates = data.rates || [1, 1.25, 1.5, 2];
      S.hotkeys = data.hotkeys || [];
      S.hotkeyFailures = data.hotkeyFailures || [];
      S.chromeH = data.chromeH || 52;
      S.cfgPath = data.cfgPath || '';
      SH.MOBILE_UA = data.mobileUA;
      SH.DESKTOP_UA = data.desktopUA;

      mountMask(S.cfg.mask || 'code');
      bindEvents();
      startRatePump();
      layoutClass();
      updateSizeLabel();
      updatePinUI();
      updateRateLabel();
      updateCleanButton();
      sbBranch.textContent = S.cfg.branch || 'main';

      var start = findSite(S.cfg.siteId);
      if (start) activateSite(start.id, { silent: true });

      setTimeout(function () { fitStage(); updateSizeLabel(); apply(true); }, 120);
      apply(true);

      // 第一次用给一句提示：不用教怎么按键，只教「鼠标移进来」
      if (S.cfg.firstRun !== false) {
        S.cfg.firstRun = false;
        SF.patchConfig({ firstRun: false });
        setTimeout(function () {
          toast('鼠标移进来就看，移开自动收回', 4200);
        }, 900);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 自检 / 外部驱动用的最小接口
  window.__SF = {
    state: S,
    pin: function (v) { S.pinned = !!v; S.peekUntil = 0; updatePinUI(); apply(true); },
    hover: function (v) {
      S.mouseIn = !!v;
      S.hovered = !!v;
      S.mouseY = v ? window.innerHeight - 10 : -1;
      if (v) S.dockHintUntil = Date.now() + 2600;
      updateDock();
      apply(true);
    },
    dock: function (v) { S.dockForce = v === undefined ? true : !!v; updateDock(); },
    // 自检用的探针。默认只报窗口侧布局尺寸（快）；
    // probe(true) 才会去问 webview 内部 —— 往 guest 里打 JS 有可能要等好几秒
    // （页面主线程忙的时候），所以不能默认跑。
    probe: function (deep) {
      var out = {
        inner: [window.innerWidth, window.innerHeight],
        canvas: [canvas.clientWidth, canvas.clientHeight],
        frame: [frame.clientWidth, frame.clientHeight],
        live: [liveLayer.clientWidth, liveLayer.clientHeight]
      };
      if (!deep || !S.webview) return Promise.resolve(JSON.stringify(out));
      out.wv = [S.webview.clientWidth, S.webview.clientHeight];
      return S.webview
        .executeJavaScript(
          'JSON.stringify({ua:navigator.userAgent.slice(0,60),href:location.href,' +
          'vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio,' +
          'de:[document.documentElement.clientWidth,document.documentElement.clientHeight]})'
        )
        .then(function (r) {
          out.page = JSON.parse(r);
          return JSON.stringify(out);
        })
        .catch(function (e) {
          out.err = String((e && e.message) || e);
          return JSON.stringify(out);
        });
    },
    quiet: function (v) {
      S.quiet = v === undefined ? true : !!v;
      if (S.quiet) toastEl.classList.remove('on');
    },
    idle: function (v) { setIdle(v); },
    menu: function (kind) {
      var map = { source: 'dkSource', mask: 'dkMask', size: 'dkSize', rate: 'dkRate', onleave: 'dkMask' };
      var anchor = $(map[kind] || 'dkSource');
      var items = kind === 'mask' ? maskItems()
        : kind === 'size' ? sizeItems()
          : kind === 'rate' ? rateItems()
            : kind === 'onleave' ? onLeaveItems()
              : sourceItems();
      var title = kind === 'mask' ? '藏起来时显示什么'
        : kind === 'size' ? '窗口大小'
          : kind === 'rate' ? '播放速度'
            : kind === 'onleave' ? '移开后' : '看哪个';
      openMenu(items, { anchor: anchor, title: title });
    },
    ctx: function () { openMenu(ctxItems(), { at: { x: 40, y: 60 } }); },
    setMask: setMask,
    site: function (id) { activateSite(id, { silent: true, noHint: true }); },
    preset: function (p) { S.cfg.preset = p; SF.setPreset(p); setTimeout(function () { fitStage(); updateSizeLabel(); }, 80); },
    settings: openSettings,
    palette: openPalette,
    closeAll: function () { closeMenu(); closePalette(); closeSettings(); syncOverlay(); apply(true); },
    panic: panic
  };
})();

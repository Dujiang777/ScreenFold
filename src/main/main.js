'use strict';
/**
 * 屏风 ScreenFold — 主进程
 *
 * 职责：
 *   1. 造一个「看起来是编辑器面板」的无边框小窗
 *   2. 窗口级防护：不进任务栏、标题伪装、录屏不可见
 *   3. 托盘常驻
 *   4. 拖拽缩放（渲染进程算好 bounds，这里落下去）
 *
 * 交互原则（v2 起）：**一切都能用鼠标做完，不需要记任何键。**
 * 全局热键只保留 3 个「万一用得上」的，其余操作全部走窗口内菜单 / 拖拽。
 * 上一版把 Ctrl+Alt+↑/↓ 这类注册成全局热键是错的 —— 那正好是 VS Code
 * 的多光标快捷键，会把用户的编辑器抢走。已移除。
 */
const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  shell,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');

const SHARED = require('../shared/sites');
const { SITES, PRESETS, CHROME_H, DEFAULT_CONFIG, MOBILE_UA, DESKTOP_UA, RATES, LIMITS } = SHARED;
const { makeIconBuffer } = require('./icon');

// 让视频页可以自动播放，不用先点一下
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 关掉 Chromium 那套「受自动化控制」的痕迹，减少被站点识别
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const isDev = process.argv.includes('--dev');
// --sf-debug：把尺寸决策打到 stdout，排查「窗口自己变小」这类问题用。
// 注意别叫 --debug —— 那是 Node 的废弃参数，Electron 会直接报错退出。
// 必须用 startsWith —— 截图参数是 `--shot=shots`，写 includes('--shot') 永远匹配不上，
// 之前就是因为这个，调试日志一条都没打出来。
const DEBUG = process.argv.some((a) => a.startsWith('--sf-debug') || a.startsWith('--shot'));
function dbg() {
  if (!DEBUG) return;
  console.log('[dbg]', Array.prototype.slice.call(arguments).join(' '));
}

// 最小尺寸必须 <= 最小的预设（nano），否则选「细条」会被钳上去，
// 而 config.preset 还写着 nano —— 两边对不上，freeSize 就会存进错的值。
//
// 这个下限同时是 OS 层面的硬约束。早期定成 176x150 太小（一次误拖能把窗口
// 缩成一条缝），后来收得太紧到 240x200 —— 结果用户**主动想缩小也缩不动**，
// 被 USABLE_* 守卫弹回去，体验上就是「窗口只能这么大」。
// 现在的取舍：放到 150x132，窄到能装成编辑器左侧的「大纲/侧栏」面板，
// 宽 150 ≈ 一行 24 字符的代码 —— 小，但仍然是一块能看的屏幕。
// 误拖那份风险交给 SHOW_GUARD_MS（窗口刚弹出时把整段拖拽作废）去挡，
// 不该靠抬高下限来兜。
const MIN_W = 150;
const MIN_H = 132;

// 拖得比这还小 → 判定为误操作，撤销并还原。
// 必须严格大于 MIN_W：否则「被钳到下限」的结果会落进这个区间，被当成用户的
// 真实选择存进配置，还原点也被污染（这个坑踩过一次）。
// 高度比的是「内容区高度」（已经减掉外壳），所以 USABLE_H 要 > MIN_H - CHROME_H。
const USABLE_W = 164;
const USABLE_H = 90; // 内容区高度，不含外壳

// 窗口刚显示的头 N ms 内，拒绝一切缩放请求。
// 原因：窗口是置顶无边框的，如果弹出那一刻鼠标左键正按着（比如你正在别的
// 窗口里拖选文字、拖窗口），Windows 会把这次持续的拖动算到我们这个窗口头上，
// 从光标所在的边缘一路缩下去。
const SHOW_GUARD_MS = 1500;
// 一次连续拖拽里 will-resize 是几毫秒一条。手停一下再继续也算同一段，
// 所以空闲窗口给宽一点 —— 太短会让「挡掉整段拖拽」漏气，变成来回拉锯。
const RESIZE_IDLE_MS = 900;

// 配置版本号：改了默认值的语义就 +1，好让老配置跟着迁移
// v4：新增 onLeave（移开后 = 面具还是隐藏）；窗口下限放宽到 150x132
const CFG_V = 4;

let win = null;
let tray = null;
let quitting = false;
// 程序自己改 bounds 时置真，用来区分「用户拖拽」和「我们设的预设」
let applyingBounds = false;
let applyingBoundsTimer = null;
// 用户正在拖窗口边缘缩放
let manualResize = false;
// 最近一次「已知良好」的 bounds，误拖缩小时用来还原
let lastGoodBounds = null;
// 窗口显示的时刻，配合 SHOW_GUARD_MS 挡掉「弹出时鼠标正按着」造成的误拖
let shownAt = 0;

// ── 配置持久化 ──────────────────────────────────────────────────────────────
let config = Object.assign({}, DEFAULT_CONFIG);

function cfgPath() {
  return path.join(app.getPath('userData'), 'screenfold.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(cfgPath(), 'utf8');
    config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
  } catch (e) {
    config = Object.assign({}, DEFAULT_CONFIG);
  }
  sanitizeConfig();
  return config;
}

// 自愈 + 迁移：配置里如果有不可信的值（比如尺寸小到没法用），就地回退，
// 免得一个坏值粘在配置里，之后每次启动都是坏的。
function sanitizeConfig() {
  // v1 → v2：默认「离开多久收回」从 1200ms 收紧到 400ms。
  // 老配置里如果还留着那个旧默认值，跟着升上来。
  if ((config.cfgV || 1) < 2 && config.hideOnLeave === 1200) config.hideOnLeave = 400;
  // v2 → v3：新增倍速 / 净化 / 双击钉住 / 面具跟文件。老配置没有这些键，
  // 走 DEFAULT_CONFIG 的默认值即可，这里只补一次版本号。
  // v3 → v4：新增 onLeave；预设表重排（多了 nano、少了旧的语义）。老配置里
  // 的 preset 名都还在，无需改名，只补版本号。
  config.cfgV = CFG_V;

  // 「移开后」只认两个值，写坏了就当没设置过（回默认的「变代码」）
  if (config.onLeave !== 'hide' && config.onLeave !== 'mask') config.onLeave = 'mask';

  // 预设名要是已经不存在了（以后删过预设），别让它把 presetSize 带进兜底分支
  if (config.preset !== 'free' && !PRESETS[config.preset]) config.preset = 'short';

  // 数值型配置一律钳进合法区间 —— 手改配置文件写坏了也不至于让界面失控
  if (!Number.isFinite(config.opacity)) config.opacity = DEFAULT_CONFIG.opacity;
  config.opacity = Math.min(1, Math.max(LIMITS.opacityMin, config.opacity));

  if (!Number.isFinite(config.dimLive)) config.dimLive = DEFAULT_CONFIG.dimLive;
  config.dimLive = Math.min(LIMITS.dimMax, Math.max(0, config.dimLive));

  if (!Number.isFinite(config.hideOnLeave)) config.hideOnLeave = DEFAULT_CONFIG.hideOnLeave;
  config.hideOnLeave = Math.min(LIMITS.leaveMax, Math.max(0, config.hideOnLeave));

  if (!Number.isFinite(config.volume)) config.volume = DEFAULT_CONFIG.volume;
  config.volume = Math.min(100, Math.max(0, config.volume));

  // 倍速必须是 RATES 里的值 —— 别的值会让「倍速」按钮上没有一项是勾选的
  if (RATES.indexOf(config.rate) < 0) config.rate = 1;

  if (!config.perSite || typeof config.perSite !== 'object') config.perSite = {};
  if (!config.seenSite || typeof config.seenSite !== 'object') config.seenSite = {};

  if (!Array.isArray(config.custom)) config.custom = [];
  if (!Array.isArray(config.openTabs) || !config.openTabs.length) {
    config.openTabs = (DEFAULT_CONFIG.openTabs || []).slice();
  }

  if (config.alwaysOnTop !== 'off' && config.alwaysOnTop !== 'screen-saver') {
    config.alwaysOnTop = 'floating';
  }

  const f = config.freeSize;
  const badFree =
    config.preset === 'free' &&
    (!f || !Number.isFinite(f.w) || !Number.isFinite(f.h) ||
      f.w < LIMITS.minContentW || f.h < LIMITS.minContentH);
  if (badFree) {
    config.preset = 'short';
    config.freeSize = null;
  }
  if (config.pos && (!Number.isFinite(config.pos.x) || !Number.isFinite(config.pos.y))) {
    config.pos = null;
  }
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(cfgPath(), JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      /* 忽略写入失败 */
    }
  }, 250);
}

// ── 站点查询 ────────────────────────────────────────────────────────────────
function allSites() {
  return SITES.concat(config.custom || []);
}

function findSite(id) {
  const list = allSites();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return list[0];
}

// 窗口标题 = Alt+Tab / 任务管理器里看到的东西。
// 必须和标签栏上的文件名对上 —— 标题写着 route.ts、标签写着 media.player.tsx
// 是比「窗口太小」更明显的破绽。渲染进程每次换来源 / 换面具都会同步过来。
function decoyTitleFor(siteId, mask) {
  const site = findSite(siteId);
  const file = site ? site.file : 'feed.aggregator.ts';
  const project = config.project || 'inkstack';
  if (mask === 'diff') return `${file} (Changes) \u2014 ${project} \u2014 Visual Studio Code`;
  if (mask === 'log' || mask === 'test') return `${file} \u2014 Terminal \u2014 ${project}`;
  if (mask === 'git') return `Git Graph \u2014 ${project}`;
  return `${file} \u2014 ${project} \u2014 Visual Studio Code`;
}

// ── 尺寸 ────────────────────────────────────────────────────────────────────
// preset='free' 表示用户自己拖出来的尺寸，这时不再往预设上吸。
function presetSize(name) {
  if (name === 'free') {
    const f = config.freeSize;
    if (f && f.w >= MIN_W && f.h >= MIN_H - CHROME_H) {
      return { w: Math.round(f.w), h: Math.round(f.h) + CHROME_H };
    }
  }
  const p = PRESETS[name] || (name !== 'free' && PRESETS[config.preset]) || PRESETS.short;
  return { w: p.w, h: p.h + CHROME_H };
}

function clampToDisplay(b) {
  let x = b.x;
  let y = b.y;

  // 尺寸只保证不小于下限。
  // 千万别拿「匹配到的显示器工作区」去钳尺寸 —— 窗口位置稍微越界，
  // getDisplayMatching 就可能匹配到另一块（或一块尺寸异常）的显示器，
  // 于是 Math.min(wa.width, ...) 会把窗口压成最小值，再被当成用户的选择存下来，
  // 一轮轮棘轮式缩小。窗口比屏幕大是允许的，位置别丢就行。
  const width = Math.max(MIN_W, Math.round(b.width));
  const height = Math.max(MIN_H, Math.round(b.height));

  const disp = screen.getDisplayMatching({ x: x, y: y, width: width, height: height });
  const wa = disp.workArea;

  // 至少留 60px 在屏幕里，避免窗口被拖没
  x = Math.min(Math.max(x, wa.x - width + 60), wa.x + wa.width - 60);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - 32);

  return { x: Math.round(x), y: Math.round(y), width: width, height: height };
}

function applyBounds(b, programmatic) {
  if (!win || win.isDestroyed()) return null;
  const next = clampToDisplay(b);
  dbg('applyBounds', JSON.stringify(b), '->', JSON.stringify(next), programmatic ? '(prog)' : '(USER)');
  if (programmatic) {
    applyingBounds = true;
    clearTimeout(applyingBoundsTimer);
    applyingBoundsTimer = setTimeout(() => { applyingBounds = false; }, 1200);
  }
  win.setBounds(next, false);
  rememberGoodBounds(next);
  return next;
}

// 只有「能看的」尺寸才值得记下来当还原点
function rememberGoodBounds(b) {
  if (!b) return;
  if (b.width < USABLE_W || b.height - CHROME_H < USABLE_H) return;
  lastGoodBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
}

// 一次误拖把窗口缩成了没法看的大小 —— 直接还原，别让用户自己去修
function restoreGoodSize(reason) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const target = lastGoodBounds || Object.assign({ x: b.x, y: b.y }, presetSize(config.preset));
  dbg('restore good size (' + reason + ')', JSON.stringify(b), '->', JSON.stringify(target));
  applyBounds(target, true);
}


// ── 窗口 ────────────────────────────────────────────────────────────────────
function createWindow() {
  const size = presetSize(config.preset);
  dbg('createWindow preset=' + config.preset, 'freeSize=' + JSON.stringify(config.freeSize), 'size=' + JSON.stringify(size));
  dbg('displays', JSON.stringify(screen.getAllDisplays().map((d) => ({
    id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor
  }))), 'primary=' + screen.getPrimaryDisplay().id);
  const work = screen.getPrimaryDisplay().workAreaSize;
  dbg('primary workAreaSize', JSON.stringify(work));

  let x;
  let y;
  if (config.pos && Number.isFinite(config.pos.x) && Number.isFinite(config.pos.y)) {
    x = config.pos.x;
    y = config.pos.y;
  } else {
    // 默认贴右下角 —— 视线余光能扫到，但不挡着主工作区
    x = work.width - size.w - 28;
    y = work.height - size.h - 28;
  }
  // 别让初始位置跑到屏幕外面去 —— 越界的窗口会让 getDisplayMatching
  // 匹配到别的显示器，后面算出来的东西就都不准了
  x = Math.max(0, Math.min(Math.round(x), Math.max(0, work.width - size.w)));
  y = Math.max(0, Math.min(Math.round(y), Math.max(0, work.height - size.h)));

  win = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: Math.round(x),
    y: Math.round(y),
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: false,
    backgroundColor: '#12141c',
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true, // 不进任务栏
    alwaysOnTop: true,
    show: false,
    title: decoyTitleFor(config.siteId, config.mask), // Alt+Tab 里看到的是这个
    type: 'toolbar', // Windows: WS_EX_TOOLWINDOW，尽量不进 Alt+Tab
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false, // 失焦时别把视频节流了
      spellcheck: false,
      devTools: isDev
    }
  });

  win.setAlwaysOnTop(true, config.alwaysOnTop === 'screen-saver' ? 'screen-saver' : 'floating');
  dbg('bounds@ctor', JSON.stringify(win.getBounds()));
  win.setSkipTaskbar(true);
  dbg('bounds@skipTaskbar', JSON.stringify(win.getBounds()));
  win.setContentProtection(!!config.screenGuard);
  dbg('bounds@contentProtection', JSON.stringify(win.getBounds()));
  win.setOpacity(typeof config.opacity === 'number' ? config.opacity : 1);
  win.setMenuBarVisibility(false);
  dbg('bounds@menuBar', JSON.stringify(win.getBounds()));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    dbg('bounds@ready-to-show', JSON.stringify(win.getBounds()));
    win.show();
    // 记下显示时刻 + 初始良好尺寸：
    // 显示时刻用来挡「弹出时鼠标正按着」造成的误拖，
    // 初始尺寸用来在误拖把窗口缩坏之后还原。
    shownAt = Date.now();
    rememberGoodBounds(win.getBounds());
    dbg('bounds@show', JSON.stringify(win.getBounds()));
    win.setSkipTaskbar(true);
    win.setContentProtection(!!config.screenGuard);

    const shotArg = process.argv.find((a) => a.startsWith('--shot='));
    if (shotArg) runSelfShot(shotArg.slice('--shot='.length));
  });

  // 失焦 —— 最常用也最有效的兜底
  win.on('blur', () => {
    send('sf:cmd', { type: 'blur' });
  });

  win.on('focus', () => {
    send('sf:cmd', { type: 'focus' });
  });

  // 用户拖出来的尺寸 → 记成 free，之后不再被预设覆盖。
  // 判断「是不是用户拖的」只认 will-resize —— 那个事件只有交互式缩放才会触发，
  // 程序自己 setBounds 不会。光靠 applyingBounds 标记不够稳（resized 是异步的，
  // 标记可能已经过期），所以两个条件都要求。
  let sizeTimer = null;
  let userResized = false;
  // 整段拖拽被整体挡掉的状态（见 SHOW_GUARD_MS 的说明）
  let resizeBlocked = false;
  let resizeIdleTimer = null;
  let resizeLogCount = 0;

  // 把「当前这一段连续拖拽」整体作废。
  // 关键是「整段」：只挡当前这一条 will-resize 没用，拖拽还在继续，下一条
  // 立刻又把窗口缩回去，于是和还原动作来回拉锯。所以一旦判定作废，就持续挡，
  // 直到 400ms 内没有新的 will-resize（说明手松开了）才解除。
  function blockRestOfDrag(why) {
    resizeBlocked = true;
    // 顺带把「刚显示」的时刻推到当下：这样 SHOW_GUARD_MS 那道闸也重新上膛，
    // 拖拽就算中途停顿一下也依然被挡着，不会漏出去把窗口又缩回去。
    shownAt = Date.now();
    dbg('resize blocked (' + why + ')');
    clearTimeout(resizeIdleTimer);
    resizeIdleTimer = setTimeout(() => {
      resizeBlocked = false;
      manualResize = false;
      dbg('resize block released');
    }, RESIZE_IDLE_MS);
  }

  win.on('will-resize', (e, nb, details) => {
    // 弹出瞬间就按着左键 —— 这一整段拖拽直接作废
    if (!resizeBlocked && Date.now() - shownAt < SHOW_GUARD_MS) {
      blockRestOfDrag('started ' + (Date.now() - shownAt) + 'ms after show');
    }
    if (resizeBlocked) {
      e.preventDefault();
      manualResize = true;
      clearTimeout(resizeIdleTimer);
      resizeIdleTimer = setTimeout(() => {
        resizeBlocked = false;
        manualResize = false;
        dbg('resize block released');
      }, RESIZE_IDLE_MS);
      return;
    }

    manualResize = true;
    userResized = true;
    // 光标位置是判断「真拖拽 vs 别的东西在动窗口」的关键证据：
    // 真拖拽时，光标必然贴着被拖的那条边/角。
    if (resizeLogCount++ < 3) {
      dbg('will-resize', JSON.stringify(nb), 'edge=' + (details && details.edge),
        'cursor=' + JSON.stringify(screen.getCursorScreenPoint()));
    }
  });

  win.on('resized', () => {
    manualResize = false;
    if (resizeBlocked) return; // 被挡掉的拖拽，不记尺寸
    const b0 = win && !win.isDestroyed() ? win.getBounds() : null;
    dbg('resized', JSON.stringify(b0),
      'applyingBounds=' + applyingBounds, 'userResized=' + userResized);
    if (applyingBounds) {
      applyingBounds = false;
      clearTimeout(applyingBoundsTimer);
      return;
    }
    if (!win || win.isDestroyed() || !userResized) return;

    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      userResized = false;
      manualResize = false;
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const w = b.width;
      const cH = b.height - CHROME_H;

      // 拖到没法看的大小 —— 不当成用户的选择。还原，并且把这一段拖拽整体作废，
      // 否则拖拽还在继续，下一条 will-resize 立刻又把窗口缩回去，来回拉锯。
      if (w < USABLE_W || cH < USABLE_H) {
        restoreGoodSize('resized to ' + w + 'x' + cH);
        blockRestOfDrag('restored from ' + w + 'x' + cH);
        return;
      }
      config.preset = 'free';
      config.freeSize = { w: w, h: cH };
      config.pos = { x: b.x, y: b.y };
      saveConfig();
      rememberGoodBounds(b);
      send('sf:cmd', { type: 'free-size', value: config.freeSize });
      if (tray) tray.setContextMenu(buildTrayMenu());
    }, 260);
  });

  // 移动后贴边（debounce，避免拖动过程中抖）；手动缩放期间不贴
  let moveTimer = null;
  win.on('moved', () => {
    if (applyingBounds || manualResize) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(snapToEdge, 220);
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  // 窗口内容不许开新窗口 / 不许跳系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function snapToEdge() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const disp = screen.getDisplayMatching(b);
  const wa = disp.workArea;
  const THRESH = 24;
  let nx = b.x;
  let ny = b.y;

  if (Math.abs(b.x - wa.x) < THRESH) nx = wa.x;
  if (Math.abs(b.y - wa.y) < THRESH) ny = wa.y;
  if (Math.abs(b.x + b.width - (wa.x + wa.width)) < THRESH) nx = wa.x + wa.width - b.width;
  if (Math.abs(b.y + b.height - (wa.y + wa.height)) < THRESH) ny = wa.y + wa.height - b.height;

  nx = Math.max(wa.x, Math.min(nx, wa.x + wa.width - b.width));
  ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - b.height));

  if (nx !== b.x || ny !== b.y) {
    applyBounds({ x: nx, y: ny, width: b.width, height: b.height }, true);
    config.pos = { x: nx, y: ny };
    saveConfig();
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── 真实鼠标位置探测 ────────────────────────────────────────────────────────
// 为什么不用 DOM 的 mouseenter/mouseleave：视频画面跑在独立的 <webview> 里，
// 指针移到视频上时，宿主页面收不到任何事件，于是「鼠标移开就收回」会失效、
// 操作条也不会浮出来。所以由主进程直接读系统光标位置，最可靠。
const IDLE_MS = 2400;

let cursorTimer = null;
let cursorPos = { x: -1, y: -1 };
let lastMoveAt = Date.now();
const cursorState = { inside: null, idle: null };

function startCursorWatch() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) {
      if (cursorState.inside !== false) {
        cursorState.inside = false;
        cursorState.idle = false;
        send('sf:cmd', { type: 'cursor', inside: false });
      }
      return;
    }

    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

    if (p.x !== cursorPos.x || p.y !== cursorPos.y) {
      cursorPos = { x: p.x, y: p.y };
      lastMoveAt = Date.now();
    }

    if (inside) {
      // 位置每拍都推 —— 操作条要靠它判断鼠标是不是在窗口底部那一条
      cursorState.inside = true;
      send('sf:cmd', { type: 'cursor', inside: true, x: p.x - b.x, y: p.y - b.y });
    } else if (cursorState.inside !== false) {
      cursorState.inside = false;
      send('sf:cmd', { type: 'cursor', inside: false });
    }

    const idle = inside && Date.now() - lastMoveAt > IDLE_MS;
    if (idle !== cursorState.idle) {
      cursorState.idle = idle;
      send('sf:cmd', { type: 'idle', idle: idle });
    }
  }, 120);
}

// ── 窗口尺寸 / 外观 ─────────────────────────────────────────────────────────
function setPreset(name) {
  if (!PRESETS[name]) name = 'short';
  config.preset = name;
  saveConfig();
  const size = presetSize(name);
  if (!win || win.isDestroyed()) return;

  const b = win.getBounds();
  // 同样用主显示器的工作区，别用 match 出来的那块
  const wa = screen.getPrimaryDisplay().workArea;

  let x = b.x;
  let y = b.y;
  // 放不下就往上/往左挪
  if (x + size.w > wa.x + wa.width) x = Math.max(wa.x, wa.x + wa.width - size.w);
  if (y + size.h > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - size.h);

  const applied = applyBounds({ x: x, y: y, width: size.w, height: size.h }, true);
  config.pos = { x: applied.x, y: applied.y };
  saveConfig();
  send('sf:cmd', { type: 'preset', value: name });
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// 按站点比例调整尺寸 —— 用户自己拖过窗口大小之后走这条。
// 关键是「保持面积不变」：横屏切竖屏时窗口变窄变高，体量感不变，
// 而不是把宽度钉死、把高度撑到屏幕外面去。
function fitRatio(ratio) {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  const r = ratio === 'short' ? 9 / 16 : 16 / 9;
  const contentH = Math.max(1, b.height - CHROME_H);
  const area = b.width * contentH;
  // 用主显示器的工作区做上下界 —— 别用 getDisplayMatching，那个会飘
  const wa = screen.getPrimaryDisplay().workArea;

  let h = Math.round(Math.sqrt(area / r));
  dbg('fitRatio', ratio, 'b=' + JSON.stringify(b), 'wa=' + JSON.stringify(wa), 'rawH=' + h);
  h = Math.min(wa.height - CHROME_H, Math.max(MIN_H - CHROME_H, h));
  const w = Math.max(MIN_W, Math.round(h * r));
  dbg('fitRatio ->', w + 'x' + (h + CHROME_H), 'h=' + h);

  // 窗口本来贴着屏幕下沿的话，改完尺寸还贴着
  let y = b.y;
  if (Math.abs(b.y + b.height - (wa.y + wa.height)) < 60) y = wa.y + wa.height - (h + CHROME_H);

  const applied = applyBounds({ x: b.x, y: y, width: w, height: h + CHROME_H }, true);
  if (!applied) return null;
  config.freeSize = { w: applied.width, h: applied.height - CHROME_H };
  config.pos = { x: applied.x, y: applied.y };
  saveConfig();
  return applied;
}

function setOpacity(v) {
  v = Math.max(0.15, Math.min(1, Number(v) || 1));
  config.opacity = v;
  saveConfig();
  if (win && !win.isDestroyed()) win.setOpacity(v);
}

function setAlwaysOnTop(mode) {
  config.alwaysOnTop = mode;
  saveConfig();
  if (!win || win.isDestroyed()) return;
  if (mode === 'off') {
    win.setAlwaysOnTop(false);
  } else if (mode === 'screen-saver') {
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.setAlwaysOnTop(true, 'floating');
  }
}

function setScreenGuard(on) {
  config.screenGuard = !!on;
  saveConfig();
  if (win && !win.isDestroyed()) win.setContentProtection(!!on);
}

// 鼠标移开后：mask = 变回代码面具 / hide = 整个窗口藏起来。
// 托管在托盘菜单里 —— 因为选了 hide 之后窗口本身已经不见了，
// 托盘是唯一还能点到的地方，所以这个开关必须在那儿也能改。
function setOnLeaveMode(v) {
  config.onLeave = v === 'hide' ? 'hide' : 'mask';
  saveConfig();
  if (tray) tray.setContextMenu(buildTrayMenu());
  send('sf:cmd', { type: 'config', value: config });
}

// ── 全局热键（只留 3 个，全部可选）─────────────────────────────────────────
// 上一版把换站点 / 换尺寸 / 换面具 也注册成全局热键，其中
// Ctrl+Alt+↑/↓ 正是 VS Code 的「向上/下添加光标」，会把编辑器抢走。
// 现在这些操作全部改成窗口内鼠标点击，不再占用任何系统级组合键。
const HOTKEY_TABLE = [
  { acc: 'Alt+X', desc: '紧急收回（万一有人走过来）', cmd: { type: 'panic' } },
  { acc: 'Alt+`', desc: '钉住画面（长期看的时候用）', cmd: { type: 'pin-toggle' } },
  { acc: 'Alt+V', desc: '闪现画面几秒，到点自动收回', cmd: { type: 'peek' } }
];

let hotkeyFailures = [];

function registerHotkeys() {
  hotkeyFailures = [];
  HOTKEY_TABLE.forEach((h) => {
    let ok = false;
    try {
      ok = globalShortcut.register(h.acc, () => handleGlobalCmd(h.cmd));
    } catch (e) {
      ok = false;
    }
    if (!ok || !globalShortcut.isRegistered(h.acc)) hotkeyFailures.push(h.acc);
  });

  if (hotkeyFailures.length) {
    console.warn('[屏风] 以下热键被占用（不影响使用，鼠标一样能操作）：', hotkeyFailures.join(', '));
  }
}

function handleGlobalCmd(cmd) {
  if (!win || win.isDestroyed()) return;

  if (cmd.type === 'hide-to-tray') {
    win.hide();
    send('sf:cmd', { type: 'mask', value: 'on' });
    return;
  }

  // 触发全局快捷键时，如果窗口还没显示就先让它显示（但保持面具）
  if (!win.isVisible()) win.show();

  send('sf:cmd', cmd);
}

// ── 托盘 ────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const sites = allSites();
  const siteItems = sites.map((s) => ({
    label: `${s.real}  ·  ${s.file}${s.id === config.siteId ? '  \u2713' : ''}`,
    click: () => {
      config.siteId = s.id;
      saveConfig();
      if (win && !win.isDestroyed()) {
        win.setSkipTaskbar(true);
        win.show();
      }
      send('sf:cmd', { type: 'site', value: s.id });
    }
  }));

  return Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏面板',
      click: () => {
        if (!win || win.isDestroyed()) return;
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
          win.setSkipTaskbar(true);
          win.setContentProtection(!!config.screenGuard);
        }
      }
    },
    { type: 'separator' },
    { label: '看哪个', enabled: false },
    ...siteItems,
    { type: 'separator' },
    { label: '窗口尺寸', enabled: false },
    ...SHARED.PRESET_ORDER.map((k) => ({
      label: `${PRESETS[k].label}  (${PRESETS[k].w}\u00d7${PRESETS[k].h})`,
      click: () => setPreset(k)
    })),
    { type: 'separator' },
    {
      label: '录屏不可见',
      type: 'checkbox',
      checked: !!config.screenGuard,
      click: (mi) => setScreenGuard(mi.checked)
    },
    {
      label: '失焦自动回面具',
      type: 'checkbox',
      checked: !!config.hideOnBlur,
      click: (mi) => {
        config.hideOnBlur = mi.checked;
        saveConfig();
        send('sf:cmd', { type: 'config', value: config });
      }
    },
    {
      label: '鼠标停靠显示',
      type: 'checkbox',
      checked: !!config.peekOnHover,
      click: (mi) => {
        config.peekOnHover = mi.checked;
        saveConfig();
        send('sf:cmd', { type: 'config', value: config });
      }
    },
    {
      label: '鼠标移开后',
      submenu: [
        {
          label: '变回代码',
          type: 'radio',
          checked: config.onLeave !== 'hide',
          click: () => setOnLeaveMode('mask')
        },
        {
          label: '整个窗口藏掉',
          type: 'radio',
          checked: config.onLeave === 'hide',
          click: () => setOnLeaveMode('hide')
        }
      ]
    },
    {
      label: '钉在其它窗口之上',
      type: 'checkbox',
      checked: config.alwaysOnTop !== 'off',
      click: (mi) => setAlwaysOnTop(mi.checked ? 'floating' : 'off')
    },
    { type: 'separator' },
    { label: '打开配置目录', click: () => shell.showItemInFolder(cfgPath()) },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const img = nativeImage.createFromBuffer(makeIconBuffer(32));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('屏风');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.hide();
    else { win.show(); win.setSkipTaskbar(true); }
  });
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function wireIpc() {
  ipcMain.handle('sf:init', () => ({
    config: config,
    sites: allSites(),
    presets: PRESETS,
    masks: SHARED.MASKS,
    rates: RATES,
    chromeH: CHROME_H,
    mobileUA: MOBILE_UA,
    desktopUA: DESKTOP_UA,
    platform: process.platform,
    hotkeyFailures: hotkeyFailures,
    hotkeys: HOTKEY_TABLE.map((h) => ({ acc: h.acc, desc: h.desc })),
    cfgPath: cfgPath()
  }));

  // 渲染进程每次换来源 / 换面具都会把完整标题推过来
  ipcMain.on('sf:title', (e, t) => {
    if (!win || win.isDestroyed()) return;
    if (typeof t !== 'string' || !t) return;
    win.setTitle(t.slice(0, 240));
  });

  ipcMain.handle('sf:patchConfig', (e, patch) => {
    config = Object.assign({}, config, patch || {});
    saveConfig();
    if (patch && patch.pos && win && !win.isDestroyed()) {
      win.setPosition(patch.pos.x, patch.pos.y, false);
    }
    if (tray) tray.setContextMenu(buildTrayMenu());
    return config;
  });

  ipcMain.handle('sf:setPreset', (e, name) => { setPreset(name); return config.preset; });
  ipcMain.handle('sf:setOpacity', (e, v) => { setOpacity(v); return config.opacity; });
  ipcMain.handle('sf:setAlwaysOnTop', (e, m) => { setAlwaysOnTop(m); return config.alwaysOnTop; });
  ipcMain.handle('sf:setScreenGuard', (e, on) => { setScreenGuard(on); return config.screenGuard; });

  // ── 按来源比例调高度（用户自己拖过尺寸之后走这条）──
  ipcMain.handle('sf:fitRatio', (e, ratio) => fitRatio(ratio));

  ipcMain.handle('sf:setSite', (e, id) => {
    config.siteId = id;
    saveConfig();
    if (win && !win.isDestroyed()) win.setTitle(decoyTitleFor(id, config.mask));
    if (tray) tray.setContextMenu(buildTrayMenu());
    return id;
  });
  ipcMain.handle('sf:addSite', (e, site) => {
    config.custom = config.custom || [];
    const id = 'custom-' + Date.now().toString(36);
    const item = Object.assign(
      {
        id: id,
        real: '自定义',
        file: 'scratch.' + id.slice(-4) + '.ts',
        lang: 'typescript',
        url: '',
        ua: 'mobile',
        ratio: 'wide',
        dot: '#7fd4c1'
      },
      site || {}
    );
    config.custom.push(item);
    saveConfig();
    if (tray) tray.setContextMenu(buildTrayMenu());
    return item;
  });
  ipcMain.handle('sf:removeSite', (e, id) => {
    config.custom = (config.custom || []).filter((s) => s.id !== id);
    if (config.siteId === id) config.siteId = 'douyin';
    saveConfig();
    if (tray) tray.setContextMenu(buildTrayMenu());
    return config.custom;
  });
  ipcMain.handle('sf:hide', () => { if (win && !win.isDestroyed()) win.hide(); });
  ipcMain.handle('sf:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('sf:openExternal', (e, url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });

  // 渲染进程上报可见状态 → 更新托盘
  ipcMain.on('sf:sync', (e, patch) => {
    if (!patch) return;
    if (patch.siteId && patch.siteId !== config.siteId) {
      config.siteId = patch.siteId;
      saveConfig();
      if (tray) tray.setContextMenu(buildTrayMenu());
    }
  });
}

// ── 自检模式：启动后自动切几种状态并截图 ────────────────────────────────────
// 用法：electron . --shot=<输出目录>
async function runSelfShot(dir) {
  const fsx = require('fs');
  try { fsx.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // 硬兜底：中间任何一步卡住（webview 不回来、某个 await 不 resolve），
  // 自检脚本会一直挂着，留下一个看不见的后台 Electron。
  // 踩过一次：createWindow 抛异常 → 自检根本没启动 → 进程活了 7 分钟。
  const hardStop = setTimeout(() => {
    console.error('[shot] watchdog fired, giving up');
    quitting = true;
    app.quit();
  }, 180000);

  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 有图没拍成时，退出码要非零 —— 否则「少了一张图」会被当成跑完了
  let shotFailures = 0;

  // 自检会切来源 / 换面具 / 动尺寸 —— 这些都是**用户配置**里的东西。
  // 不留神的话跑完一轮自检，用户下次启动就变成「上次自检最后停在哪就是哪」。
  // 跑之前先存一份，跑完原样写回去。
  const keeper = ((c) => ({
    siteId: c.siteId,
    preset: c.preset,
    mask: c.mask,
    onLeave: c.onLeave,
    pos: c.pos ? Object.assign({}, c.pos) : null,
    freeSize: c.freeSize ? Object.assign({}, c.freeSize) : null,
    openTabs: (c.openTabs || []).slice(),
    seenSite: Object.assign({}, c.seenSite || {}),
    perSite: Object.assign({}, c.perSite || {}),
    firstRun: c.firstRun
  }))(config);

  // 截图期间关掉屏幕保护，否则抓到的可能是一片黑
  win.setContentProtection(false);
  // 也更掉鼠标探测 —— 否则真实光标一动，状态就跟着变，截图不可复现
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }

  // 注意：ready-to-show 通常晚于 did-finish-load，这里不能无条件 once 等待
  if (wc.isLoading()) {
    await new Promise((r) => wc.once('did-finish-load', r));
  }
  await wait(4500); // 等 webview 把页面拉起来

  // 截图前冻掉会自己变的状态：
  //   hovered     —— 鼠标只要停在窗口上就自己露出来
  //   hideOnBlur  —— 截图期间窗口一失焦，钉住状态就被清掉
  //   dock        —— 操作条只在鼠标活动时出现
  // 光标探测已经在上面停掉了，所以这里不用再改 peekOnHover，
  // 免得设置面板截图里那一项显示成关（实际是开）。
  const FREEZE =
    '__SF.state.cfg.hideOnBlur=false; __SF.hover(false); __SF.dock(false); __SF.quiet(true); ';

  const shots = [
    ['01-mask-code.png', FREEZE + '__SF.closeAll(); __SF.setMask("code")'],
    ['02-mask-diff.png', '__SF.setMask("diff")'],
    ['03-mask-log.png', '__SF.setMask("log")'],
    ['04-mask-test.png', '__SF.setMask("test")', 3000],
    ['05-mask-git.png', '__SF.setMask("git")'],
    ['06-live-douyin.png', '__SF.setMask("code"); __SF.pin(true)', 8000],
    ['07-dock.png', '__SF.pin(true); __SF.hover(true); __SF.dock(true)'],
    ['08-menu-source.png', '__SF.dock(true); __SF.menu("source")'],
    ['09-menu-mask.png', '__SF.menu("mask")', 600],
    ['10-menu-rate.png', '__SF.menu("rate")', 600],
    ['11-settings.png', '__SF.pin(false); __SF.closeAll(); __SF.dock(false); __SF.settings()'],
    ['12-tab-bilibili.png', '__SF.closeAll(); __SF.site("bilibili"); __SF.setMask("code")', 1200],
    // 13/14 故意换成最小的「细条」尺寸 —— 这两张跟前面 12 张的尺寸**不一样**，
    // 是在验两件事：① 窗口能真的缩到 168 宽（bounds 里核对）；② 窄到 168 时
    // 外壳不塌、操作条上的按钮没被裁掉（这是「看得见、点得到」的底线）。
    // 站点换回 douyin（竖屏），跟细条的比例一致，画面才不会被裁得只剩中间一条。
    ['13-nano-code.png',
      '__SF.pin(false); __SF.hover(false); __SF.closeAll(); ' +
      '__SF.site("douyin"); __SF.setMask("code"); __SF.preset("nano")', 1500],
    ['14-nano-menu-onleave.png', '__SF.dock(true); __SF.menu("onleave")', 700]
  ];

  for (const [name, js, extra] of shots) {
    dbg('[shot] begin', name);
    if (js) {
      try {
        // 包一层 try/catch 并把错误回传 —— executeJavaScript 失败时只会给
        // 一句「Script failed to execute」，看不出到底是哪儿抛的，白排查。
        const r = await wc.executeJavaScript(
          '(function(){try{' + js + ';return "ok";}catch(e){return "ERR " + (e && (e.stack || e.message) || e);}})()'
        );
        if (r !== 'ok') console.error('[shot js err]', name, r);
      } catch (e) {
        console.error('[shot js fail]', name, e.message);
      }
    }
    await wait(1400 + (extra || 0));

    // 打一份渲染进程状态，方便定位问题
    try {
      const st = await wc.executeJavaScript(
        'JSON.stringify({revealed:__SF.state.revealed,loading:__SF.state.loading,' +
          'pinned:__SF.state.pinned,hovered:__SF.state.hovered,overlay:__SF.state.overlay,' +
          'mask:__SF.state.mask,site:__SF.state.cfg.siteId,file:(__SF.state.site||{}).file,' +
          'rate:__SF.state.cfg.rate,clean:__SF.state.cfg.clean,' +
          'dock:document.getElementById("dock").className,' +
          'menu:document.getElementById("ctxmenu").className,' +
          'live:document.getElementById("liveLayer").className,' +
          'title:document.title})'
      );
      console.log('[state]', name, st);
      console.log('[title]', name, JSON.stringify(win.getTitle()));
      if (name.indexOf('live-') >= 0 || name.indexOf('12-') === 0 || name.indexOf('13-') === 0) {
        // 只取窗口侧尺寸（不打 JS 进 guest，那有可能等好几秒）
        try {
          console.log('[probe]', name, await wc.executeJavaScript('__SF.probe()'));
          console.log('[bounds]', name, JSON.stringify(win.getBounds()));
        } catch (e) {
          console.error('[probe fail]', name, e.message);
        }
      }
    } catch (e) {
      console.error('[state fail]', name, e.message);
    }

    try {
      // capturePage 偶尔会**一直不返回** —— 实测在「把窗口缩到极小、而且
      // <webview> 里的画面比例跟容器对不上」时，合成器像是进了一个出不了帧的
      // 状态，一张图把整轮自检拖到 180s watchdog 才罢休。
      // 给它一个上限、超时重试一次，再不行就记一笔跳过 —— 别让一张图拖垮整轮。
      let img = null;
      for (let attempt = 0; attempt < 2 && !img; attempt++) {
        img = await Promise.race([
          wc.capturePage(),
          wait(12000).then(() => null)
        ]);
        if (!img) console.error('[capture timeout]', name, 'attempt=' + (attempt + 1));
      }
      if (!img) {
        shotFailures++;
        console.error('[shot fail]', name, 'capture timed out');
        continue;
      }
      const buf = img.toPNG();
      if (!buf || buf.length < 1000) {
        shotFailures++;
        console.error('[shot fail]', name, 'empty png len=' + (buf ? buf.length : 0));
        continue;
      }
      fsx.writeFileSync(require('path').join(dir, name), buf);
      console.log('[shot]', name);
    } catch (e) {
      shotFailures++;
      console.error('[shot fail]', name, e.message);
    }

    // 「双击画面 = 钉住」这条链路要端到端验一次：
    // 截图拍不到鼠标事件，只能在 guest 里派发一个 dblclick，看宿主的 pinned 翻不翻。
    // 放在截图**之后**做 —— 否则状态被改掉，画面那一张就拍成面具了。
    if (name.indexOf('12-') === 0) {
      try {
        const before = await wc.executeJavaScript('String(__SF.state.pinned)');
        await wc.executeJavaScript(
          '(function(){var w=__SF.state.webview;if(!w)return "no-webview";' +
          'return w.executeJavaScript("document.body.dispatchEvent(new MouseEvent(\'dblclick\',{bubbles:true}))");})()'
        );
        await wait(700);
        const after = await wc.executeJavaScript('String(__SF.state.pinned)');
        console.log('[e2e dblclick]', name, 'pinned', before, '->', after,
          before === after ? '!! 没生效' : 'ok');
        await wc.executeJavaScript('__SF.pin(true)');
      } catch (e) {
        console.error('[e2e dblclick fail]', name, e.message);
      }
    }
  }

  console.log('[shot] done ->', dir, 'failures=' + shotFailures);

  // 把用户配置恢复原样（见 keeper 的说明）
  Object.assign(config, keeper);
  saveConfig();
  await wait(300); // 等 debounce 写完再退，否则可能被 250ms 的定时器吃掉

  clearTimeout(hardStop);
  quitting = true;
  app.exit(shotFailures ? 2 : 0);
}

// webview 里的新窗口一律不开，交给系统浏览器（避免弹出一堆小窗暴露）
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (ev, url) => {
    if (!/^https?:/i.test(url)) ev.preventDefault();
  });
  // 视频区上的右键也走我们自己的菜单：把坐标转给渲染进程
  contents.on('context-menu', (ev, params) => {
    send('sf:cmd', { type: 'ctxmenu', x: params.x, y: params.y });
  });
});

// ── 异常 / 退出诊断（只在 --sf-debug 下打印）────────────────────────────────
// 「自检跑到一半进程就没了」这类问题，没有这些监听就只能靠猜。
app.on('render-process-gone', (e, wc, details) => {
  dbg('render-process-gone', JSON.stringify(details));
});
app.on('child-process-gone', (e, details) => {
  dbg('child-process-gone', JSON.stringify(details));
});
process.on('uncaughtException', (err) => {
  dbg('uncaughtException', err && err.stack);
});

// ── 生命周期 ────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    saveConfig(); // 把自愈 / 迁移后的值写回去
    dbg('config loaded: preset=' + config.preset, 'freeSize=' + JSON.stringify(config.freeSize), 'hideOnLeave=' + config.hideOnLeave);

    // 所有 webview 共享一套「看起来像 Safari/Chrome」的身份
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(['media', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
    });

    createWindow();
    createTray();
    registerHotkeys();
    wireIpc();
    startCursorWatch();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    // 打出调用栈 —— 排查「进程莫名退出」时，这是唯一能说明「谁按的退出」的东西
    dbg('before-quit', (new Error().stack || '').split('\n').slice(1, 6).join(' | '));
    quitting = true;
  });

  app.on('will-quit', () => {
    if (cursorTimer) clearInterval(cursorTimer);
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', (e) => {
    // 常驻托盘，不随窗口关闭退出
    e.preventDefault && e.preventDefault();
  });
}

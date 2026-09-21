/**
 * 屏风 ScreenFold — 共享定义
 *
 * 这个文件同时被主进程（require）和渲染进程（<script>）使用，
 * 所以写成 UMD 风格。
 *
 * 设计原则：所有暴露在屏幕上的字符串都必须是「看起来像开发工作」的。
 * 真实站点名只存在 real 字段里，绝不出现在常态 UI 上。
 *
 * v3 新增的一条硬约束（这条比什么都重要）：
 *   **标签上的文件名、面具里的源码内容、窗口标题，三者必须是同一个文件。**
 *   上一版切到 bilibili 之后标签写着 media.player.tsx、代码里却是 route.ts 的
 *   Next.js 路由处理函数 —— 从背后扫一眼就是破绽。现在每个站点绑定一份专属源码，
 *   由 `file` 字段作为键去内容库里取。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCREENFOLD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── UA ────────────────────────────────────────────────────────────────────
  var MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  var DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  // ── 站点 ──────────────────────────────────────────────────────────────────
  // id     内部标识
  // file   标签栏上显示的「文件名」—— 伪装的核心，也是内容库里取源码的键
  // lang   状态栏右下角显示的语言，必须和 file 的后缀对得上
  // real   真实站点名，只在设置面板 / 托盘里以小字出现
  // ratio  'short' 竖屏 9:16 | 'wide' 横屏 16:9
  // hint   第一次进入这个来源时给的一句提示（只提操作，不提快捷键）
  var SITES = [
    {
      id: 'douyin',
      real: '抖音',
      file: 'feed.aggregator.ts',
      lang: 'typescript',
      // 抖音没有可用的移动端网页版（m.douyin.com 返回 404），只能走桌面入口。
      // 桌面入口第一次打开是扫码登录页 —— 扫一次就记住了（分区是持久化的），
      // 之后直接进推荐流。所以这里必须给一句提示，否则用户以为坏了。
      url: 'https://www.douyin.com/?recommend=1',
      ua: 'desktop',
      ratio: 'wide',
      dot: '#4ec9b0',
      hint: '抖音首次要扫码登录一次，之后会记住'
    },
    {
      id: 'bilibili',
      real: '哔哩哔哩',
      file: 'media.player.tsx',
      lang: 'typescriptreact',
      url: 'https://m.bilibili.com/',
      ua: 'mobile',
      ratio: 'wide',
      dot: '#8ab4ff'
    },
    {
      id: 'huya',
      real: '虎牙',
      file: 'live.room.ts',
      lang: 'typescript',
      url: 'https://m.huya.com/',
      ua: 'mobile',
      ratio: 'wide',
      dot: '#ffb454'
    },
    {
      id: 'kuaishou',
      real: '快手',
      file: 'stream.pipeline.ts',
      lang: 'typescript',
      url: 'https://m.kuaishou.com/',
      ua: 'mobile',
      ratio: 'short',
      dot: '#e5b567'
    },
    {
      id: 'douyu',
      real: '斗鱼',
      file: 'realtime.socket.ts',
      lang: 'typescript',
      url: 'https://m.douyu.com/',
      ua: 'mobile',
      ratio: 'wide',
      dot: '#f97583'
    },
    {
      id: 'xhs',
      real: '小红书',
      file: 'notes.index.tsx',
      lang: 'typescriptreact',
      url: 'https://www.xiaohongshu.com/explore',
      ua: 'desktop',
      ratio: 'short',
      dot: '#ff7a9c'
    },
    {
      id: 'weibo',
      real: '微博',
      file: 'timeline.cache.ts',
      lang: 'typescript',
      url: 'https://m.weibo.cn/',
      ua: 'mobile',
      ratio: 'wide',
      dot: '#ffb454'
    },
    {
      id: 'youtube',
      real: 'YouTube',
      file: 'cdn.proxy.ts',
      lang: 'typescript',
      url: 'https://m.youtube.com/',
      ua: 'mobile',
      ratio: 'wide',
      dot: '#f97583'
    },
    {
      id: 'zhihu',
      real: '知乎',
      file: 'qa.thread.tsx',
      lang: 'typescriptreact',
      url: 'https://www.zhihu.com/',
      ua: 'desktop',
      ratio: 'wide',
      dot: '#8ab4ff'
    }
  ];

  // ── 窗口尺寸预设 ──────────────────────────────────────────────────────────
  // 只定义「内容区」尺寸，主进程会加上标签栏 + 状态栏的高度。
  // 内容区比例和视频比例严格一致 —— 这样画面永远铺满、没有黑边，
  // 小窗口里画面也刚好。
  var PRESETS = {
    nano:  { w: 168, h: 299, label: '细条',   ratio: 'short' },
    micro: { w: 240, h: 427, label: '窄长',   ratio: 'short' },
    mini:  { w: 264, h: 149, label: '迷你',   ratio: 'wide' },
    short: { w: 296, h: 526, label: '竖屏小', ratio: 'short' },
    tall:  { w: 340, h: 604, label: '竖屏大', ratio: 'short' },
    wide:  { w: 528, h: 297, label: '横屏',   ratio: 'wide' }
  };

  // 菜单里的排列顺序：按宽度从小到大，一眼就能看出「还能更小 / 还能更大」
  var PRESET_ORDER = ['nano', 'micro', 'mini', 'short', 'tall', 'wide'];

  var CHROME_H = 52; // 标签栏 30 + 状态栏 22

  // ── 面具 ──────────────────────────────────────────────────────────────────
  // label 是「听起来像这么回事」的名字，不是文件名 —— 面具是「视图」，
  // 文件是「来源」，两者不能混。
  var MASKS = [
    { id: 'code', label: 'route.ts',  desc: '源码编辑' },
    { id: 'diff', label: 'Changes',   desc: '代码评审' },
    { id: 'log',  label: 'Terminal',  desc: '构建日志' },
    { id: 'test', label: 'vitest',    desc: '跑单测' },
    { id: 'git',  label: 'git log',   desc: '提交历史' }
  ];

  // ── 倍速 ──────────────────────────────────────────────────────────────────
  var RATES = [1, 1.25, 1.5, 2];

  // ── 默认配置 ──────────────────────────────────────────────────────────────
  var DEFAULT_CONFIG = {
    // 窗口
    preset: 'short',
    opacity: 1,
    alwaysOnTop: 'floating', // floating | screen-saver | off
    pos: null,

    // 伪装
    mask: 'code',
    lockMask: false,        // true = 死死扣住面具，任何操作都不露
    maskFollowsFile: true,  // 面具的源码跟着标签的文件走（这是 v3 的重点）
    project: 'inkstack',
    branch: 'main',

    // 兜底（核心防暴露机制）
    hideOnBlur: true,       // 窗口失焦立刻回面具
    hideOnLeave: 400,       // 鼠标离开窗口 N ms 后回面具（0 = 立刻）
    onLeave: 'mask',        // 鼠标移开后：mask = 变回代码面具 / hide = 整个窗口藏起来
    peekOnHover: true,      // 鼠标移进来就显示画面 —— 零操作的主路径
    peekMs: 5000,           // Alt+V 闪现时长

    // 防护
    screenGuard: true,      // 录屏/截图/共享屏幕时窗口不可见
    muteOnHide: true,       // 收起画面时同时静音
    dimLive: 0.15,          // 画面压暗（0~0.5），避免亮白页面在深色外壳里跳出来

    // 内容
    siteId: 'douyin',
    openTabs: ['douyin', 'bilibili', 'huya'],
    autoFit: true,          // 切站点时自动匹配窗口比例
    volume: 70,
    rate: 1,                // 倍速
    clean: true,            // 注入 CSS 清掉浮层/广告/登录弹窗
    doubleClickPin: true,   // 双击画面 = 钉住 / 松开
    custom: [],
    freeSize: null,         // 用户自己拖出来的内容区尺寸（preset='free' 时生效）
    perSite: {},            // 每个来源自己的音量 / 倍速 / 净化开关
    seenSite: {},           // 每个来源的首次提示只弹一次
    showRealNames: true,    // 菜单里带真实站点名 —— 好认。想更隐蔽可以关掉
    hideCursor: true        // 画面露出时，鼠标静止 2 秒自动隐藏指针
  };

  // 坏值自愈的判据（主进程 sanitizeConfig 用，渲染进程钳制也用）
  // 下限是「还能当个细长面板看」的位置：150 宽 ≈ 一行 24 个字符的代码，
  // 正好能装成编辑器左边那条侧栏 / 大纲面板。再窄就不像话了。
  var LIMITS = {
    minW: 150,
    minH: 132,
    minContentW: 150,
    minContentH: 84,
    opacityMin: 0.15,
    dimMax: 0.5,
    leaveMax: 5000
  };

  return {
    MOBILE_UA: MOBILE_UA,
    DESKTOP_UA: DESKTOP_UA,
    SITES: SITES,
    PRESETS: PRESETS,
    PRESET_ORDER: PRESET_ORDER,
    MASKS: MASKS,
    RATES: RATES,
    CHROME_H: CHROME_H,
    LIMITS: LIMITS,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };
});

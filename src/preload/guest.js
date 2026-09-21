'use strict';
/**
 * 跑在「视频页面」里的 preload —— 注意这个不是外壳页面的 preload。
 *
 * 存在的唯一理由：画面露出时，视频页面会把整个内容区盖住，鼠标事件全被它吃掉，
 * 外壳的 canvas 上永远收不到 dblclick。于是「双击画面 = 钉住」这个看起来很顺手的
 * 操作实际上永远不触发 —— 功能是真的，只是事件到不了。
 *
 * 所以从页面这一侧把双击捞出来，送回宿主。contextIsolation 保持开启，
 * 页面自己看不到这段代码，也不会污染它的全局。
 */
const { ipcRenderer } = require('electron');

let lastAt = 0;

window.addEventListener(
  'dblclick',
  function () {
    // 浏览器自己也会派发 dblclick，这里只是防那种「一秒内连点三下」的情况
    const now = Date.now();
    if (now - lastAt < 120) return;
    lastAt = now;
    try {
      ipcRenderer.sendToHost('sf-guest', { type: 'dblclick' });
    } catch (e) {
      /* 宿主没在听就算了，不能让页面报错 */
    }
  },
  true
);

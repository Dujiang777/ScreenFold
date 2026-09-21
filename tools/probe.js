/**
 * 探测各站点的移动端 / 桌面端入口是否可用。
 * 用法：node tools/probe.js
 */
'use strict';

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CANDIDATES = [
  ['douyin', 'mobile', 'https://m.douyin.com/'],
  ['douyin', 'desktop', 'https://www.douyin.com/'],
  ['douyin', 'mobile', 'https://www.douyin.com/?is_from_mobile_home=1'],
  ['bilibili', 'mobile', 'https://m.bilibili.com/'],
  ['bilibili', 'desktop', 'https://www.bilibili.com/'],
  ['huya', 'mobile', 'https://m.huya.com/'],
  ['huya', 'desktop', 'https://www.huya.com/'],
  ['kuaishou', 'mobile', 'https://m.kuaishou.com/'],
  ['kuaishou', 'desktop', 'https://www.kuaishou.com/'],
  ['douyu', 'mobile', 'https://m.douyu.com/'],
  ['douyu', 'desktop', 'https://www.douyu.com/'],
  ['xhs', 'desktop', 'https://www.xiaohongshu.com/explore'],
  ['weibo', 'mobile', 'https://m.weibo.cn/'],
  ['youtube', 'mobile', 'https://m.youtube.com/'],
  ['zhihu', 'desktop', 'https://www.zhihu.com/']
];

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 48) : '';
}

async function probe(url, ua) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: ctrl.signal
    });
    const html = await res.text();
    return {
      status: res.status,
      final: res.url,
      title: titleOf(html),
      len: html.length
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  for (const [id, mode, url] of CANDIDATES) {
    const r = await probe(url, mode === 'mobile' ? UA_MOBILE : UA_DESKTOP);
    const line = r.error
      ? `ERR ${r.error}`
      : `${r.status}  len=${r.len}  "${r.title}"` + (r.final !== url ? `  -> ${r.final}` : '');
    console.log(`${id.padEnd(9)} ${mode.padEnd(8)} ${url}`);
    console.log(`          ${line}`);
  }
})();

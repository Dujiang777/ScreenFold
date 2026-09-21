/**
 * 面具（Masquerade）—— 屏风盖在画面上的那层「正常工作」。
 *
 * ── v3 的核心约束 ─────────────────────────────────────────────────────────
 * 上一版所有面具都硬编码同一份 route.ts 源码。切到「哔哩哔哩」之后，标签上写着
 * media.player.tsx，代码里却是 Next.js 的路由处理函数 —— 从背后扫一眼就穿帮了。
 *
 * 现在改成 **内容库**：每个站点的 `file` 是键，取到一份专属源码。
 * 标签、面具、窗口标题三者永远指向同一个文件。
 *
 * 五套面具，每一套都是会动的（静止的假界面反而可疑）：
 *   1. code  —— 当前文件的语法高亮，光标闪、缓慢滚动、偶尔打字
 *   2. diff  —— 由当前文件现场生成的 unified diff（行号和内容都对得上）
 *   3. log   —— 开发服务器日志，逐行追加
 *   4. test  —— vitest 跑单测，逐条点亮
 *   5. git   —— git log --graph 的提交历史
 */
(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  //  一、内容库：文件 → 源码
  //  每份都按它自己的文件名写，语言 / 命名风格 / 注释口径都对得上。
  // ══════════════════════════════════════════════════════════════════════════
  var SOURCES = {};

  SOURCES['feed.aggregator.ts'] = [
    '/**',
    ' * 首页信息流 —— 光标分页，避免深翻页时的 OFFSET 抖动。',
    ' *',
    ' * 排序策略收在 rankFeed 里，这里只负责鉴权与取数。',
    ' */',
    '',
    'import { NextRequest, NextResponse } from "next/server";',
    'import { db } from "@/lib/db";',
    'import { verifySession } from "@/lib/auth";',
    'import { rateLimit } from "@/lib/ratelimit";',
    'import { rankFeed } from "@/lib/ranker";',
    'import { metrics } from "@/lib/metrics";',
    'import type { FeedItem, FeedWhere } from "@/types/feed";',
    '',
    'export const runtime = "nodejs";',
    'export const dynamic = "force-dynamic";',
    '',
    'const PAGE_SIZE = 20;',
    'const MAX_TAG_LEN = 32;',
    'const CACHE_TTL = 15;',
    '',
    'export async function GET(req: NextRequest) {',
    '  const startedAt = Date.now();',
    '  const session = await verifySession(req);',
    '  if (!session) {',
    '    return NextResponse.json({ error: "unauthorized" }, { status: 401 });',
    '  }',
    '',
    '  const gate = await rateLimit(session.userId, "feed:read");',
    '  if (!gate.ok) {',
    '    return NextResponse.json(',
    '      { error: "too_many_requests" },',
    '      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }',
    '    );',
    '  }',
    '',
    '  const params = new URL(req.url).searchParams;',
    '  const cursor = params.get("cursor");',
    '  const tag = params.get("tag");',
    '  const limit = clamp(Number(params.get("limit")) || PAGE_SIZE, 5, 50);',
    '',
    '  const where: FeedWhere = { published: true };',
    '  if (cursor) where.createdAt = { lt: new Date(cursor) };',
    '  if (tag && tag.length <= MAX_TAG_LEN) where.tags = { has: tag };',
    '',
    '  const rows = await db.post.findMany({',
    '    where,',
    '    take: limit + 1,',
    '    orderBy: [{ createdAt: "desc" }, { id: "desc" }],',
    '    select: {',
    '      id: true,',
    '      title: true,',
    '      slug: true,',
    '      excerpt: true,',
    '      createdAt: true,',
    '      readMinutes: true,',
    '      stats: { select: { likes: true, comments: true } },',
    '      author: { select: { id: true, name: true, avatar: true } }',
    '    }',
    '  });',
    '',
    '  const hasMore = rows.length > limit;',
    '  const page = hasMore ? rows.slice(0, -1) : rows;',
    '  const items: FeedItem[] = rankFeed(page, session.userId);',
    '',
    '  metrics.observe("feed.latency", Date.now() - startedAt);',
    '',
    '  return NextResponse.json(',
    '    {',
    '      items,',
    '      nextCursor: hasMore',
    '        ? items[items.length - 1].createdAt.toISOString()',
    '        : null',
    '    },',
    '    {',
    '      headers: {',
    '        "Cache-Control": "private, max-age=" + CACHE_TTL,',
    '        "Content-Type": "application/json"',
    '      }',
    '    }',
    '  );',
    '}',
    '',
    'function clamp(n: number, lo: number, hi: number) {',
    '  return Math.min(Math.max(n, lo), hi);',
    '}'
  ];

  SOURCES['media.player.tsx'] = [
    '"use client";',
    '',
    '/**',
    ' * 播放器外壳。真正的解码交给 <video>，这里只管状态机和键盘。',
    ' */',
    '',
    'import { useCallback, useEffect, useRef, useState } from "react";',
    'import { usePlaybackRate } from "@/hooks/usePlaybackRate";',
    'import { useProgress } from "@/hooks/useProgress";',
    'import { formatDuration } from "@/lib/format";',
    'import type { MediaSource } from "@/types/media";',
    '',
    'const SEEK_STEP = 5;',
    'const BUFFER_TIMEOUT = 8000;',
    '',
    'type Props = {',
    '  source: MediaSource;',
    '  poster?: string;',
    '  onEnded?: () => void;',
    '};',
    '',
    'export function MediaPlayer({ source, poster, onEnded }: Props) {',
    '  const videoRef = useRef<HTMLVideoElement | null>(null);',
    '  const [ready, setReady] = useState(false);',
    '  const [stalled, setStalled] = useState(false);',
    '  const { rate, setRate } = usePlaybackRate(1);',
    '  const { current, duration, seek } = useProgress(videoRef);',
    '',
    '  useEffect(() => {',
    '    const el = videoRef.current;',
    '    if (!el) return;',
    '    el.playbackRate = rate;',
    '  }, [rate, ready]);',
    '',
    '  useEffect(() => {',
    '    if (!stalled) return;',
    '    const timer = setTimeout(() => setStalled(false), BUFFER_TIMEOUT);',
    '    return () => clearTimeout(timer);',
    '  }, [stalled]);',
    '',
    '  const handleKey = useCallback(',
    '    (e: KeyboardEvent) => {',
    '      if (e.key === "ArrowRight") seek(current + SEEK_STEP);',
    '      if (e.key === "ArrowLeft") seek(current - SEEK_STEP);',
    '    },',
    '    [current, seek]',
    '  );',
    '',
    '  return (',
    '    <div className="player" data-ready={ready}>',
    '      <video',
    '        ref={videoRef}',
    '        src={source.url}',
    '        poster={poster}',
    '        playsInline',
    '        onCanPlay={() => setReady(true)}',
    '        onWaiting={() => setStalled(true)}',
    '        onEnded={onEnded}',
    '      />',
    '      <div className="player-bar">',
    '        <span>{formatDuration(current)}</span>',
    '        <input',
    '          type="range"',
    '          min={0}',
    '          max={duration || 0}',
    '          value={current}',
    '          onChange={(e) => seek(Number(e.target.value))}',
    '        />',
    '        <span>{formatDuration(duration)}</span>',
    '        <button onClick={() => setRate(rate === 1 ? 1.5 : 1)}>',
    '          {rate}x',
    '        </button>',
    '      </div>',
    '    </div>',
    '  );',
    '}'
  ];

  SOURCES['live.room.ts'] = [
    '/**',
    ' * 直播间状态。上下行两路分开管：',
    ' *   上行  —— 心跳 + 弹幕，丢了就补，不能攒',
    ' *   下行  —— 礼物 / 进场 / 榜单，可以攒一批再合并渲染',
    ' */',
    '',
    'import { EventEmitter } from "node:events";',
    'import { createHmac } from "node:crypto";',
    'import { logger } from "@/lib/logger";',
    'import type { RoomMeta, Danmaku, GiftBatch } from "@/types/live";',
    '',
    'const HEARTBEAT_MS = 20000;',
    'const DANMAKU_BUFFER = 200;',
    'const GIFT_FLUSH_MS = 120;',
    '',
    'export class LiveRoom extends EventEmitter {',
    '  meta: RoomMeta;',
    '  private beat: NodeJS.Timeout | null = null;',
    '  private pending: Danmaku[] = [];',
    '  private gifts = new Map<string, GiftBatch>();',
    '',
    '  constructor(meta: RoomMeta) {',
    '    super();',
    '    this.meta = meta;',
    '  }',
    '',
    '  async connect(token: string) {',
    '    const sign = createHmac("sha256", this.meta.secret)',
    '      .update(this.meta.roomId + token)',
    '      .digest("hex");',
    '',
    '    logger.info("live.connect", { room: this.meta.roomId });',
    '    this.beat = setInterval(() => this.ping(sign), HEARTBEAT_MS);',
    '    this.startFlush();',
    '  }',
    '',
    '  private ping(sign: string) {',
    '    if (!this.meta.online) return;',
    '    this.emit("ping", { room: this.meta.roomId, sign });',
    '  }',
    '',
    '  push(d: Danmaku) {',
    '    this.pending.push(d);',
    '    if (this.pending.length > DANMAKU_BUFFER) {',
    '      this.pending.splice(0, this.pending.length - DANMAKU_BUFFER);',
    '    }',
    '  }',
    '',
    '  private startFlush() {',
    '    setInterval(() => {',
    '      if (!this.pending.length && !this.gifts.size) return;',
    '      this.emit("flush", {',
    '        danmaku: this.pending.splice(0),',
    '        gifts: Array.from(this.gifts.values())',
    '      });',
    '      this.gifts.clear();',
    '    }, GIFT_FLUSH_MS);',
    '  }',
    '',
    '  close() {',
    '    if (this.beat) clearInterval(this.beat);',
    '    this.removeAllListeners();',
    '  }',
    '}',
    '',
    'export function roomKey(meta: RoomMeta) {',
    '  return meta.platform + ":" + meta.roomId;',
    '}'
  ];

  SOURCES['stream.pipeline.ts'] = [
    '/**',
    ' * 流式管道。关键约束只有一个：**背压必须往上冒**。',
    ' * 下游写入慢的时候，如果这里还闷头 push，内存会一路涨到 OOM。',
    ' */',
    '',
    'import { Transform, type TransformCallback } from "node:stream";',
    'import { pipeline } from "node:stream/promises";',
    'import { zstdDecompress } from "node:zlib";',
    'import { decodeFrame } from "@/lib/frame";',
    'import { Tracer } from "@/lib/trace";',
    '',
    'const HIGH_WATER = 64 * 1024;',
    'const MAX_FRAME = 4 * 1024 * 1024;',
    '',
    'export type Fragment = {',
    '  seq: number;',
    '  keyframe: boolean;',
    '  payload: Buffer;',
    '};',
    '',
    'class FrameSplitter extends Transform {',
    '  private carry = Buffer.alloc(0);',
    '',
    '  _transform(chunk: Buffer, _enc: string, done: TransformCallback) {',
    '    this.carry = Buffer.concat([this.carry, chunk]);',
    '    if (this.carry.length > MAX_FRAME) {',
    '      return done(new Error("frame too large"));',
    '    }',
    '',
    '    let offset = 0;',
    '    for (;;) {',
    '      const frame = decodeFrame(this.carry, offset);',
    '      if (!frame) break;',
    '      offset += frame.size;',
    '      this.push(frame.buf);',
    '    }',
    '',
    '    this.carry = this.carry.subarray(offset);',
    '    done();',
    '  }',
    '}',
    '',
    'export async function runStream(',
    '  input: NodeJS.ReadableStream,',
    '  sink: NodeJS.WritableStream,',
    '  tracer: Tracer',
    ') {',
    '  const splitter = new FrameSplitter({',
    '    readableHighWaterMark: HIGH_WATER,',
    '    writableHighWaterMark: HIGH_WATER',
    '  });',
    '',
    '  tracer.start("ingest");',
    '  await pipeline(input, zstdDecompress(), splitter, sink);',
    '  tracer.end("ingest");',
    '}'
  ];

  SOURCES['realtime.socket.ts'] = [
    '/**',
    ' * 实时通道。断线重连必须带抖动，否则服务端重启时所有客户端会同时回来，',
    ' * 把刚起来的进程再打挂一次。',
    ' */',
    '',
    'import { logger } from "@/lib/logger";',
    'import type { Envelope } from "@/types/protocol";',
    '',
    'const BASE_DELAY = 500;',
    'const MAX_DELAY = 30_000;',
    'const JITTER = 0.35;',
    'const MAX_QUEUE = 500;',
    '',
    'type Handler = (msg: Envelope) => void;',
    '',
    'export class RealtimeSocket {',
    '  private url: string;',
    '  private ws: WebSocket | null = null;',
    '  private attempt = 0;',
    '  private queue: Envelope[] = [];',
    '  private closedByUser = false;',
    '  private handlers = new Set<Handler>();',
    '',
    '  constructor(url: string) {',
    '    this.url = url;',
    '  }',
    '',
    '  on(fn: Handler) {',
    '    this.handlers.add(fn);',
    '    return () => this.handlers.delete(fn);',
    '  }',
    '',
    '  connect() {',
    '    this.closedByUser = false;',
    '    this.ws = new WebSocket(this.url);',
    '',
    '    this.ws.onopen = () => {',
    '      this.attempt = 0;',
    '      logger.info("ws.open", { url: this.url });',
    '      for (const item of this.queue.splice(0)) this.send(item);',
    '    };',
    '',
    '    this.ws.onmessage = (ev) => {',
    '      const msg = JSON.parse(String(ev.data)) as Envelope;',
    '      if (msg.expiresAt && Date.now() > msg.expiresAt) return;',
    '      for (const fn of this.handlers) fn(msg);',
    '    };',
    '',
    '    this.ws.onclose = () => {',
    '      if (this.closedByUser) return;',
    '      const delay = this.backoff();',
    '      logger.warn("ws.retry", { attempt: this.attempt, delay });',
    '      setTimeout(() => this.connect(), delay);',
    '    };',
    '  }',
    '',
    '  private backoff() {',
    '    const raw = Math.min(MAX_DELAY, BASE_DELAY * 2 ** this.attempt++);',
    '    const spread = raw * JITTER;',
    '    return Math.round(raw - spread + Math.random() * spread * 2);',
    '  }',
    '',
    '  send(msg: Envelope) {',
    '    if (this.ws?.readyState !== WebSocket.OPEN) {',
    '      if (this.queue.length >= MAX_QUEUE) this.queue.shift();',
    '      this.queue.push(msg);',
    '      return;',
    '    }',
    '    this.ws.send(JSON.stringify(msg));',
    '  }',
    '',
    '  close() {',
    '    this.closedByUser = true;',
    '    this.ws?.close();',
    '  }',
    '}'
  ];

  SOURCES['notes.index.tsx'] = [
    '"use client";',
    '',
    'import { useEffect, useMemo, useState } from "react";',
    'import { useInfiniteQuery } from "@/hooks/useInfiniteQuery";',
    'import { NoteCard } from "@/components/note-card";',
    'import { EmptyState } from "@/components/empty-state";',
    'import { useDebounced } from "@/hooks/useDebounced";',
    'import type { Note } from "@/types/note";',
    '',
    'const PAGE = 24;',
    'const SEARCH_DEBOUNCE = 300;',
    '',
    'export default function NotesIndex() {',
    '  const [keyword, setKeyword] = useState("");',
    '  const [tag, setTag] = useState<string | null>(null);',
    '  const debounced = useDebounced(keyword, SEARCH_DEBOUNCE);',
    '',
    '  const query = useMemo(',
    '    () => ({ q: debounced, tag, limit: PAGE }),',
    '    [debounced, tag]',
    '  );',
    '',
    '  const {',
    '    items,',
    '    loading,',
    '    error,',
    '    hasMore,',
    '    loadMore',
    '  } = useInfiniteQuery<Note>("/api/notes", query);',
    '',
    '  useEffect(() => {',
    '    if (!hasMore) return;',
    '    const io = new IntersectionObserver((entries) => {',
    '      if (entries[0].isIntersecting && !loading) loadMore();',
    '    });',
    '    const el = document.getElementById("sentinel");',
    '    if (el) io.observe(el);',
    '    return () => io.disconnect();',
    '  }, [hasMore, loading, loadMore]);',
    '',
    '  const tags = useMemo(',
    '    () => Array.from(new Set(items.flatMap((n) => n.tags))).sort(),',
    '    [items]',
    '  );',
    '',
    '  if (error) {',
    '    return <EmptyState title="加载失败" hint={error.message} />;',
    '  }',
    '',
    '  return (',
    '    <section className="notes">',
    '      <header className="notes-head">',
    '        <input',
    '          value={keyword}',
    '          onChange={(e) => setKeyword(e.target.value)}',
    '          placeholder="搜索笔记"',
    '        />',
    '        <div className="notes-tags">',
    '          {tags.map((t) => (',
    '            <button',
    '              key={t}',
    '              className={t === tag ? "on" : ""}',
    '              onClick={() => setTag(t === tag ? null : t)}',
    '            >',
    '              {t}',
    '            </button>',
    '          ))}',
    '        </div>',
    '      </header>',
    '',
    '      <div className="notes-grid">',
    '        {items.map((n) => (',
    '          <NoteCard key={n.id} note={n} />',
    '        ))}',
    '      </div>',
    '',
    '      {hasMore && <div id="sentinel" className="notes-more" />}',
    '      {!items.length && !loading && <EmptyState title="还没有笔记" />}',
    '    </section>',
    '  );',
    '}'
  ];

  SOURCES['timeline.cache.ts'] = [
    '/**',
    ' * 时间线缓存。两层：',
    ' *   内存 LRU  —— 顶住翻页时的抖动',
    ' *   KV 落盘   —— 冷启动直接出内容，别等网络',
    ' * 合并逻辑必须幂等 —— 同一条可能从多个入口进来。',
    ' */',
    '',
    'import { LRU } from "@/lib/lru";',
    'import { kv } from "@/lib/kv";',
    'import type { Post } from "@/types/post";',
    '',
    'const MEMORY_MAX = 300;',
    'const DISK_TTL = 6 * 60 * 60;',
    'const PAGE_KEY = "timeline:page";',
    '',
    'const memory = new LRU<string, Post>(MEMORY_MAX);',
    '',
    'export async function loadPage(cursor: string | null) {',
    '  const key = PAGE_KEY + ":" + (cursor || "head");',
    '',
    '  const cached = await kv.get<Post[]>(key);',
    '  if (cached) {',
    '    cached.forEach((p) => memory.set(p.id, p));',
    '    return cached;',
    '  }',
    '',
    '  const res = await fetch("/api/timeline?cursor=" + (cursor || ""));',
    '  if (!res.ok) throw new Error("timeline " + res.status);',
    '',
    '  const page = (await res.json()) as Post[];',
    '  await kv.set(key, page, { ttl: DISK_TTL });',
    '  return page;',
    '}',
    '',
    'export function mergePosts(a: Post[], b: Post[]) {',
    '  const seen = new Set<string>();',
    '  const out: Post[] = [];',
    '',
    '  for (const p of a.concat(b)) {',
    '    if (seen.has(p.id)) continue;',
    '    seen.add(p.id);',
    '',
    '    const hit = memory.get(p.id);',
    '    if (!hit || hit.updatedAt < p.updatedAt) {',
    '      memory.set(p.id, p);',
    '      out.push(p);',
    '    } else {',
    '      out.push(hit);',
    '    }',
    '  }',
    '',
    '  out.sort((x, y) => y.createdAt - x.createdAt);',
    '  return out;',
    '}',
    '',
    'export function applyReaction(id: string, delta: 1 | -1) {',
    '  const hit = memory.get(id);',
    '  if (!hit) return;',
    '  hit.likes = Math.max(0, hit.likes + delta);',
    '  memory.set(id, hit);',
    '}',
    '',
    'export function stats() {',
    '  return { size: memory.size, hit: memory.hitCount };',
    '}'
  ];

  SOURCES['cdn.proxy.ts'] = [
    '/**',
    ' * 媒体回源代理。核心是把 Range 请求原样透传下去，',
    ' * 否则播放器每次拖动进度条都要从头下一遍。',
    ' */',
    '',
    'import { NextRequest, NextResponse } from "next/server";',
    'import { proxyFetch } from "@/lib/proxy-fetch";',
    'import { signUrl } from "@/lib/signing";',
    'import { metrics } from "@/lib/metrics";',
    '',
    'export const runtime = "nodejs";',
    '',
    'const ALLOW_HOSTS = [',
    '  "media.example-cdn.net",',
    '  "static.example-cdn.net",',
    '  "edge.example-vod.com"',
    '];',
    '',
    'const FORWARD_HEADERS = ["range", "if-range", "if-none-match", "accept"];',
    '',
    'export async function GET(req: NextRequest) {',
    '  const target = req.nextUrl.searchParams.get("u");',
    '  if (!target) {',
    '    return NextResponse.json({ error: "missing_url" }, { status: 400 });',
    '  }',
    '',
    '  let parsed: URL;',
    '  try {',
    '    parsed = new URL(target);',
    '  } catch {',
    '    return NextResponse.json({ error: "bad_url" }, { status: 400 });',
    '  }',
    '',
    '  if (!ALLOW_HOSTS.includes(parsed.host)) {',
    '    return NextResponse.json({ error: "host_not_allowed" }, { status: 403 });',
    '  }',
    '',
    '  const headers: Record<string, string> = {};',
    '  for (const name of FORWARD_HEADERS) {',
    '    const v = req.headers.get(name);',
    '    if (v) headers[name] = v;',
    '  }',
    '',
    '  const started = Date.now();',
    '  const upstream = await proxyFetch(signUrl(parsed.toString()), {',
    '    headers,',
    '    timeout: 15000',
    '  });',
    '',
    '  if (!upstream.ok && upstream.status !== 206) {',
    '    metrics.inc("cdn.error", { status: upstream.status });',
    '    return new NextResponse(null, { status: 502 });',
    '  }',
    '',
    '  const passthrough = ["content-type", "content-length", "content-range"];',
    '  const out = new Headers();',
    '  for (const name of passthrough) {',
    '    const v = upstream.headers.get(name);',
    '    if (v) out.set(name, v);',
    '  }',
    '  out.set("cache-control", "public, max-age=86400, immutable");',
    '  out.set("accept-ranges", "bytes");',
    '',
    '  metrics.observe("cdn.latency", Date.now() - started);',
    '  return new NextResponse(upstream.body, { status: upstream.status, headers: out });',
    '}'
  ];

  SOURCES['qa.thread.tsx'] = [
    '"use client";',
    '',
    'import { useState } from "react";',
    'import { Markdown } from "@/components/markdown";',
    'import { VoteBox } from "@/components/vote-box";',
    'import { useCollapse } from "@/hooks/useCollapse";',
    'import type { Question, Answer } from "@/types/qa";',
    '',
    'const PREVIEW_LINES = 6;',
    '',
    'type Props = {',
    '  question: Question;',
    '  answers: Answer[];',
    '  onVote: (id: string, dir: 1 | -1) => void;',
    '};',
    '',
    'export function Thread({ question, answers, onVote }: Props) {',
    '  const { open, toggle } = useCollapse(false);',
    '  const [sort, setSort] = useState<"top" | "new">("top");',
    '',
    '  const ranked = [...answers].sort((a, b) =>',
    '    sort === "top" ? b.score - a.score : b.createdAt - a.createdAt',
    '  );',
    '',
    '  const shown = open ? ranked : ranked.slice(0, PREVIEW_LINES);',
    '',
    '  return (',
    '    <article className="thread">',
    '      <h1 className="thread-q">{question.title}</h1>',
    '      <div className="thread-meta">',
    '        <span>{question.author.name}</span>',
    '        <span>{question.followers} 人关注</span>',
    '        <span>{question.views.toLocaleString()} 次浏览</span>',
    '      </div>',
    '',
    '      <Markdown source={question.body} />',
    '',
    '      <div className="thread-bar">',
    '        <strong>{answers.length} 个回答</strong>',
    '        <div className="thread-sort">',
    '          <button',
    '            className={sort === "top" ? "on" : ""}',
    '            onClick={() => setSort("top")}',
    '          >',
    '            按质量',
    '          </button>',
    '          <button',
    '            className={sort === "new" ? "on" : ""}',
    '            onClick={() => setSort("new")}',
    '          >',
    '            按时间',
    '          </button>',
    '        </div>',
    '      </div>',
    '',
    '      <ul className="thread-list">',
    '        {shown.map((a) => (',
    '          <li key={a.id} className="thread-item">',
    '            <VoteBox',
    '              score={a.score}',
    '              onUp={() => onVote(a.id, 1)}',
    '              onDown={() => onVote(a.id, -1)}',
    '            />',
    '            <div className="thread-body">',
    '              <Markdown source={a.body} />',
    '            </div>',
    '          </li>',
    '        ))}',
    '      </ul>',
    '',
    '      {ranked.length > PREVIEW_LINES && (',
    '        <button className="thread-more" onClick={toggle}>',
    '          {open ? "收起" : "展开全部 " + ranked.length + " 个回答"}',
    '        </button>',
    '      )}',
    '    </article>',
    '  );',
    '}'
  ];

  // ══════════════════════════════════════════════════════════════════════════
  //  二、极简 TS / TSX 高亮器（够用就好，不引依赖）
  // ══════════════════════════════════════════════════════════════════════════
  var KEYWORDS = [
    'import', 'from', 'export', 'const', 'let', 'var', 'function', 'return',
    'await', 'async', 'if', 'else', 'for', 'of', 'in', 'new', 'class',
    'extends', 'implements', 'interface', 'type', 'default', 'try', 'catch',
    'finally', 'throw', 'as', 'typeof', 'instanceof', 'null', 'undefined',
    'true', 'false', 'void', 'delete', 'yield', 'static', 'readonly', 'enum',
    'declare', 'satisfies', 'keyof', 'this', 'super', 'private', 'public',
    'protected', 'abstract', 'break', 'continue', 'while', 'do', 'switch',
    'case', 'use', 'client'
  ];
  var TYPES = [
    'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object',
    'bigint', 'symbol', 'Promise', 'Array', 'Record', 'Map', 'Set', 'Date',
    'Error', 'URL', 'URLSearchParams', 'String', 'Number', 'Boolean', 'JSON',
    'Request', 'Response', 'Headers', 'NextRequest', 'NextResponse',
    'NodeJS', 'Buffer', 'WebSocket', 'KeyboardEvent', 'TouchEvent', 'MouseEvent'
  ];
  var KW = {}; KEYWORDS.forEach(function (k) { KW[k] = 1; });
  var TY = {}; TYPES.forEach(function (k) { TY[k] = 1; });

  function isIdChar(c) { return /[A-Za-z0-9_$]/.test(c); }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function push(out, kind, text) {
    if (text) out.push([kind, text]);
  }

  function tokenize(src) {
    var out = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src[i];
      var c2 = src[i + 1];

      // 行注释
      if (c === '/' && c2 === '/') {
        var e = src.indexOf('\n', i);
        if (e < 0) e = n;
        push(out, 'cm', src.slice(i, e));
        i = e;
        continue;
      }
      // 块注释
      if (c === '/' && c2 === '*') {
        var e2 = src.indexOf('*/', i + 2);
        e2 = e2 < 0 ? n : e2 + 2;
        push(out, 'cm', src.slice(i, e2));
        i = e2;
        continue;
      }
      // 字符串（含模板串）
      if (c === '"' || c === "'" || c === '`') {
        var j = i + 1;
        while (j < n && src[j] !== c) {
          if (src[j] === '\\') j++;
          j++;
        }
        push(out, 'st', src.slice(i, Math.min(j + 1, n)));
        i = j + 1;
        continue;
      }
      // JSX / 泛型标签：<Foo、</Foo>
      if (c === '<') {
        var t = i + 1;
        var slash = '';
        if (src[t] === '/') { slash = '/'; t++; }
        if (/[A-Za-z]/.test(src[t] || '')) {
          var s0 = t;
          while (t < n && /[A-Za-z0-9_.]/.test(src[t])) t++;
          var tagName = src.slice(s0, t);
          push(out, 'tx', '<' + slash);
          // 小写开头才是 DOM 标签；大写是组件。泛型参数归到类型色
          if (TY[tagName]) push(out, 'ty', tagName);
          else if (/^[A-Z]/.test(tagName) || slash) push(out, 'cl', tagName);
          else push(out, 'tg', tagName);
          i = t;
          continue;
        }
      }
      // 数字
      if (/[0-9]/.test(c) && !isIdChar(src[i - 1] || '')) {
        var k = i;
        while (k < n && /[0-9._xXa-fA-F]/.test(src[k])) k++;
        push(out, 'nu', src.slice(i, k));
        i = k;
        continue;
      }
      // 标识符
      if (/[A-Za-z_$]/.test(c)) {
        var m = i;
        while (m < n && isIdChar(src[m])) m++;
        var w = src.slice(i, m);
        var nx = src[m] || '';
        var pv = src[i - 1] || '';
        if (KW[w]) push(out, 'kw', w);
        else if (TY[w]) push(out, 'ty', w);
        else if (/^[A-Z]/.test(w)) push(out, 'cl', w);
        else if (nx === '(') push(out, 'fn', w);
        else if (pv === '.' || nx === ':' || nx === '=') push(out, 'pr', w);
        else push(out, 'tx', w);
        i = m;
        continue;
      }
      push(out, 'tx', c);
      i++;
    }
    return out;
  }

  function hl(line) {
    return tokenize(line)
      .map(function (t) {
        return t[1] === '' ? '' : '<span class="t-' + t[0] + '">' + esc(t[1]) + '</span>';
      })
      .join('');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  三、按当前文件现场生成 diff / 测试 / 日志
  // ══════════════════════════════════════════════════════════════════════════

  // 32 位整数当哈希用 —— 只是为了让 index 行看起来像那么回事
  function hash(s, seed) {
    var h = (seed || 0x811c9dc5) >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0').slice(0, 7);
  }

  // 造一个「像是上一版」的行。必须保证和原行**看得出区别** ——
  // 之前这里有一句 `replace('function','function')`（自己替换自己），
  // 结果 diff 里出现 `- x` / `+ x` 完全一样的两行，一眼就是假的。
  function older(line) {
    var out = line;
    if (/\bconst\b/.test(out)) out = out.replace(/\bconst\b/, 'let');
    else if (/\blet\b/.test(out)) out = out.replace(/\blet\b/, 'const');
    else if (/\d/.test(out)) out = out.replace(/\d+/, function (m) { return String(Number(m) - 1); });
    else if (/await /.test(out)) out = out.replace('await ', '');
    else if (/===/.test(out)) out = out.replace('===', '==');
    else if (/!==/.test(out)) out = out.replace('!==', '!=');
    else if (/;\s*$/.test(out)) out = out.replace(/;\s*$/, '');
    else out = '  ' + out;          // 退化成「重新缩进」—— diff 里最常见的一种改动
    if (out === line) out = '  ' + line;
    return out;
  }

  function pathFor(file) {
    return /\.tsx$/.test(file) ? 'src/components/' + file : 'src/lib/' + file;
  }

  // 从真实源码里切三个 hunk 出来 —— 上下文行是真的，所以行号和内容对得上。
  // hunk 头里的两个计数是算出来的（老行数 = 上下文 + 删除行，新行数 = 上下文 + 新增行），
  // 不能拍脑袋写 —— 数不对的话，懂 diff 的人一眼就看出来这是编的。
  function buildDiff(file) {
    var lines = SOURCES[file] || SOURCES['feed.aggregator.ts'];
    var path = pathFor(file);
    var out = [
      'diff --git a/' + path + ' b/' + path,
      'index ' + hash(file) + '..' + hash(file, 0x9e3779b9) + ' 100644',
      '--- a/' + path,
      '+++ b/' + path
    ];

    var n = lines.length;
    var starts = [Math.floor(n * 0.10), Math.floor(n * 0.42), Math.floor(n * 0.74)];
    var used = {};

    starts.forEach(function (start, si) {
      var from = Math.max(1, start);
      if (used[from]) return;
      used[from] = 1;

      var ctxBefore = 3;
      var pool = lines.slice(from - 1, from - 1 + 12);
      if (pool.length < ctxBefore + 2) return;

      var body = [];
      var oldN = 0;
      var newN = 0;

      pool.slice(0, ctxBefore).forEach(function (l) {
        body.push(' ' + l);
        oldN++;
        newN++;
      });

      pool.slice(ctxBefore).forEach(function (l, idx) {
        var t = l.trim();
        // 空行 / 收尾括号 / 每三条挑一条 —— 只加不删。全是增删对反而假
        if (!t || /^[}\])];/.test(t) || (idx + si) % 3 === 1) {
          body.push('+' + l);
          newN++;
        } else {
          body.push('-' + older(l));
          oldN++;
          body.push('+' + l);
          newN++;
        }
      });

      out.push('@@ -' + from + ',' + oldN + ' +' + from + ',' + newN + ' @@');
      out = out.concat(body);
    });

    return out;
  }

  // 开发服务器日志。把当前文件名嵌进去 —— 这样“日志在跑这个项目”是自洽的
  function buildLog(file) {
    var base = file.replace(/\.(ts|tsx)$/, '');
    var head = [
      '> inkstack@1.4.2 dev',
      '> next dev --turbo --port 3000',
      '',
      '  \u25b2 Next.js 15.1.6 (turbo)',
      '  - Local:        http://localhost:3000',
      '  - Network:      http://192.168.1.24:3000',
      '  - Environments: .env.local',
      '  - Experiments:  turbo, serverActions',
      '',
      ' \u2713 Starting...',
      ' \u2713 Ready in 1184ms',
      ' \u2713 Compiled / in 842ms (1847 modules)',
      ' GET / 200 in 921ms',
      ' \u2713 Compiled ' + base + ' in 318ms (2065 modules)',
      ' GET /api/feed?cursor=2026-09-16T07%3A12Z&limit=20 200 in 214ms',
      ' GET /api/feed?cursor=2026-09-15T21%3A48Z&limit=20 200 in 187ms',
      ' \u2713 Compiled /blog/[slug] in 402ms (2210 modules)',
      ' GET /blog/why-i-still-use-sql 200 in 260ms'
    ];
    var tail = [
      ' GET /api/tags 200 in 42ms',
      ' \u25cb Compiling middleware ...',
      ' \u2713 Compiled middleware in 96ms (1184 modules)',
      ' POST /api/feed 201 in 331ms',
      ' GET /api/feed?limit=20 200 in 198ms',
      ' \u2713 Compiled ' + base + ' in 274ms (2071 modules)',
      ' GET /dashboard 200 in 288ms',
      ' POST /api/feed/42/like 200 in 61ms',
      ' GET /api/feed?tag=nextjs 200 in 176ms',
      ' \u25b2 Slow route: /api/rank took 812ms',
      ' GET /api/rank?window=7d 200 in 812ms',
      ' POST /api/draft/autosave 204 in 88ms',
      ' GET /api/feed?cursor=2026-09-15T09%3A02Z 200 in 203ms',
      ' \u25cb Compiling /settings/profile ...',
      ' \u2713 Compiled /settings/profile in 366ms (2251 modules)',
      ' GET /settings/profile 200 in 291ms',
      ' POST /api/auth/refresh 200 in 74ms',
      ' GET /api/feed?limit=50 200 in 342ms'
    ];
    return { head: head, tail: tail };
  }

  // vitest 输出：先出几行文件级结果，然后一条条点亮
  var TEST_SUITES = [
    ['src/lib/__tests__/ranker.test.ts', 12, 84],
    ['src/lib/__tests__/auth.test.ts', 8, 41],
    ['src/lib/__tests__/ratelimit.test.ts', 6, 33],
    ['src/lib/__tests__/lru.test.ts', 9, 12],
    ['src/lib/__tests__/frame.test.ts', 14, 27],
    ['src/app/api/feed/__tests__/route.test.ts', 17, 156],
    ['src/hooks/__tests__/useDebounced.test.ts', 5, 22],
    ['src/components/__tests__/votes.test.tsx', 11, 61]
  ];

  function buildTest() {
    var head = [
      '> inkstack@1.4.2 test',
      '> vitest run --reporter=verbose',
      '',
      ' RUN  v2.1.8 D:/Desktop/BokeJang/inkstack',
      ''
    ];
    TEST_SUITES.forEach(function (s) {
      head.push(' \u2713 ' + s[0] + ' (' + s[1] + ' tests) ' + s[2] + 'ms');
    });
    head.push('');
    var tail = [
      ' PASS  src/lib/__tests__/ranker.test.ts',
      '   \u2713 ranks by recency when no signals',
      '   \u2713 boosts authors the reader follows',
      '   \u2713 caps the boost at 2x',
      '   \u2713 stable when all scores tie',
      '',
      ' PASS  src/app/api/feed/__tests__/route.test.ts',
      '   \u2713 returns 401 without a session',
      '   \u2713 clamps limit to 50',
      '   \u2713 cursor pagination never skips a row',
      '   \u2713 sets Retry-After on 429',
      '',
      ' PASS  src/lib/__tests__/frame.test.ts',
      '   \u2713 rejects frames larger than 4MB',
      '   \u2713 keeps the carry buffer across chunks',
      '',
      ' Test Files  14 passed (14)',
      '      Tests  126 passed (126)',
      '   Duration  3.42s'
    ];
    return { head: head, tail: tail };
  }

  // git log --graph：手写一段，分支交错才像真的。
  // 单行长度必须压在 ~70 字符以内 —— 窗口只有 530px 宽，
  // 超出会在右边被硬裁掉，反而露出「这是拼出来的」。
  var GIT_ROWS = [
    ['* 4a91c2e (HEAD -> main, origin/main)', 'fix(feed): clamp limit', '3h'],
    ['* b7f30d1', 'refactor(ranker): hoist weights', '5h'],
    ['|\\'],
    ['| * 9c2e11a', 'chore: bump next to 15.1.6', '8h'],
    ['| * 2f81b04', 'test(frame): carry buffer case', '8h'],
    ['|/'],
    ['* e30d7aa', 'perf(timeline): skip disk read', '10h'],
    ['* 7c5a210', 'feat(live): jitter ws backoff', '1d'],
    ['* 12ab9f3', 'fix(player): restore rate', '1d'],
    ['|\\'],
    ['| * 88dd310', 'feat(notes): infinite scroll', '1d'],
    ['| * 5b2c907', 'style: normalize empty states', '2d'],
    ['|/'],
    ['* c4f0e21', 'feat(cdn): passthrough Range', '2d'],
    ['* a9f1b62', 'fix(auth): rotate refresh token', '3d'],
    ['* 63e8d09', 'refactor(kv): one interface', '3d'],
    ['|\\'],
    ['| * f0b7c55', 'feat(api): draft autosave 30s', '4d'],
    ['| * d1a2e88', 'chore: drop unused sharp', '4d'],
    ['|/'],
    ['* 7711c3d', 'perf(feed): select only needed', '5d'],
    ['* 2b6e904', 'fix(ws): no heartbeat offline', '6d'],
    ['* 8dcc0a7', 'test(ratelimit): fake clock', '6d'],
    ['* 40f2a1b', 'feat(search): debounce input', '1w'],
    ['* 9b31e5f', 'docs: cursor pagination', '1w'],
    ['* 5e7c204', 'init: next 15 + mysql2', '2w']
  ];

  var GIT_BODY = GIT_ROWS.map(function (r) {
    if (r.length === 1) return r[0];
    var s = r[0] + ' ' + r[1];
    while (s.length < 62) s += ' ';
    return s + r[2];
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  四、通用工具
  // ══════════════════════════════════════════════════════════════════════════
  var timers = [];

  function clearTimers() {
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    timers = [];
  }

  function every(ms, fn) {
    var id = setInterval(fn, ms);
    timers.push(id);
    return id;
  }

  function later(ms, fn) {
    var id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // 行号槽宽度按位数自适应（三位数行号和两位数行号不该一样宽）
  function gutterWidth(lines) {
    return Math.max(26, String(lines).length * 7.2 + 16);
  }

  // 源码行数变化时自动往下来一点，模拟「在读代码」
  function autoScroll(body, gutter, opts) {
    var step = opts.step;
    var every_ms = opts.every;
    var dir = 1;
    every(every_ms, function () {
      var max = body.scrollHeight - body.clientHeight;
      if (max <= 0) return;
      body.scrollTop += dir * step();
      if (body.scrollTop >= max - 1) dir = -1;
      if (body.scrollTop <= 0) dir = 1;
      if (gutter) gutter.scrollTop = body.scrollTop;
      if (opts.report) opts.report();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  五、面具：code
  // ══════════════════════════════════════════════════════════════════════════
  var codeMask = {
    id: 'code',
    label: 'route.ts',
    mount: function (body, gutter, api, ctx) {
      var file = (ctx && ctx.file) || 'feed.aggregator.ts';
      var lines = SOURCES[file] || SOURCES['feed.aggregator.ts'];
      var lh = 16;

      var html = [];
      var gh = [];
      for (var i = 0; i < lines.length; i++) {
        gh.push('<span class="gl">' + (i + 1) + '</span>');
        html.push('<div class="cl">' + (hl(lines[i]) || '&nbsp;') + '</div>');
      }
      body.innerHTML = html.join('');
      gutter.innerHTML = gh.join('');
      body.scrollTop = 0;
      gutter.style.setProperty('--gw', gutterWidth(lines.length) + 'px');

      var lastLn = 1;
      function report() {
        var ln = Math.round(body.scrollTop / lh) + 1;
        if (ln !== lastLn) {
          lastLn = ln;
          if (api && api.setCursor) api.setCursor(ln + 11, 8);
        }
      }
      report();

      autoScroll(body, gutter, {
        every: 1400,
        step: function () { return (1 + Math.round(Math.random() * 2)) * 2; },
        report: report
      });

      // 偶尔「敲两个字符」再删掉 —— 看起来像在想事情，而不是放录像
      later(rnd(6000, 12000), function tick() {
        var line = body.querySelector('.cl:nth-child(' + (lastLn + 3) + ')');
        if (line) {
          line.classList.add('typing');
          var old = line.innerHTML;
          var buf = '';
          var chars = 2 + Math.floor(Math.random() * 3);
          var t = 0;
          var typer = setInterval(function () {
            if (t >= chars) {
              clearInterval(typer);
              line.innerHTML = old;
              line.classList.remove('typing');
              return;
            }
            buf += 'abcdefghijklmnopqrstuvwxyz_'.charAt(Math.floor(Math.random() * 27));
            line.innerHTML = old + buf + '<span class="caret"></span>';
            t++;
          }, 90);
          timers.push(typer);
        }
        later(rnd(9000, 17000), tick);
      });

      return function () { clearTimers(); };
    }
  };

  // ── 面具：diff ────────────────────────────────────────────────────────────
  var diffMask = {
    id: 'diff',
    label: 'Changes',
    mount: function (body, gutter, api, ctx) {
      var file = (ctx && ctx.file) || 'feed.aggregator.ts';
      var DIFF = buildDiff(file);

      var html = [];
      var gh = [];
      var addHunk = 0;

      for (var i = 0; i < DIFF.length; i++) {
        var raw = DIFF[i];
        var kind = 'ctx';
        var text = raw;

        if (raw.indexOf('diff ') === 0 || raw.indexOf('index ') === 0 ||
            raw.indexOf('+++') === 0 || raw.indexOf('---') === 0) {
          kind = 'meta';
        } else if (raw.indexOf('@@') === 0) {
          kind = 'hunk';
          addHunk++;
        } else if (raw.charAt(0) === '+') { kind = 'add'; text = raw.slice(1); }
        else if (raw.charAt(0) === '-') { kind = 'del'; text = raw.slice(1); }
        else if (raw.charAt(0) === ' ') { kind = 'ctx'; text = raw.slice(1); }

        // 行号槽：新增行给递增号，删除行只有标记没有号（和编辑器一致）
        var mark = kind === 'add' ? '+' : kind === 'del' ? '-' : '';
        gh.push('<span class="gl d-' + kind + '">' + (mark || '') + '</span>');
        html.push('<div class="dl d-' + kind + '">' + (hl(text) || '&nbsp;') + '</div>');
      }

      body.innerHTML = html.join('');
      gutter.innerHTML = gh.join('');
      gutter.style.setProperty('--gw', '26px');
      body.scrollTop = 0;
      gutter.scrollTop = 0;

      if (api && api.setCursor) api.setCursor(addHunk * 7 + 14, 1);

      autoScroll(body, gutter, {
        every: 1200,
        step: function () { return 8; }
      });

      return function () { clearTimers(); };
    }
  };

  // ── 面具：log ─────────────────────────────────────────────────────────────
  var logMask = {
    id: 'log',
    label: 'Terminal',
    mount: function (body, gutter, api, ctx) {
      var file = (ctx && ctx.file) || 'feed.aggregator.ts';
      var cfg = buildLog(file);

      gutter.innerHTML = '';
      gutter.style.setProperty('--gw', '0px');
      body.innerHTML = '';
      body.classList.add('is-term');

      function mkLine(text, isNew) {
        var el = document.createElement('div');
        el.className = 'll';
        if (/^\s*\u2713/.test(text)) el.classList.add('ok');
        else if (/^\s*\u25cb/.test(text)) el.classList.add('work');
        else if (/^\s*\u25b2/.test(text)) el.classList.add('warn');
        else if (/^>/.test(text)) el.classList.add('cmd');
        else if (/ 20[014] in /.test(text)) el.classList.add('done');
        if (isNew) el.classList.add('fresh');
        el.textContent = text || ' ';
        return el;
      }

      cfg.head.forEach(function (l) { body.appendChild(mkLine(l)); });
      body.scrollTop = body.scrollHeight;

      var li = 0;
      function step() {
        body.appendChild(mkLine(cfg.tail[li % cfg.tail.length], true));
        li++;
        while (body.childNodes.length > 400) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
        if (api && api.setCursor) api.setCursor(1, 1);
        later(rnd(900, 1900), step);
      }
      later(600, step);

      return function () {
        clearTimers();
        body.classList.remove('is-term');
      };
    }
  };

  // ── 面具：test（vitest）──────────────────────────────────────────────────
  var testMask = {
    id: 'test',
    label: 'vitest',
    mount: function (body, gutter, api, ctx) {
      var T = buildTest();

      gutter.innerHTML = '';
      gutter.style.setProperty('--gw', '0px');
      body.innerHTML = '';
      body.classList.add('is-term', 'is-test');

      function line(text, cls) {
        var el = document.createElement('div');
        el.className = 'll' + (cls ? ' ' + cls : '');
        el.textContent = text || ' ';
        return el;
      }

      T.head.forEach(function (l) {
        var cls = '';
        if (/^\s*\u2713/.test(l)) cls = 'ok';
        else if (/^>/.test(l)) cls = 'cmd';
        else if (/^ RUN/.test(l)) cls = 'run';
        body.appendChild(line(l, cls));
      });
      body.scrollTop = body.scrollHeight;

      // 测试是一条条「跑出来」的：先打印用例名，隔一会儿再打那个 PASS 块
      var li = 0;
      var passed = 0;
      function step() {
        var raw = T.tail[li % T.tail.length];
        var cls = /PASS/.test(raw) ? 'run' : /^\s*\u2713/.test(raw) ? 'ok' : '';
        if (/^\s*\u2713/.test(raw)) passed++;
        if (/Test Files|Duration|Tests/.test(raw)) cls = 'sum';

        var el = line(raw, cls);
        el.classList.add('fresh');
        body.appendChild(el);

        // 顶部那几行“总数”跟着跳，像真的在跑
        if (passed % 6 === 0 && api && api.setStats) api.setStats(passed);
        while (body.childNodes.length > 400) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
        li++;
        later(rnd(260, 640), step);
      }
      later(420, step);

      return function () {
        clearTimers();
        body.classList.remove('is-term', 'is-test');
      };
    }
  };

  // ── 面具：git ─────────────────────────────────────────────────────────────
  var gitMask = {
    id: 'git',
    label: 'git log',
    mount: function (body, gutter, api, ctx) {
      gutter.innerHTML = '';
      gutter.style.setProperty('--gw', '0px');
      body.innerHTML = '';
      body.classList.add('is-term', 'is-git');

      var html = GIT_BODY.map(function (l) {
        var cls = 'g-line';
        if (/\* /.test(l)) cls += ' g-commit';
        if (/^[|\\\/ ]*\\/.test(l)) cls += ' g-merge';
        if (/\u2713|fix\(|feat\(|chore\(|docs\(|test\(|perf\(|refactor\(|style\(|init:/.test(l)) {
          cls += ' g-msg';
        }
        // 提交哈希单独上色
        var s = esc(l).replace(
          /\b([0-9a-f]{7})\b/,
          '<span class="g-hash">$1</span>'
        );
        s = s.replace(
          /\b(fix|feat|chore|docs|test|perf|refactor|style|init)(\([^)]*\))?:/,
          '<span class="g-kind">$1$2:</span>'
        );
        s = s.replace(/(\(HEAD ->[^)]*\))/, '<span class="g-ref">$1</span>');
        return '<div class="' + cls + '">' + s + '</div>';
      });

      body.innerHTML = html.join('');
      body.scrollTop = 0;

      if (api && api.setCursor) api.setCursor(1, 1);

      autoScroll(body, null, {
        every: 1500,
        step: function () { return 4; }
      });

      return function () { clearTimers(); };
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  导出
  // ══════════════════════════════════════════════════════════════════════════
  window.SF_MASKS = {
    code: codeMask,
    diff: diffMask,
    log: logMask,
    test: testMask,
    git: gitMask,
    order: ['code', 'diff', 'log', 'test', 'git'],
    sources: SOURCES,
    files: Object.keys(SOURCES),
    gutterWidth: gutterWidth,
    tokenize: tokenize,
    // 下面几个只在排查 / 测试时用（Node 里 require 这个文件就能直接看输出）
    previewDiff: buildDiff,
    previewLog: function (f) { return buildLog(f).head.concat(buildLog(f).tail); },
    previewTest: function () { var t = buildTest(); return t.head.concat(t.tail); },
    previewGit: function () { return GIT_BODY.slice(); }
  };
})();

#!/usr/bin/env node
'use strict';
/**
 * 川（chuān）—— 给对话历史瘦身。
 *
 * 剥掉思考块、工具调用和工具结果、搜索结果、图片这些「大块头」，
 * 只留人和 AI 之间说的话。留下来的每个字都是原文，不总结、不改写。
 *
 * 两种用法：
 *   1. 当库用：stripMessages(messages, opts) —— 吃进一个 messages 数组，吐出瘦好的数组
 *   2. 当命令行用：
 *        node chuan.js messages <in.json> [-o out.json]
 *        node chuan.js session  <session-id 或 .jsonl 路径> [--apply]
 *        node chuan.js list
 *
 * 零依赖，Node 18+。MIT。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────
// 公共：一条消息的 content 里，哪些块留、哪些剥
// ─────────────────────────────────────────────────────────────────────

/** 工具名是否命中 --keep-tool 列表。支持末尾 * 通配：mcp__notes__* */
function toolMatches(name, patterns) {
  if (!name || !patterns || !patterns.length) return false;
  return patterns.some(p => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * 处理一个 content。
 * keepIds：本次要保留的 tool_use id（由 keepTools 决定，tool_result 跟着它走）。
 * 返回 { content, dropped: {type: n} }；content 为 null 表示这条消息整条可以删。
 */
function slimContent(content, opts, keepIds, dropped) {
  if (typeof content === 'string') {
    // 纯字符串本身就是对话原文，原样留着（空的除外）
    if (!content.trim()) return null;
    if (opts.dropTextPrefix.some(p => content.startsWith(p))) { bump(dropped, 'text(前缀)'); return null; }
    return content;
  }
  if (!Array.isArray(content)) return null;
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && opts.dropTextPrefix.some(p => b.text.startsWith(p))) {
          bump(dropped, 'text(前缀)'); break;
        }
        out.push(b); break;
      case 'tool_use':
      case 'server_tool_use':
        if (keepIds.has(b.id)) out.push(b); else bump(dropped, b.type);
        break;
      case 'tool_result':
        if (keepIds.has(b.tool_use_id)) out.push(b); else bump(dropped, b.type);
        break;
      case 'image':
        bump(dropped, 'image');
        if (opts.placeholders) out.push({ type: 'text', text: '［这里原来有一张图片，瘦身时剥掉了］' });
        break;
      case 'document':
        bump(dropped, 'document');
        if (opts.placeholders) out.push({ type: 'text', text: `［这里原来有一个文件${b.title ? `「${b.title}」` : ''}，瘦身时剥掉了］` });
        break;
      default:
        // thinking / redacted_thinking / web_search_tool_result / 其他不认识的：一律剥
        // 搜索结果的配对：web_search_tool_result 跟着 server_tool_use 走
        if (b.tool_use_id && keepIds.has(b.tool_use_id)) { out.push(b); break; }
        bump(dropped, b.type || '?');
    }
  }
  return out.length ? out : null;
}

function bump(m, k) { m[k] = (m[k] || 0) + 1; }

/** 从一串消息里挑出要保留的 tool_use id（工具名命中 keepTools 的） */
function collectKeepIds(contents, keepTools) {
  const ids = new Set();
  if (!keepTools || !keepTools.length) return ids;
  for (const c of contents) {
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && (b.type === 'tool_use' || b.type === 'server_tool_use') && toolMatches(b.name, keepTools)) ids.add(b.id);
    }
  }
  return ids;
}

/** 文本内容（用来判断 fold 前缀） */
function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(b => (b && b.type === 'text' ? b.text : '')).join('') : '';
}

function normOpts(o = {}) {
  return {
    keepTools: o.keepTools || [],
    dropTextPrefix: o.dropTextPrefix || [],
    foldPrefix: o.foldPrefix || [],
    placeholders: o.placeholders !== false,
    mergeSameRole: o.mergeSameRole !== false,
  };
}

/**
 * 把「同一个开头」的重复消息收起来，只留最新一条完整的。
 * 用处：某个固定的长提示（定时唤醒说明、系统提醒）每轮都塞进来一遍。
 * 返回被收起的条数和省下的字节。getContent/setContent 让两种格式共用。
 */
function foldRepeats(items, prefixes, getContent, setContent) {
  let folded = 0, saved = 0;
  for (const pre of prefixes) {
    const hits = items.filter(it => textOf(getContent(it)).startsWith(pre));
    for (const it of hits.slice(0, -1)) {
      const before = JSON.stringify(getContent(it)).length;
      const stub = `［一段重复的「${pre.slice(0, 24)}…」，瘦身时收起来了］`;
      setContent(it, typeof getContent(it) === 'string' ? stub : [{ type: 'text', text: stub }]);
      saved += before - JSON.stringify(getContent(it)).length;
      folded++;
    }
  }
  return { folded, saved };
}

// ─────────────────────────────────────────────────────────────────────
// 用法一：messages 数组（Anthropic Messages API 的格式）
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{role:string, content:string|Array}>} messages
 * @param {object} [opts]
 *   keepTools       string[]  这些工具的调用和结果保留（支持末尾 *）
 *   dropTextPrefix  string[]  以这些开头的文本块整块剥掉
 *   foldPrefix      string[]  以这些开头的重复消息只留最新一条
 *   placeholders    boolean   图片/文件剥掉后留一行占位字（默认 true）
 *   mergeSameRole   boolean   剥完后相邻同 role 合并成一条（默认 true，API 要求交替）
 * @returns {{messages: Array, stats: object}}
 */
function stripMessages(messages, opts) {
  const o = normOpts(opts);
  if (!Array.isArray(messages)) throw new Error('messages 必须是数组');
  const keepIds = collectKeepIds(messages.map(m => m && m.content), o.keepTools);
  const dropped = {};
  const work = messages.map(m => ({ ...m }));
  const fold = foldRepeats(work, o.foldPrefix, m => m.content, (m, c) => { m.content = c; });

  let out = [];
  for (const m of work) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) { if (m) out.push(m); continue; }
    const c = slimContent(m.content, o, keepIds, dropped);
    if (c == null) continue;
    out.push({ ...m, content: c });
  }

  let merged = 0;
  if (o.mergeSameRole) {
    const res = [];
    for (const m of out) {
      const prev = res[res.length - 1];
      if (prev && prev.role === m.role && (m.role === 'user' || m.role === 'assistant')) {
        const a = typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content;
        const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        res[res.length - 1] = { ...prev, content: [...a, ...b] };
        merged++;
      } else res.push(m);
    }
    out = res;
  }

  const before = JSON.stringify(messages).length, after = JSON.stringify(out).length;
  return {
    messages: out,
    stats: { before: messages.length, after: out.length, bytesBefore: before, bytesAfter: after, dropped, merged, ...fold },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 用法二：Claude Code 的会话文件（~/.claude/projects/<项目>/<id>.jsonl）
// ─────────────────────────────────────────────────────────────────────
//
// 三件实测才知道的事：
// 一、这个 jsonl 不是一条线，是一棵树。每行带 uuid / parentUuid，中断和重试会留下死枝。
//     Claude Code 从最后一个 last-prompt 的 leafUuid 往回溯，只读那一支。
//     删行会断链，断了不报错，它只会安静地少读一截 —— 所以删一行，就把它的儿子接到它父亲上。
// 二、剥掉工具往返以后会出现连续同 role，--resume 照样能起，Claude Code 自己会规整。
//     所以这里不合并行（合并要动结构）。
// 三、--resume 是在原文件后面续写，不会自己变小。所以瘦完写成一个新的 session id。

const SIDE_ROWS = new Set(['attachment', 'system']); // 在链上但不是对话：删掉并接链

function projectsDir(arg) {
  return arg || path.join(os.homedir(), '.claude', 'projects');
}

function findSession(idOrPath, projDir) {
  if (idOrPath.endsWith('.jsonl') && fs.existsSync(idOrPath)) return path.resolve(idOrPath);
  const id = idOrPath.replace(/\.jsonl$/, '');
  for (const d of fs.readdirSync(projDir)) {
    const f = path.join(projDir, d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function slimSession(src, opts) {
  const o = normOpts({ ...opts, mergeSameRole: false });
  const rows = [];
  fs.readFileSync(src, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch (e) { throw new Error(`第 ${i + 1} 行不是合法 JSON`); }
  });

  const byUuid = new Map(rows.filter(r => r.uuid).map(r => [r.uuid, r]));
  const last = rows.filter(r => r.type === 'last-prompt').pop();
  if (!last || !last.leafUuid) throw new Error('找不到 last-prompt / leafUuid，不知道该读哪一支，不敢猜');
  const chain = [], seen = new Set();
  for (let cur = last.leafUuid; cur && byUuid.has(cur) && !seen.has(cur); cur = byUuid.get(cur).parentUuid) {
    seen.add(cur); chain.push(byUuid.get(cur));
  }
  chain.reverse();
  if (!chain.length) throw new Error('从 leafUuid 回溯不到任何行');

  const unknown = chain.filter(r => !SIDE_ROWS.has(r.type) && r.type !== 'user' && r.type !== 'assistant');
  if (unknown.length) throw new Error(`链上有不认识的行类型：${[...new Set(unknown.map(r => r.type))].join(', ')}。不猜着删，请开 issue`);

  const keepIds = collectKeepIds(chain.map(r => r.message && r.message.content), o.keepTools);
  const dropped = {};
  const remap = new Map();
  const kept = [];
  for (const r of chain) {
    let p = r.parentUuid;
    while (p && remap.has(p)) p = remap.get(p);
    if (SIDE_ROWS.has(r.type)) { remap.set(r.uuid, p); continue; }
    const c = slimContent(r.message && r.message.content, o, keepIds, dropped);
    if (c == null) { remap.set(r.uuid, p); continue; }
    const n = { ...r, parentUuid: p, message: { ...r.message, content: c } };
    delete n.toolUseResult; delete n.mcpMeta;
    kept.push(n);
  }
  const fold = foldRepeats(kept.filter(r => r.message.role === 'user'), o.foldPrefix,
    r => r.message.content, (r, c) => { r.message = { ...r.message, content: c }; });

  // 链体检
  if (!kept.length) throw new Error('瘦完一条对话都不剩');
  const ids = new Set(kept.map(r => r.uuid));
  const roots = kept.filter(r => r.parentUuid == null).length;
  const broken = kept.filter(r => r.parentUuid != null && !ids.has(r.parentUuid)).length;

  const size = s => Buffer.byteLength(JSON.stringify(s));
  return {
    rows, chain, kept,
    stats: {
      fileBytes: fs.statSync(src).size,
      chainRows: chain.length, chainBytes: chain.reduce((a, r) => a + size(r), 0),
      keptRows: kept.length, keptBytes: kept.reduce((a, r) => a + size(r), 0),
      dropped, roots, broken, ...fold,
    },
  };
}

function writeSession(src, kept) {
  const newId = crypto.randomUUID();
  const dst = path.join(path.dirname(src), `${newId}.jsonl`);
  const out = kept.map(r => ({ ...r, sessionId: newId }));
  out[0] = { ...out[0], parentUuid: null };
  const lines = out.map(r => JSON.stringify(r));
  lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: '(slimmed by chuan)', leafUuid: out[out.length - 1].uuid, sessionId: newId }));
  fs.writeFileSync(dst, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  return { newId, dst };
}

// ─────────────────────────────────────────────────────────────────────
// 命令行
// ─────────────────────────────────────────────────────────────────────

const HELP = `川 —— 给对话历史瘦身

  node chuan.js messages <in.json> [-o out.json]   瘦一个 messages 数组（JSON）
  node chuan.js session <id|路径.jsonl> [--apply]  瘦一个 Claude Code 会话（默认只看账）
  node chuan.js list                               列出本机的 Claude Code 会话

通用选项：
  --keep-tool <名字>        这个工具的调用和结果保留，可写多次，支持末尾 *
  --drop-prefix <文字>      以这段文字开头的文本块整块剥掉，可写多次
  --fold <文字>             以这段文字开头的重复消息只留最新一条，可写多次
  --no-placeholder          图片/文件剥掉后不留占位字
  --projects <目录>         Claude Code 的 projects 目录（默认 ~/.claude/projects）
`;

function parseArgs(argv) {
  const a = { _: [], keepTools: [], dropTextPrefix: [], foldPrefix: [], placeholders: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { if (i + 1 >= argv.length) die(`${k} 后面缺参数`); return argv[++i]; };
    if (k === '--keep-tool') a.keepTools.push(next());
    else if (k === '--drop-prefix') a.dropTextPrefix.push(next());
    else if (k === '--fold') a.foldPrefix.push(next());
    else if (k === '--no-placeholder') a.placeholders = false;
    else if (k === '--projects') a.projects = next();
    else if (k === '-o' || k === '--out') a.out = next();
    else if (k === '--apply') a.apply = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else a._.push(k);
  }
  return a;
}

function die(msg) { console.error('川停下了：' + msg); process.exit(1); }
const fmt = n => n.toLocaleString('en-US');
const pct = (a, b) => (b ? (a * 100 / b).toFixed(1) : '0') + '%';
const showDropped = d => Object.entries(d).map(([k, v]) => `${k}=${v}`).join('  ') || '无';

function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (a.help || !cmd) { console.log(HELP); return; }

  if (cmd === 'messages') {
    if (!a._[1]) die('要给一个 JSON 文件');
    let data;
    try { data = JSON.parse(fs.readFileSync(a._[1], 'utf8')); } catch (e) { die('读不了 JSON：' + e.message); }
    const arr = Array.isArray(data) ? data : data.messages;
    if (!Array.isArray(arr)) die('文件里既不是数组，也没有 messages 字段');
    const { messages, stats } = stripMessages(arr, a);
    const result = Array.isArray(data) ? messages : { ...data, messages };
    const text = JSON.stringify(result, null, 2);
    if (a.out) fs.writeFileSync(a.out, text); else process.stdout.write(text + '\n');
    console.error(`消息 ${stats.before} → ${stats.after} 条，${fmt(stats.bytesBefore)} → ${fmt(stats.bytesAfter)} 字节（剩 ${pct(stats.bytesAfter, stats.bytesBefore)}）`);
    console.error(`剥掉  ${showDropped(stats.dropped)}；合并相邻同 role ${stats.merged} 处；收起重复 ${stats.folded} 条`);
    return;
  }

  if (cmd === 'list') {
    const dir = projectsDir(a.projects);
    if (!fs.existsSync(dir)) die(`找不到 ${dir}`);
    const all = [];
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) if (f.endsWith('.jsonl')) {
        const st = fs.statSync(path.join(p, f));
        all.push({ id: f.slice(0, -6), proj: d, size: st.size, at: st.mtime });
      }
    }
    all.sort((x, y) => y.size - x.size);
    for (const r of all.slice(0, 20)) {
      console.log(`${(r.size / 1048576).toFixed(2).padStart(7)} MB  ${r.at.toISOString().slice(0, 16).replace('T', ' ')}  ${r.id}  ${r.proj}`);
    }
    return;
  }

  if (cmd === 'session') {
    if (!a._[1]) die('要给一个 session id 或 .jsonl 路径');
    const src = findSession(a._[1], projectsDir(a.projects));
    if (!src) die(`找不到会话 ${a._[1]}`);
    let res;
    try { res = slimSession(src, a); } catch (e) { die(e.message); }
    const s = res.stats;
    console.log(`\n文件      ${src}`);
    console.log(`          ${fmt(s.fileBytes)} 字节 / ${res.rows.length} 行`);
    console.log(`真正被读  ${s.chainRows} 行 / ${fmt(s.chainBytes)} 字节（其余是死枝和旁注，模型不读）`);
    console.log(`剥掉      ${showDropped(s.dropped)}`);
    if (s.folded) console.log(`收起重复  ${s.folded} 条，省 ${fmt(s.saved)} 字节`);
    console.log(`瘦完      ${s.keptRows} 行 / ${fmt(s.keptBytes)} 字节（剩 ${pct(s.keptBytes, s.chainBytes)}）`);
    console.log(`链体检    根 ${s.roots} 个（应为 1）  断点 ${s.broken} 处（应为 0）`);
    if (s.roots !== 1 || s.broken) die('链不干净，不写');
    if (!a.apply) { console.log('\n只看了账，什么都没写。确认没问题加 --apply\n'); return; }
    const { newId, dst } = writeSession(src, res.kept);
    console.log(`\n✅ 写好了：${dst}`);
    console.log(`原文件一个字没动。接着用：claude --resume ${newId}`);
    console.log('⚠ 跑之前要先关掉这个会话的窗口；跑完到切过去之间说的话，会留在旧文件里。\n');
    return;
  }

  die(`不认识的命令 ${cmd}\n\n${HELP}`);
}

module.exports = { stripMessages, slimSession, writeSession, findSession };
if (require.main === module) main();

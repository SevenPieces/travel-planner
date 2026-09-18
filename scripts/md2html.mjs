#!/usr/bin/env node
/**
 * md2html.mjs — Convert the travel-guide Markdown dialect to a self-contained styled HTML file.
 * Line-based state machine; tolerant of missing blank lines between headings and lists.
 * Handles: ATX headings, tables, unordered/ordered lists, blockquotes, fenced code,
 * horizontal rules, paragraphs, inline bold / code / markdown links / bare URLs,
 * ```route blocks (node-arrow schematic), ```video blocks (Bilibili embed + link),
 * and ```map blocks (Leaflet + Amap real maps). A ```map block may be overview-only
 * (first line "@overview": one map with all sections' routes) or per-day (one map per
 * "== 标题" section). Local images (relative paths like images/x.jpg) are embedded
 * as base64 data URIs so the HTML stays self-contained.
 * Usage: node md2html.mjs <input.md> [output.html]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'

const [, , input, output] = process.argv
if (!input) {
  console.error('用法: node md2html.mjs <输入.md> [输出.html]')
  process.exit(1)
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const TRAIL = /[，。；：、）)」》】]+$/
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
let imgBase = process.cwd()

function resolveImg(src) {
  if (/^(https?:|data:)/.test(src)) return src
  const p = resolvePath(imgBase, src)
  if (!existsSync(p)) return src
  const ext = (p.match(/\.\w+$/) || [''])[0].toLowerCase()
  const mime = MIME[ext]
  if (!mime) return src
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
}

function inline(s) {
  const codes = []
  const links = []
  let out = esc(s)
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return `\u0000${codes.length - 1}C\u0000`
  })
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${resolveImg(src)}" alt="${alt}" loading="lazy">`)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    links.push([t, u])
    return `\u0000${links.length - 1}L\u0000`
  })
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  out = out.replace(/https?:\/\/[^\s<]+/g, (m) => {
    const u = m.replace(TRAIL, '')
    links.push([u, u])
    return `\u0000${links.length - 1}L\u0000`
  })
  out = out.replace(/\u0000(\d+)L\u0000/g, (_, n) => `<a href="${links[+n][1]}" target="_blank" rel="noopener">${links[+n][0]}</a>`)
  out = out.replace(/\u0000(\d+)C\u0000/g, (_, n) => `<code>${codes[+n]}</code>`)
  return out
}

/** Render a ```route block: one leg per line, "起点 -> 终点 | 交通 | 距离/车程 | 说明". */
function renderRoute(buf) {
  const legs = []
  for (const line of buf) {
    const t = line.trim()
    if (!t || t.startsWith('//')) continue
    const [fromTo, ...rest] = t.split('|').map((p) => p.trim())
    const parts = fromTo.split('->').map((p) => p.trim())
    if (parts.length !== 2) continue
    const label = rest.filter(Boolean).join(' · ')
    legs.push([parts[0], parts[1], label])
  }
  if (!legs.length) return ''
  return '<div class="route">' + legs
    .map(([from, to, label]) =>
      `<div class="rleg"><span class="rnode">${inline(from)}</span><span class="rarrow">→</span><span class="rlink">${inline(label)}</span><span class="rnode">${inline(to)}</span></div>`
    )
    .join('') + '</div>'
}

/** Render a ```video block: one video per line, "标题 | URL | 发布者/年份 | 备注". */
function renderVideo(buf) {
  const videos = []
  for (const line of buf) {
    const t = line.trim()
    if (!t || t.startsWith('//')) continue
    const [title, url, ...rest] = t.split('|').map((p) => p.trim())
    if (!title || !url) continue
    const meta = rest.filter(Boolean).join(' · ')
    const bv = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)
    videos.push({ title, url, meta, bv: bv ? bv[1] : null })
  }
  if (!videos.length) return ''
  const out = ['<div class="videos">']
  for (const v of videos) {
    out.push('<div class="vcard">')
    if (v.bv) {
      out.push(`<div class="vframe"><iframe src="https://player.bilibili.com/player.html?bvid=${v.bv}&autoplay=0&high_quality=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe></div>`)
    }
    out.push(`<div class="vmeta"><strong>${inline(v.title)}</strong>`)
    if (v.meta) out.push(`<span class="vsub">${inline(v.meta)}</span>`)
    out.push(`<a href="${v.url}" target="_blank" rel="noopener">▶ 打开视频页播放</a></div>`)
    out.push('</div>')
  }
  out.push('</div>')
  return out.join('')
}

/**
 * Parse a ```map block.
 * "== <标题>" starts a day section (title carries the Dn tag);
 * "名称 | lat,lng | 说明" adds a place to the current section;
 * an "@overview" line renders the overview map only (all sections' routes).
 * Returns { html, script } with ids prefixed by seq.
 */
function parseMap(buf, seq) {
  const sections = [] // { title, day, places: [{name, lat, lng, note}] }
  let cur = null
  let overviewOnly = false
  for (const line of buf) {
    const t = line.trim()
    if (!t || t.startsWith('//')) continue
    if (t.startsWith('@')) { overviewOnly = true; continue }
    if (t.startsWith('==')) {
      const title = t.replace(/^==+\s*/, '').trim()
      cur = { title, day: (title.match(/D\d+/) || [''])[0], places: [] }
      sections.push(cur)
      continue
    }
    const parts = t.split('|').map((p) => p.trim())
    if (parts.length < 2) continue
    const [name, coords, ...rest] = parts
    const c = coords.split(',').map((v) => parseFloat(v.trim()))
    if (c.length < 2 || Number.isNaN(c[0]) || Number.isNaN(c[1])) continue
    if (!cur) { cur = { title: '', day: '', places: [] }; sections.push(cur) }
    cur.places.push({ name, lat: c[0], lng: c[1], note: rest.filter(Boolean).join(' | ') })
  }
  const mapSections = sections.filter((s) => s.places.length)
  const all = mapSections.flatMap((s) => s.places)
  if (!all.length) return null
  const seen = new Set()
  const uniq = all.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)))

  const html = []
  if (overviewOnly) {
    html.push('<h4>🗺 总览 · 全部动线</h4><div id="map-ov-' + seq + '" class="map" style="height:440px;border:1px solid #d0d7de;border-radius:8px;"></div>')
    html.push('<p class="map-note">地图与视频需联网加载（Leaflet + 高德瓦片 / B 站）；视频播放量为生成时的快照。</p>')
  } else {
    mapSections.forEach((s, i) => {
      html.push('<h4>' + esc(s.title || s.day || '第' + (i + 1) + '段') + '</h4><div id="map-' + seq + '-' + i + '" class="map" style="height:320px;border:1px solid #d0d7de;border-radius:8px;"></div>')
    })
  }

  const script = `<script>
(function () {
  var dayColors = { "D0": "#9aa0a6", "D1": "#1f6feb", "D2": "#1a7f37", "D3": "#d29922", "D4": "#cf222e", "D5": "#8250df" };
  var sections = ${JSON.stringify(mapSections.map((s) => ({ title: s.title, day: s.day, places: s.places })))};
  function base(id) {
    var el = document.getElementById(id);
    if (typeof L === 'undefined') { if (el) el.innerHTML = '<p style="padding:16px">地图组件加载失败（需联网）。请以路段表为准。</p>'; return null; }
    var map = L.map(id);
    L.tileLayer('https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=8&x={x}&y={y}&z={z}', { subdomains: ['1','2','3','4'], maxZoom: 18, attribution: '© 高德地图' }).addTo(map);
    return map;
  }
  function fit(map, list) {
    if (list.length === 1) { map.setView([list[0].lat, list[0].lng], 12); return; }
    map.fitBounds(L.latLngBounds(list.map(function (p) { return [p.lat, p.lng]; })).pad(0.25));
  }
  function draw(map, pts, color) {
    L.polyline(pts, { color: color, weight: 3, opacity: 0.8 }).addTo(map);
  }
  ${overviewOnly ? `
  var uniq = ${JSON.stringify(uniq)};
  var overview = base('map-ov-${seq}');
  if (overview) {
    var seen = {};
    sections.forEach(function (s) {
      var color = dayColors[s.day] || '#1f6feb';
      var pts = [];
      s.places.forEach(function (p) {
        if (!seen[p.name]) {
          seen[p.name] = { notes: [p.note].filter(Boolean), marker: L.marker([p.lat, p.lng]).addTo(overview) };
        } else if (p.note && seen[p.name].notes.indexOf(p.note) < 0) {
          seen[p.name].notes.push(p.note);
        }
        pts.push([p.lat, p.lng]);
      });
      if (pts.length > 1) draw(overview, pts, color);
    });
    Object.keys(seen).forEach(function (n) {
      seen[n].marker.bindPopup('<b>' + n + '</b><br>' + seen[n].notes.join(' · '));
    });
    fit(overview, uniq);
  }` : `
  sections.forEach(function (s, i) {
    var map = base('map-${seq}-' + i);
    if (!map) return;
    var color = dayColors[s.day] || '#1f6feb';
    var daySeen = {};
    s.places.forEach(function (p) {
      if (daySeen[p.name]) return;
      daySeen[p.name] = true;
      L.marker([p.lat, p.lng]).addTo(map).bindPopup('<b>' + p.name + '</b><br>' + (p.note || ''));
    });
    if (s.places.length > 1) draw(map, s.places.map(function (p) { return [p.lat, p.lng]; }), color);
    fit(map, s.places);
  });`}
})();
</script>`
  return { html: html.join('\n'), script }
}

const CSS = `
:root { color-scheme: light; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  max-width: 880px; margin: 0 auto; padding: 32px 24px 64px; line-height: 1.7; color: #24292f; }
h1 { border-bottom: 3px solid #1f6feb; padding-bottom: .3em; }
h2 { border-bottom: 1px solid #d0d7de; padding-bottom: .2em; margin-top: 1.8em; }
h3 { margin-top: 1.4em; }
h4 { margin-top: 1.2em; color: #1f6feb; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 14px; }
th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
tbody tr:nth-child(even) td { background: #fafbfc; }
blockquote { border-left: 4px solid #1f6feb; background: #f6f8fa; margin: 1em 0; padding: 4px 16px; color: #57606a; }
blockquote p { margin: .5em 0; }
code { background: #f6f8fa; border-radius: 4px; padding: 2px 5px; font-family: ui-monospace, Consolas, monospace; font-size: .9em; }
pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; }
a { color: #1f6feb; }
li { margin: .25em 0; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
img { max-width: 100%; height: auto; border-radius: 8px; margin: .4em 0; }
.route { margin: 1em 0; display: flex; flex-direction: column; gap: 6px; }
.rleg { display: flex; align-items: center; gap: 10px; background: #f6f8fa; border: 1px solid #d0d7de;
  border-radius: 8px; padding: 6px 12px; flex-wrap: wrap; }
.rnode { font-weight: 600; background: #eef4ff; border: 1px solid #c5d8f8; border-radius: 6px;
  padding: 2px 10px; white-space: nowrap; }
.rarrow { color: #1f6feb; font-weight: 700; }
.rlink { color: #57606a; font-size: 13px; flex: 1; }
.map { margin: 1em 0; }
.map-note { color: #57606a; font-size: 13px; margin: .4em 0 1.2em; }
.videos { margin: 1em 0; display: flex; flex-direction: column; gap: 10px; }
.vcard { border: 1px solid #d0d7de; border-radius: 8px; padding: 8px; background: #fff; }
.vframe { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; }
.vframe iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.vmeta { padding: 8px 4px 2px; display: flex; flex-direction: column; gap: 4px; }
.vsub { color: #57606a; font-size: 13px; }
.vmeta a { font-size: 13px; }
.print-tip { position: sticky; top: 0; text-align: right; font-size: 13px; color: #57606a; }
@media print { .print-tip, .map, .map-note, .videos { display: none; } body { padding: 0; } }
`

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let para = []
  let quote = []
  const listStack = [] // { ordered, depth }
  let inFence = false
  let fenceLang = ''
  let fence = []
  let mapSeq = 0
  const mapScripts = []

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + para.map(inline).join('<br>') + '</p>')
      para = []
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      out.push('<blockquote>' + quote.join('') + '</blockquote>')
      quote = []
    }
  }
  const flushFence = () => {
    if (fence.length) out.push(`<pre><code>${esc(fence.join('\n'))}\n</code></pre>`)
    fence = []
  }
  const closeLists = (depth = -1) => {
    while (listStack.length && listStack[listStack.length - 1].depth > depth) {
      const { ordered } = listStack.pop()
      out.push(`</li></${ordered ? 'ol' : 'ul'}>`)
    }
  }
  const addListItem = (depth, ordered, text) => {
    if (listStack.length && listStack[listStack.length - 1].depth === depth) {
      out.push('</li><li>')
    } else {
      closeLists(depth)
      out.push(`<${ordered ? 'ol' : 'ul'}><li>`)
      listStack.push({ depth, ordered })
    }
    out.push(inline(text))
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (/^```/.test(t)) {
      if (inFence) {
        inFence = false
        if (fenceLang === 'route') out.push(renderRoute(fence))
        else if (fenceLang === 'video') out.push(renderVideo(fence))
        else if (fenceLang === 'map') {
          const mb = parseMap(fence, mapSeq++)
          if (mb) { out.push(mb.html); mapScripts.push(mb.script) }
        } else flushFence()
      } else {
        flushPara(); flushQuote(); closeLists()
        inFence = true
        fenceLang = t.replace(/^```/, '').trim()
        fence = []
      }
      continue
    }
    if (inFence) { fence.push(line); continue }
    if (t === '') { flushPara(); flushQuote(); closeLists(); continue }

    const h = t.match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      flushPara(); flushQuote(); closeLists()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(t)) { flushPara(); flushQuote(); closeLists(); out.push('<hr>'); continue }
    if (t.startsWith('>')) {
      flushPara(); closeLists()
      const q = t.replace(/^>\s?/, '')
      if (q !== '') quote.push(`<p>${inline(q)}</p>`)
      continue
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (li) {
      flushPara(); flushQuote()
      addListItem(Math.floor(li[1].length / 2), /^\s*\d+\./.test(li[0]), li[3])
      continue
    }
    if (t.startsWith('|')) {
      const tableLines = []
      let j = i
      while (j < lines.length && lines[j].trim().startsWith('|')) tableLines.push(lines[j++])
      if (tableLines.length >= 2) {
        flushPara(); flushQuote(); closeLists()
        const rows = tableLines.map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
        const body = rows.filter((r) => !(r.length && r.every((c) => /^:?-{3,}:?$/.test(c))))
        if (body.length) {
          const [head, ...rest] = body
          out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>')
          for (const r of rest) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
          out.push('</tbody></table>')
          i = j - 1
          continue
        }
      }
    }
    flushQuote(); closeLists()
    para.push(line)
  }
  flushPara(); flushQuote(); closeLists()
  if (inFence) {
    if (fenceLang === 'route') out.push(renderRoute(fence))
    else if (fenceLang === 'video') out.push(renderVideo(fence))
    else if (fenceLang === 'map') {
      const mb = parseMap(fence, mapSeq++)
      if (mb) { out.push(mb.html); mapScripts.push(mb.script) }
    } else flushFence()
  }
  return { body: out.join('\n'), mapScripts }
}

imgBase = dirname(input)
const title = basename(input).replace(/\.md$/i, '')
const { body, mapScripts } = render(readFileSync(input, 'utf8'))
const headExtra = mapScripts.length ? '\n<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">' : ''
const bodyExtra = mapScripts.length
  ? `\n<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>\n${mapScripts.join('\n')}`
  : ''
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>${headExtra}
</head>
<body>
<div class="print-tip">📄 阅读版 · 打印/导出 PDF：Ctrl+P（Windows）/ ⌘+P（Mac），纸张选 A4</div>
${body}${bodyExtra}
</body>
</html>
`
const outPath = output ?? input.replace(/\.md$/i, '.html')
writeFileSync(outPath, html, 'utf8')
console.log(`已生成: ${outPath}`)

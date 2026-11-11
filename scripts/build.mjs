#!/usr/bin/env node
/**
 * 文集仓的自检 + 目录生成。
 *
 *   node scripts/build.mjs           # 校验 posts/ 并重写 README.md 的目录块、生成 feed.xml
 *   node scripts/build.mjs --check   # 只校验（CI 用；有错则退出码 1）
 *
 * 这个文件在每个文集仓里各有一份，由模板仓（template repository）复制而来。
 * 改规范就改模板仓，新仓天然一致；老仓想跟上时再手动同步 —— 不要为 3 个仓写 monorepo 工具链。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSTS = path.join(ROOT, 'posts');
const CHECK_ONLY = process.argv.includes('--check');
const BEGIN = '<!-- BEGIN:POSTS -->';
const END = '<!-- END:POSTS -->';

const meta = existsSync(path.join(ROOT, 'meta.json'))
  ? JSON.parse(await readFile(path.join(ROOT, 'meta.json'), 'utf8'))
  : {};

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) return s.slice(1, -1);
  return s;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (val === '') { data[key] = ''; continue; }
    if (/^\[.*\]$/.test(val)) data[key] = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    else if (val === 'true' || val === 'false') data[key] = val === 'true';
    else data[key] = unquote(val);
  }
  return { data, body: raw.slice(m[0].length) };
}

const errors = [];
const warnings = [];
const posts = [];

if (!existsSync(POSTS)) {
  console.error('找不到 posts/ 目录');
  process.exit(1);
}

for (const file of (await readdir(POSTS)).filter((f) => f.endsWith('.md')).sort()) {
  const rel = `posts/${file}`;
  const raw = await readFile(path.join(POSTS, file), 'utf8');
  const { data, body } = parseFrontmatter(raw);

  for (const k of ['title', 'slug', 'date', 'status', 'summary']) {
    if (!data[k]) errors.push(`${rel}: 缺少 frontmatter 字段 ${k}`);
  }
  if (data.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) {
    errors.push(`${rel}: slug 只允许小写字母、数字和连字符（例：shuminghao-lide-shijie）`);
  }
  if (data.slug && file !== `${data.slug}.md`) {
    warnings.push(`${rel}: 文件名与 slug（${data.slug}.md）不一致，git 里会多一点认知成本`);
  }
  if (data.status && !['draft', 'published', 'retired'].includes(data.status)) {
    errors.push(`${rel}: status 只能是 draft / published / retired`);
  }
  if (data.lang && !['zh', 'en'].includes(data.lang)) {
    errors.push(`${rel}: lang 只能是 zh（中文，可省略）或 en（英文）`);
  }
  if (data.status === 'published' && data.lang === 'en' && !data.translation_of) {
    warnings.push(`${rel}: 英文文章没有写 translation_of，读者找不到对应的中文版`);
  }
  if (data.tags && !Array.isArray(data.tags)) {
    errors.push(`${rel}: tags 必须写成数组，例：tags: [小说, 阅读史]（只写一个也要方括号）`);
  } else if (Array.isArray(data.tags) && data.tags.some((t) => /[，、；]/.test(t))) {
    errors.push(`${rel}: tags 里出现了全角逗号，YAML 数组的分隔符必须是半角逗号（例：[小说, 阅读史]）`);
  }
  if (data.date && Number.isNaN(Date.parse(data.date))) errors.push(`${rel}: date 无法解析`);
  if (data.updated && Number.isNaN(Date.parse(data.updated))) errors.push(`${rel}: updated 无法解析`);
  if (data.date && data.updated && Date.parse(data.updated) < Date.parse(data.date)) {
    errors.push(`${rel}: updated（${data.updated}）早于 date（${data.date}），检查一下年份有没有写错`);
  }
  if (/^#\s/.test(body.trimStart())) {
    errors.push(`${rel}: 正文不要再写一级标题（#），标题由 frontmatter 的 title 提供，否则页面里会出现两个标题`);
  }
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const src = m[1];
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue;
    const abs = path.resolve(path.dirname(path.join(POSTS, file)), decodeURIComponent(src));
    if (!existsSync(abs)) errors.push(`${rel}: 图片不存在 → ${src}`);
  }
  const words = body.replace(/[\s#>*`\-|]/g, '').length;
  posts.push({ ...data, rel, words, excerpt: data.summary ?? '' });
}

const seen = new Set();
for (const p of posts) {
  if (!p.slug) continue;
  if (seen.has(p.slug)) errors.push(`slug 重复：${p.slug}`);
  seen.add(p.slug);
}
for (const p of posts) {
  if (!p.translation_of) continue;
  if (p.translation_of === p.slug) errors.push(`${p.rel}: translation_of 不能指向自己`);
  else if (!seen.has(p.translation_of)) errors.push(`${p.rel}: translation_of 指向的 ${p.translation_of} 不存在`);
}

if (errors.length) {
  console.error('发现问题：');
  for (const e of errors) console.error('  ✗ ' + e);
}
for (const w of warnings) console.warn('  ! ' + w);

if (errors.length || CHECK_ONLY) {
  if (!errors.length) console.log(`✓ 校验通过，${posts.filter((p) => p.status === 'published').length} 篇已发布`);
  process.exit(errors.length ? 1 : 0);
}

/* ---------- README 目录块 ---------- */

const published = posts.filter((p) => p.status === 'published').sort((a, b) => (a.date < b.date ? 1 : -1));
const draftCount = posts.filter((p) => p.status === 'draft').length;

// 同一册里既有中文又有英文时，目录按语言分节；只有一种语言时不加节标题。
function renderGroup(list) {
  const out = [];
  const byYear = new Map();
  for (const p of list) {
    const y = p.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  for (const [year, items] of [...byYear].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    out.push(`**${year}**`, '');
    for (const p of items) {
      const tags = (p.tags ?? []).map((t) => `\`${t}\``).join(' ');
      out.push(`- ${p.date} · [${p.title}](${p.rel}) — ${p.excerpt}${tags ? ' ' + tags : ''}`);
    }
    out.push('');
  }
  return out;
}

const zhList = published.filter((p) => (p.lang ?? 'zh') === 'zh');
const enList = published.filter((p) => p.lang === 'en');
const lines = [];
if (published.length === 0) {
  lines.push('_还没有文章。_');
} else if (zhList.length && enList.length) {
  lines.push('### 中文', '', ...renderGroup(zhList), '### English', '', ...renderGroup(enList));
} else {
  lines.push(...renderGroup(published));
}
const langNote = zhList.length && enList.length ? `（中文 ${zhList.length} 篇，英文 ${enList.length} 篇）` : '';
const draftNote = draftCount ? `，另有 ${draftCount} 篇在写` : '';
lines.push(`_共 ${published.length} 篇已发布${langNote}${draftNote}。_`);

const readmePath = path.join(ROOT, 'README.md');
let readme = existsSync(readmePath) ? await readFile(readmePath, 'utf8') : `${BEGIN}\n${END}\n`;
if (!readme.includes(BEGIN) || !readme.includes(END)) {
  console.error(`README.md 里找不到 ${BEGIN} / ${END} 标记，拒绝覆盖（手写目录早晚会腐烂，所以目录必须自动生成）`);
  process.exit(1);
}
readme = readme.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), `${BEGIN}\n${lines.join('\n')}\n${END}`);
await writeFile(readmePath, readme);

/* ---------- feed.xml（每刊可独立订阅，这是拆仓的价值之一） ---------- */

const site = meta.site ?? '';
const itemUrl = (p) =>
  site ? `${site.replace(/\/$/, '')}/${p.slug}/` : `https://github.com/${meta.repo}/blob/${meta.branch ?? 'main'}/${p.rel}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const items = published
  .slice(0, 50)
  .map(
    (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(itemUrl(p))}</link>
      <guid isPermaLink="true">${esc(itemUrl(p))}</guid>
      <pubDate>${new Date(p.date).toUTCString()}</pubDate>
      <description>${esc(p.excerpt)}</description>
    </item>`,
  )
  .join('\n');
// lastBuildDate 用最新文章的日期，而不是"现在"。
// 用 new Date() 的话每次构建 feed.xml 都会变，CI 就会产生一个空提交。
const lastBuildLine = published[0]
  ? `    <lastBuildDate>${new Date(published[0].date).toUTCString()}</lastBuildDate>\n`
  : '';
await writeFile(
  path.join(ROOT, 'feed.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(meta.name ?? '文集')}</title>
    <link>${esc(site || `https://github.com/${meta.repo ?? ''}`)}</link>
    <description>${esc(meta.description ?? '')}</description>
    <language>zh-CN</language>
${lastBuildLine}${items}
  </channel>
</rss>
`,
);

console.log(`✓ 已更新 README.md 目录（${published.length} 篇）并生成 feed.xml`);

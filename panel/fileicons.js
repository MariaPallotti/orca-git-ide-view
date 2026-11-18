// File type icons, as code editors show them: a small coloured badge per language, so a
// list of changes can be read at a glance. Pure (no DOM): returns SVG markup.

// [label, background, text colour]. Light backgrounds take dark text.
const DARK = '#1f2328'
const LIGHT = '#ffffff'
const T = {
  ts: ['TS', '#3178c6', LIGHT],
  tsx: ['TSX', '#2f74c0', LIGHT],
  js: ['JS', '#f0db4f', DARK],
  jsx: ['JSX', '#61dafb', DARK],
  json: ['{}', '#e8a23a', DARK],
  css: ['#', '#a86fd8', LIGHT],
  scss: ['S', '#cd6799', LIGHT],
  less: ['L', '#1d365d', LIGHT],
  html: ['<>', '#e44d26', LIGHT],
  xml: ['<>', '#0a6ebd', LIGHT],
  svg: ['SVG', '#ffb13b', DARK],
  md: ['M↓', '#5b7fae', LIGHT],
  txt: ['TXT', '#8b8f98', LIGHT],
  py: ['PY', '#3572a5', LIGHT],
  java: ['J', '#b07219', LIGHT],
  kt: ['K', '#a97bff', LIGHT],
  go: ['GO', '#00add8', DARK],
  rs: ['RS', '#dea584', DARK],
  rb: ['RB', '#cc342d', LIGHT],
  php: ['PHP', '#777bb4', LIGHT],
  cs: ['C#', '#178600', LIGHT],
  c: ['C', '#555d6b', LIGHT],
  cpp: ['C++', '#f34b7d', LIGHT],
  swift: ['SW', '#f05138', LIGHT],
  sql: ['SQL', '#e38c00', DARK],
  sh: ['$', '#4eaa25', LIGHT],
  ps1: ['PS', '#2c6dc4', LIGHT],
  bat: ['BAT', '#c1f12e', DARK],
  yml: ['YML', '#cb171e', LIGHT],
  toml: ['TML', '#9c4221', LIGHT],
  ini: ['INI', '#6d8086', LIGHT],
  env: ['ENV', '#ecd53f', DARK],
  vue: ['V', '#41b883', LIGHT],
  svelte: ['S', '#ff3e00', LIGHT],
  csv: ['CSV', '#237346', LIGHT],
  pdf: ['PDF', '#d32f2f', LIGHT],
  img: ['IMG', '#26a269', LIGHT],
  git: ['GIT', '#f05032', LIGHT],
  docker: ['DK', '#2496ed', LIGHT],
  lock: ['LCK', '#8b8f98', LIGHT],
  idea: ['IJ', '#fe2857', LIGHT],
  test: ['TST', '#c2a633', DARK]
}

const BY_EXT = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', xsd: 'xml', svg: 'svg',
  md: 'md', mdx: 'md', markdown: 'md', txt: 'txt', log: 'txt',
  py: 'py', java: 'java', kt: 'kt', kts: 'kt', go: 'go', rs: 'rs', rb: 'rb', php: 'php', cs: 'cs',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', swift: 'swift', sql: 'sql',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'ps1', psm1: 'ps1', bat: 'bat', cmd: 'bat',
  yml: 'yml', yaml: 'yml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  env: 'env', vue: 'vue', svelte: 'svelte', csv: 'csv', tsv: 'csv', pdf: 'pdf',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', ico: 'img', bmp: 'img', avif: 'img',
  lock: 'lock', iml: 'idea', tsbuildinfo: 'lock'
}

const BY_NAME = {
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git',
  dockerfile: 'docker', '.dockerignore': 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
  'package-lock.json': 'lock', 'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock', 'bun.lockb': 'lock',
  '.env': 'env', makefile: 'sh', '.editorconfig': 'ini', '.npmrc': 'ini', '.prettierrc': 'json', '.eslintrc': 'json'
}

/** The type key of a path ("ts", "json", "test"...), or null for an unknown type. */
export function fileType(p) {
  const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('.env')) return 'env'
  if (name.startsWith('dockerfile')) return 'docker'
  // Tests get their own badge.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return 'test'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXT[name.slice(dot + 1)] ?? null
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// A plain document outline for unknown types, in the theme's muted text colour.
const GENERIC =
  '<svg class="ficon" width="16" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>'

/** SVG markup of the icon for a path. */
export function fileIcon(p) {
  const type = fileType(p)
  const t = type && T[type]
  if (!t) return GENERIC
  const [label, bg, fg] = t
  const size = label.length >= 3 ? 6.2 : 7.6
  return `<svg class="ficon" width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect width="16" height="14" rx="3" fill="${bg}"/><text x="8" y="${label.length >= 3 ? 9.4 : 10}" text-anchor="middle" font-size="${size}" font-weight="700" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" fill="${fg}" letter-spacing="-0.2">${escAttr(label)}</text></svg>`
}

// Rasterises public/logo.svg into the PNG icons the PWA manifest needs.
// Runs automatically before `dev` and `build` (see package.json), and is a
// no-op if the icons already exist (set FORCE_ICONS=1 to regenerate).
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pub = resolve(root, 'public')
const svgPath = resolve(pub, 'logo.svg')

const targets = [
  { name: 'pwa-192x192.png', size: 192 },
  { name: 'pwa-512x512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32x32.png', size: 32 }
]

const allExist = targets.every((t) => existsSync(resolve(pub, t.name)))
if (allExist && !process.env.FORCE_ICONS) {
  console.log('[gen-icons] icons already present — skipping (set FORCE_ICONS=1 to redo)')
  process.exit(0)
}

let sharp
try {
  sharp = (await import('sharp')).default
} catch {
  console.warn('[gen-icons] "sharp" is not installed yet — skipping icon generation.')
  console.warn('[gen-icons] Run `npm install` then `npm run gen-icons`.')
  process.exit(0)
}

mkdirSync(pub, { recursive: true })
const svg = readFileSync(svgPath)
for (const t of targets) {
  await sharp(svg, { density: 384 })
    .resize(t.size, t.size, { fit: 'cover' })
    .png()
    .toFile(resolve(pub, t.name))
  console.log('[gen-icons] wrote', t.name)
}
console.log('[gen-icons] done')

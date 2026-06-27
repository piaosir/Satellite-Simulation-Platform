// Generate a multi-resolution Windows .ico from a square PNG using Electron's nativeImage.
// Run with: electron scripts/make-icon.js
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const SRC = path.resolve(__dirname, '..', 'build', 'icon.png')
const OUT = path.resolve(__dirname, '..', 'build', 'icon.ico')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco(pngs) {
  // pngs: [{ size, buffer }]
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(count, 4)

  const entries = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach((p, i) => {
    const e = 16 * i
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0) // width
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1) // height
    entries.writeUInt8(0, e + 2)  // color count
    entries.writeUInt8(0, e + 3)  // reserved
    entries.writeUInt16LE(1, e + 4)   // planes
    entries.writeUInt16LE(32, e + 6)  // bit count
    entries.writeUInt32LE(p.buffer.length, e + 8)  // bytes in resource
    entries.writeUInt32LE(offset, e + 12)          // image offset
    offset += p.buffer.length
  })

  return Buffer.concat([header, entries, ...pngs.map(p => p.buffer)])
}

function run() {
  const base = nativeImage.createFromPath(SRC)
  if (base.isEmpty()) {
    console.error('Source PNG is empty/unreadable:', SRC)
    process.exit(1)
  }
  const pngs = SIZES.map(size => ({
    size,
    buffer: base.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  fs.writeFileSync(OUT, buildIco(pngs))
  console.log('Wrote', OUT, 'sizes:', SIZES.join(','))
}

if (app) {
  app.whenReady().then(() => { run(); app.quit() })
  app.on('window-all-closed', () => app.quit())
} else {
  run()
}

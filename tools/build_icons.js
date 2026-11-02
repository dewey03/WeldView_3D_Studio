#!/usr/bin/env node
/**
 * WeldView 3D V2.2 — Icon Builder (sharp + 7-layer ICO container)
 * Usage: node build_icons.js
 * Rule: 16/24/32px use weldview_icon_{A,B,C}_small.svg; 48..1024px use weldview_icon_{A,B,C}.svg.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SCHEMES = ['A', 'B', 'C'];
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 192, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function packIco(buffersBySize) {
  const count = ICO_SIZES.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const dirs = [];
  const datas = [];
  for (const sz of ICO_SIZES) {
    const buf = buffersBySize[sz];
    const dir = Buffer.alloc(16);
    dir.writeUInt8(sz === 256 ? 0 : sz, 0);
    dir.writeUInt8(sz === 256 ? 0 : sz, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(buf.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirs.push(dir);
    datas.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...dirs, ...datas]);
}

async function main() {
  const outPngDir = path.join(__dirname, 'png');
  if (!fs.existsSync(outPngDir)) fs.mkdirSync(outPngDir, { recursive: true });

  for (const s of SCHEMES) {
    const fullSvg = path.join(__dirname, `weldview_icon_${s}.svg`);
    const smallSvg = path.join(__dirname, `weldview_icon_${s}_small.svg`);
    const bySize = {};
    for (const sz of PNG_SIZES) {
      const src = sz <= 32 ? smallSvg : fullSvg;
      const buf = await sharp(src).resize(sz, sz).png().toBuffer();
      fs.writeFileSync(path.join(outPngDir, `${s}_${sz}.png`), buf);
      if (ICO_SIZES.includes(sz)) bySize[sz] = buf;
    }
    const icoBuf = packIco(bySize);
    fs.writeFileSync(path.join(__dirname, `weldview_${s}.ico`), icoBuf);
    if (s === 'C') {
      fs.writeFileSync(path.join(__dirname, 'weldview.ico'), icoBuf);
    }
  }
  console.log('[OK] Generated weldview_{A,B,C}.ico, weldview.ico, and png/*');
}

main().catch(err => { console.error(err); process.exit(1); });

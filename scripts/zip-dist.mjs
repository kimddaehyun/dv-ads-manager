import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const outDir = join(root, "dist-zip");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outFile = join(outDir, `DV-Ads-Manager v${pkg.version}.zip`);

if (!existsSync(distDir)) {
  console.error("dist/ not found. Run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const files = [];
walk(distDir, files);

const localHeaders = [];
const centralDirectory = [];
let offset = 0;
const chunks = [];

for (const abs of files) {
  const rel = relative(distDir, abs).split(sep).join("/");
  const data = readFileSync(abs);
  const compressed = deflateRawSync(data);
  const crc = crc32(data);

  const nameBuf = Buffer.from(rel, "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  chunks.push(localHeader, nameBuf, compressed);
  localHeaders.push({ offset, rel: nameBuf, crc, compressedSize: compressed.length, size: data.length });
  offset += localHeader.length + nameBuf.length + compressed.length;
}

let centralSize = 0;
for (const h of localHeaders) {
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(h.crc, 16);
  central.writeUInt32LE(h.compressedSize, 20);
  central.writeUInt32LE(h.size, 24);
  central.writeUInt16LE(h.rel.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(h.offset, 42);
  centralDirectory.push(central, h.rel);
  centralSize += central.length + h.rel.length;
}

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(localHeaders.length, 8);
eocd.writeUInt16LE(localHeaders.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const stream = createWriteStream(outFile);
for (const c of chunks) stream.write(c);
for (const c of centralDirectory) stream.write(c);
stream.write(eocd);
stream.end(() => {
  const sizeKb = (statSync(outFile).size / 1024).toFixed(1);
  console.log(`✓ ${relative(root, outFile)} (${sizeKb} KB, ${files.length} files)`);
});

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

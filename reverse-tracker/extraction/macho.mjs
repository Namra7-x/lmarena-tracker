/**
 * Mach-O Binary String & Metadata Section Extractor
 * Parses 64-bit / 32-bit and Universal (Fat) Mach-O headers in pure JavaScript
 * to isolate string/data sections (__cstring, __const, __objc_methname,
 * __objc_classname, __ustring, __cfstring) instead of scanning raw ARM64/x86_64
 * machine instructions as printable ASCII bytes.
 */

import { isMachOBinary, MACHO_MAGICS } from './archive.mjs';

const TARGET_STRING_SECTIONS = new Set([
  '__cstring',
  '__const',
  '__cfstring',
  '__objc_methname',
  '__objc_classname',
  '__objc_methtype',
  '__ustring',
  '__oslogstring',
  '__rodata',
  '__rdata',
]);

function readCString16(buf, offset) {
  let end = offset;
  const max = Math.min(offset + 16, buf.length);
  while (end < max && buf[end] !== 0) end++;
  return buf.subarray(offset, end).toString('ascii');
}

function parseSingleMachOSlices(sliceBuf, baseOffset = 0) {
  if (!sliceBuf || sliceBuf.length < 32) return [];
  const magicLE = sliceBuf.readUInt32LE(0);
  const magicBE = sliceBuf.readUInt32BE(0);

  let is64 = false;
  let littleEndian = true;
  // Standard little-endian ARM64/x86_64 Mach-O has 0xfeedfacf when read LE (bytes: cf fa ed fe)
  // Big-endian PPC Mach-O has 0xfeedfacf when read BE (bytes: fe ed fa cf)
  if (magicLE === MACHO_MAGICS.MACHO_64_BE || magicBE === MACHO_MAGICS.MACHO_64_LE) {
    is64 = true;
    littleEndian = true;
  } else if (magicBE === MACHO_MAGICS.MACHO_64_BE) {
    is64 = true;
    littleEndian = false;
  } else if (magicLE === MACHO_MAGICS.MACHO_32_BE || magicBE === MACHO_MAGICS.MACHO_32_LE) {
    is64 = false;
    littleEndian = true;
  } else if (magicBE === MACHO_MAGICS.MACHO_32_BE) {
    is64 = false;
    littleEndian = false;
  } else {
    return [];
  }

  const read32 = (off) => (littleEndian ? sliceBuf.readUInt32LE(off) : sliceBuf.readUInt32BE(off));
  const read64 = (off) => {
    const val = littleEndian ? sliceBuf.readBigUInt64LE(off) : sliceBuf.readBigUInt64BE(off);
    return Number(val);
  };

  const ncmds = read32(16);
  const sizeofcmds = read32(20);
  const headerSize = is64 ? 32 : 28;
  if (ncmds === 0 || ncmds > 512 || headerSize + sizeofcmds > sliceBuf.length) {
    return [];
  }

  const LC_SEGMENT = 0x1;
  const LC_SEGMENT_64 = 0x19;
  const slices = [];
  let offset = headerSize;

  for (let i = 0; i < ncmds && offset + 8 <= sliceBuf.length; i++) {
    const cmd = read32(offset);
    const cmdsize = read32(offset + 4);
    if (cmdsize < 8 || offset + cmdsize > sliceBuf.length) break;

    if ((cmd === LC_SEGMENT_64 && offset + 72 <= sliceBuf.length) || (cmd === LC_SEGMENT && offset + 56 <= sliceBuf.length)) {
      const segIs64 = cmd === LC_SEGMENT_64;
      const nsectsOffset = segIs64 ? offset + 64 : offset + 48;
      const nsects = read32(nsectsOffset);
      const sectSize = segIs64 ? 80 : 68;
      let sectOffset = offset + (segIs64 ? 72 : 56);

      for (let s = 0; s < nsects && sectOffset + sectSize <= offset + cmdsize; s++) {
        const sectName = readCString16(sliceBuf, sectOffset);
        const segName = readCString16(sliceBuf, sectOffset + 16);
        const fileOff = segIs64 ? read32(sectOffset + 48) : read32(sectOffset + 40);
        const size = segIs64 ? read64(sectOffset + 40) : read32(sectOffset + 36);

        const looksLikeStringSection =
          TARGET_STRING_SECTIONS.has(sectName) ||
          (segName === '__DATA_CONST' && sectName === '__const') ||
          sectName.includes('string');

        if (looksLikeStringSection && size > 0 && fileOff > 0 && fileOff + size <= sliceBuf.length) {
          slices.push({
            section: `${segName},${sectName}`,
            offset: baseOffset + fileOff,
            buffer: sliceBuf.subarray(fileOff, fileOff + size),
          });
        }
        sectOffset += sectSize;
      }
    }

    offset += cmdsize;
  }

  return slices;
}

/**
 * Extract safe string/data sections from a Mach-O or Fat/Universal Mach-O binary.
 * Returns [] if not a valid Mach-O or if no dedicated sections exist (caller falls back to full scan).
 */
export function extractMachOStringSlices(buffer) {
  if (!buffer || buffer.length < 32 || !isMachOBinary(buffer)) return [];

  try {
    const magicBE = buffer.readUInt32BE(0);
    if (magicBE === MACHO_MAGICS.FAT_32_BE || magicBE === MACHO_MAGICS.FAT_64_BE) {
      const isFat64 = magicBE === MACHO_MAGICS.FAT_64_BE;
      const nfat = buffer.readUInt32BE(4);
      if (nfat === 0 || nfat > 16) return [];

      const archEntries = [];
      let entryOff = 8;
      const entrySize = isFat64 ? 32 : 20;
      for (let i = 0; i < nfat && entryOff + entrySize <= buffer.length; i++) {
        const cputype = buffer.readUInt32BE(entryOff);
        const fileOff = isFat64 ? Number(buffer.readBigUInt64BE(entryOff + 8)) : buffer.readUInt32BE(entryOff + 8);
        const size = isFat64 ? Number(buffer.readBigUInt64BE(entryOff + 16)) : buffer.readUInt32BE(entryOff + 12);
        if (fileOff > 0 && size > 0 && fileOff + size <= buffer.length) {
          archEntries.push({ cputype, fileOff, size });
        }
        entryOff += entrySize;
      }

      // Prefer ARM64 (0x0100000c) slice first to avoid scanning duplicate x86_64 mirror strings
      const arm64Slice = archEntries.find((a) => a.cputype === 0x0100000c);
      const targets = arm64Slice ? [arm64Slice] : archEntries.slice(0, 1);

      const results = [];
      for (const arch of targets) {
        results.push(...parseSingleMachOSlices(buffer.subarray(arch.fileOff, arch.fileOff + arch.size), arch.fileOff));
      }
      return results;
    }

    return parseSingleMachOSlices(buffer, 0);
  } catch {
    return [];
  }
}

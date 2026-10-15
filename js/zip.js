/* Drawimate — minimal ZIP writer (STORE, no compression; PNGs are already
 * compressed). Produces a standard archive readable by any unzip tool. */
(function (global) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  class ZipWriter {
    constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }

    add(name, data) {
      const nameBytes = new TextEncoder().encode(name);
      const crc = crc32(data), size = data.length;
      const { time, date } = dosDateTime(new Date());

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);   // local file header signature
      lh.setUint16(4, 20, true);           // version needed
      lh.setUint16(6, 0x0800, true);       // flags: UTF-8 names
      lh.setUint16(8, 0, true);            // method: store
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);        // compressed size
      lh.setUint32(22, size, true);        // uncompressed size
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);           // extra length
      this.parts.push(lh.buffer, nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);   // central directory signature
      ch.setUint16(4, 20, true);           // version made by
      ch.setUint16(6, 20, true);           // version needed
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true);
      // extra len, comment len, disk no., internal attrs = 0; external attrs = 0
      ch.setUint32(42, this.offset, true); // offset of local header
      this.central.push(ch.buffer, nameBytes);

      this.offset += 30 + nameBytes.length + size;
      this.count++;
    }

    finish() {
      let cdSize = 0;
      for (const p of this.central) cdSize += p.byteLength;
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);  // end of central directory
      end.setUint16(8, this.count, true);
      end.setUint16(10, this.count, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
    }
  }

  global.DMZip = { ZipWriter, crc32 };
})(window);

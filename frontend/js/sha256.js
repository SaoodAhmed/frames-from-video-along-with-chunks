/* Streaming SHA-256 for upload dedup. Web Crypto's subtle.digest cannot be
   updated incrementally, so this is a compact incremental SHA-256 that reads
   the File in ~1MB chunks — never loading a large file fully into memory. */
window.SHA256 = (() => {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  class Hasher {
    constructor() {
      this.h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      this.buf = new Uint8Array(64);
      this.bufLen = 0;
      this.len = 0;
    }
    update(bytes) {
      const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.len += input.length;
      let i = 0;
      if (this.bufLen) {
        const take = Math.min(64 - this.bufLen, input.length);
        this.buf.set(input.subarray(0, take), this.bufLen);
        this.bufLen += take;
        i = take;
        if (this.bufLen === 64) { this._block(this.buf); this.bufLen = 0; }
      }
      for (; i + 64 <= input.length; i += 64) this._block(input.subarray(i, i + 64));
      if (i < input.length) {
        this.buf.set(input.subarray(i));
        this.bufLen = input.length - i;
      }
      return this;
    }
    _block(m) {
      const w = new Int32Array(64);
      for (let i = 0; i < 16; i++) {
        w[i] = (m[i * 4] << 24) | (m[i * 4 + 1] << 16) | (m[i * 4 + 2] << 8) | m[i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
      let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + b) | 0;
      this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + d) | 0;
      this.h[4] = (this.h[4] + e) | 0; this.h[5] = (this.h[5] + f) | 0;
      this.h[6] = (this.h[6] + g) | 0; this.h[7] = (this.h[7] + h) | 0;
    }
    digestHex() {
      const l = this.len;
      const k = (56 - ((l + 1) % 64) + 64) % 64;
      const tail = new Uint8Array(1 + k + 8);
      tail[0] = 0x80;
      const bits = l * 8;
      const dv = new DataView(tail.buffer);
      dv.setUint32(1 + k, Math.floor(bits / 0x100000000), false);
      dv.setUint32(1 + k + 4, bits >>> 0, false);
      this.update(tail);
      let out = "";
      for (const x of this.h) out += (x >>> 0).toString(16).padStart(8, "0");
      return out;
    }
  }

  /** Hash a File (or Blob) in ~1MB chunks. onProgress(0..1). Returns hex. */
  async function hashFile(file, onProgress) {
    const h = new Hasher();
    const reader = file.stream().getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      h.update(value);
      total += value.length;
      if (onProgress) onProgress(total / file.size);
    }
    return h.digestHex();
  }

  return { hashFile };
})();

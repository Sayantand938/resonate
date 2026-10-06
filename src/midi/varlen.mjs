// src/midi/varlen.mjs
// MIDI variable-length quantities.
//
// Delta-times (and a few meta lengths) are stored big-endian, 7 bits per
// byte, with the high bit set on every byte except the last.

/**
 * Decode a variable-length quantity starting at `p`.
 *
 * @returns {{value:number, next:number}} `next` is the offset just past it.
 */
export function readVarLen(buffer, p) {
    let value = 0, b;
    do {
        b = buffer[p++];
        value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return { value, next: p };
}

/** Encode a non-negative integer as a variable-length quantity. */
export function encodeVarLen(n) {
    if (n < 0) n = 0;
    const out = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
        out.unshift((n & 0x7f) | 0x80);
        n >>= 7;
    }
    return Buffer.from(out);
}

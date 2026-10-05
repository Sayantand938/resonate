// inspect-midi.mjs — deep inspection of a MIDI file.
// Usage: node inspect-midi.mjs <path-to.mid>

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
    console.error('Usage: node inspect-midi.mjs <path-to.mid>');
    process.exit(1);
}

const buf = fs.readFileSync(path);

// --- Header ---------------------------------------------------------
console.log('=== HEADER ===');
console.log('  magic:      ', buf.toString('ascii', 0, 4));
const format = buf.readUInt16BE(8);
const nTracks = buf.readUInt16BE(10);
const division = buf.readUInt16BE(12);
console.log('  format:     ', format, '(0=single track, 1=multi-track)');
console.log('  tracks:     ', nTracks);
console.log('  division:   ', division, 'ticks/quarter');
console.log('  file size:  ', buf.length, 'bytes');
console.log('');

// --- Walk tracks ----------------------------------------------------
let pos = 14;
let trackNum = 0;

while (pos + 8 <= buf.length) {
    if (buf.toString('ascii', pos, pos + 4) !== 'MTrk') break;
    const len = buf.readUInt32BE(pos + 4);
    const start = pos + 8;
    const end = start + len;

    console.log(`=== TRACK ${trackNum} (${len} bytes) ===`);

    const stats = {
        notes: 0,
        noteOns: 0,
        noteOffs: 0,
        programChanges: [],
        channels: new Set(),
        firstProgram: null,
        name: null,
        tempo: null,
        timeSig: null,
        keySig: null,
    };

    let p = start;
    let absTick = 0;

    while (p < end) {
        // Variable-length delta time
        let delta = 0, b;
        do { b = buf[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
        absTick += delta;

        const status = buf[p];

        // Meta event
        if (status === 0xFF) {
            const type = buf[p + 1];
            const metaLen = buf[p + 2];
            const data = buf.subarray(p + 3, p + 3 + metaLen);
            p += 3 + metaLen;

            switch (type) {
                case 0x03: stats.name = data.toString('utf8'); break;
                case 0x51: {
                    const us = data.readUIntBE(0, 3);
                    stats.tempo = Math.round(60000000 / us);
                    break;
                }
                case 0x58: stats.timeSig = `${data[0]}/${Math.pow(2, data[1])}`; break;
                case 0x59: stats.keySig = `${data[0]} sharps/flats, ${data[1]} major/minor`; break;
            }
            continue;
        }

        // SysEx
        if (status === 0xF0 || status === 0xF7) {
            const sysexLen = buf[p + 1];
            p += 2 + sysexLen;
            continue;
        }

        const type = status & 0xF0;
        const ch = status & 0x0F;
        stats.channels.add(ch);

        if (type === 0x90) {           // note on
            const vel = buf[p + 2];
            if (vel > 0) stats.noteOns++;
            stats.notes++;
            p += 3;
        } else if (type === 0x80) {    // note off
            stats.noteOffs++;
            p += 3;
        } else if (type === 0xC0) {    // program change
            const prog = buf[p + 1];
            if (stats.firstProgram == null) {
                stats.firstProgram = { ch, prog, tick: absTick };
            }
            stats.programChanges.push({ ch, prog, tick: absTick });
            p += 2;
        } else if (type === 0xB0) {    // control change
            p += 3;
        } else if (type === 0xE0) {    // pitch bend
            p += 3;
        } else if (type === 0xA0) {    // aftertouch
            p += 3;
        } else if (type === 0xD0) {    // channel pressure
            p += 2;
        } else {
            // Unknown — bail
            break;
        }
    }

    console.log('  name:          ', JSON.stringify(stats.name));
    console.log('  tempo (BPM):   ', stats.tempo);
    console.log('  time sig:      ', stats.timeSig);
    console.log('  key sig:       ', stats.keySig);
    console.log('  channels used: ', [...stats.channels].sort().join(', '));
    console.log('  note-ons:      ', stats.noteOns);
    console.log('  note-offs:     ', stats.noteOffs);
    if (stats.programChanges.length > 0) {
        console.log('  program changes:');
        for (const pc of stats.programChanges) {
            console.log(`     tick ${String(pc.tick).padStart(6)}  ch ${pc.ch}  → program ${pc.prog}`);
        }
    } else {
        console.log('  program changes: none');
    }
    console.log('');

    pos = end;
    trackNum++;
}

console.log('=== SUMMARY ===');
console.log(`Scanned ${trackNum} track(s).`);
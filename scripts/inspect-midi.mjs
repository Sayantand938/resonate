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
const headerLen = buf.readUInt32BE(4);
console.log('  format:     ', format, '(0=single track, 1=multi-track)');
console.log('  tracks:     ', nTracks);
console.log('  division:   ', division, 'ticks/quarter');
console.log('  file size:  ', buf.length, 'bytes');
console.log('');

// --- Walk tracks ----------------------------------------------------
let pos = 8 + headerLen;
let trackNum = 0;

const trackInfo = [];

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
        lastNoteTick: 0,
        firstNoteTick: null,
    };

    let p = start;
    let absTick = 0;

    while (p < end) {
        let delta = 0, b;
        do { b = buf[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
        absTick += delta;

        const status = buf[p];

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
                case 0x59: {
                    const n = data[0] > 127 ? data[0] - 256 : data[0];
                    stats.keySig = `${n} sharps/flats, ${data[1]} major/minor`;
                    break;
                }
            }
            continue;
        }

        if (status === 0xF0 || status === 0xF7) {
            const sysexLen = buf[p + 1];
            p += 2 + sysexLen;
            continue;
        }

        const type = status & 0xF0;
        const ch = status & 0x0F;
        stats.channels.add(ch);

        if (type === 0x90) {
            const vel = buf[p + 2];
            if (vel > 0) {
                stats.noteOns++;
                stats.lastNoteTick = absTick;
                if (stats.firstNoteTick == null) stats.firstNoteTick = absTick;
            }
            stats.notes++;
            p += 3;
        } else if (type === 0x80) {
            stats.noteOffs++;
            p += 3;
        } else if (type === 0xC0) {
            const prog = buf[p + 1];
            if (stats.firstProgram == null) {
                stats.firstProgram = { ch, prog, tick: absTick };
            }
            stats.programChanges.push({ ch, prog, tick: absTick });
            p += 2;
        } else if (type === 0xB0 || type === 0xE0 || type === 0xA0) {
            p += 3;
        } else if (type === 0xD0) {
            p += 2;
        } else {
            break;
        }
    }

    const channelList = [...stats.channels].sort((a, b) => a - b);
    console.log('  name:          ', JSON.stringify(stats.name));
    console.log('  tempo (BPM):   ', stats.tempo);
    console.log('  time sig:      ', stats.timeSig);
    console.log('  key sig:       ', stats.keySig);
    console.log('  channels used: ', channelList.join(', '));
    console.log('  note-ons:      ', stats.noteOns);
    console.log('  note-offs:     ', stats.noteOffs);
    console.log('  first note tick:', stats.firstNoteTick ?? '—');
    console.log('  last note tick:', stats.lastNoteTick);
    if (stats.programChanges.length > 0) {
        console.log('  program changes:');
        for (const pc of stats.programChanges) {
            console.log(`     tick ${String(pc.tick).padStart(6)}  ch ${pc.ch}  → program ${pc.prog}`);
        }
    } else {
        console.log('  program changes: none');
    }
    console.log('');

    trackInfo.push({
        track: trackNum,
        channels: channelList,
        firstNoteTick: stats.firstNoteTick,
        lastNoteTick: stats.lastNoteTick,
        noteOns: stats.noteOns,
    });

    pos = end;
    trackNum++;
}

// --- Summary --------------------------------------------------------
console.log('=== SUMMARY ===');
console.log(`Scanned ${trackNum} track(s).`);

// Split melodic tracks into "single-channel" (melody voices) and
// "multi-channel" (abcjs's chord-following accompaniment). Only
// single-channel tracks are compared for drift — accompaniment runs
// on its own schedule and will always extend past the melody.
const melodic = trackInfo.filter((t) => t.track > 0 && t.noteOns > 0);
const single = melodic.filter((t) => t.channels.length === 1);
const multi = melodic.filter((t) => t.channels.length > 1);

const beats = (ticks) => ticks / division;

if (single.length > 0) {
    console.log('');
    console.log('Melody voices (single channel):');
    for (const t of single) {
        const endBeats = beats(t.lastNoteTick).toFixed(2);
        console.log(
            `  #${t.track}  ch ${t.channels[0]}  ${t.noteOns} notes  ` +
            `first ${t.firstNoteTick ?? '—'}  last ${t.lastNoteTick}  (${endBeats} beats)`
        );
    }

    if (single.length > 1) {
        const lastTicks = single.map((t) => t.lastNoteTick);
        const firstTicks = single.map((t) => t.firstNoteTick ?? 0);

        const lastDrift = Math.max(...lastTicks) - Math.min(...lastTicks);
        const firstDrift = Math.max(...firstTicks) - Math.min(...firstTicks);

        console.log('');
        console.log(`  end drift:   ${lastDrift} ticks (${beats(lastDrift).toFixed(2)} beats)`);
        console.log(`  start drift: ${firstDrift} ticks (${beats(firstDrift).toFixed(2)} beats)`);

        if (beats(lastDrift) >= 1) {
            console.log(`  ⚠  end drift ≥ 1 beat — melody voices have different total lengths.`);
        }
    }
}

if (multi.length > 0) {
    console.log('');
    console.log('Accompaniment (multi-channel):');
    for (const t of multi) {
        const endBeats = beats(t.lastNoteTick).toFixed(2);
        console.log(
            `  #${t.track}  ch ${t.channels.join(',')}  ${t.noteOns} notes  ` +
            `last ${t.lastNoteTick}  (${endBeats} beats)`
        );
    }
}

if (melodic.length === 0) {
    console.log('');
    console.log('No melodic tracks with note-ons found.');
}
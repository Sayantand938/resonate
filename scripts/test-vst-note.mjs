// scripts/test-vst-note.mjs — one-note VST3 test, bus-aware.
// Usage: node scripts/test-vst-note.mjs "<path.vst3>"

import fs from 'node:fs';

const nvst3 = await import('nvst3-host');
const { Host, MidiEventType, MediaType, BusDirection, SpeakerArrangement } =
    nvst3.default ?? nvst3;

const vstPath = process.argv[2];
if (!vstPath) {
    console.error('Usage: node scripts/test-vst-note.mjs "<path.vst3>"');
    process.exit(1);
}

const host = new Host({ sampleRate: 44100, maxBlockSize: 512 });
const plugin = host.load(vstPath);
const info = plugin.getInfo();
console.error(`Loaded: ${info.name} — ${info.numAudioInputs} in / ${info.numAudioOutputs} out`);

const audioInBuses = plugin.getBusList(MediaType.Audio, BusDirection.Input);
const audioOutBuses = plugin.getBusList(MediaType.Audio, BusDirection.Output);
console.error(`Audio buses: ${audioInBuses.length} in, ${audioOutBuses.length} out`);

// Try to negotiate a stereo-only arrangement before activation.
try {
    const ok = plugin.setBusArrangement([], [SpeakerArrangement.Stereo]);
    console.error(`setBusArrangement (1 stereo out) returned: ${ok}`);
} catch (err) {
    console.error(`setBusArrangement threw: ${err.message}`);
}

plugin.setActive(true);
plugin.setProcessing(true);
console.error('Plugin activated + processing.');

const blockSize = 512;
const totalSamples = 44100 * 3;
const blocks = Math.ceil(totalSamples / blockSize);

// Re-query buses after activation in case setBusArrangement changed them.
const outBusesAfter = plugin.getBusList(MediaType.Audio, BusDirection.Output);
console.error(`After activation: ${outBusesAfter.length} output buses`);

const inputBuffers = audioInBuses.map((b) =>
    Array.from({ length: b.channelCount }, () => new Float32Array(blockSize))
);
const outputBuffers = outBusesAfter.map((b) =>
    Array.from({ length: b.channelCount }, () => new Float32Array(blockSize))
);

console.error(`Buffers: ${inputBuffers.length} in buses, ${outputBuffers.length} out buses.`);

const outL = new Float32Array(totalSamples);
const outR = new Float32Array(totalSamples);

const peakPerBus = outBusesAfter.map(() => 0);
let globalPeak = 0;

for (let i = 0; i < blocks; i++) {
    inputBuffers.forEach((bus) => bus.forEach((ch) => ch.fill(0)));
    outputBuffers.forEach((bus) => bus.forEach((ch) => ch.fill(0)));

    if (i === 0) {
        plugin.addMidiEvent({
            type: MidiEventType.NoteOn,
            channel: 0,
            note: 60,
            velocity: 1.0,
            sampleOffset: 0,
        });
    }
    if (i === 20) {
        plugin.addMidiEvent({
            type: MidiEventType.NoteOff,
            channel: 0,
            note: 60,
            velocity: 0,
            sampleOffset: 0,
        });
    }

    let result;
    try {
        result = plugin.process({
            inputs: inputBuffers,
            outputs: outputBuffers,
            numSamples: blockSize,
        });
    } catch (err) {
        console.error(`process() threw on block ${i}: ${err.message} code=${err.code}`);
        process.exit(1);
    }

    for (let b = 0; b < outputBuffers.length; b++) {
        const bus = outputBuffers[b];
        for (let ch = 0; ch < bus.length; ch++) {
            const arr = bus[ch];
            for (let s = 0; s < blockSize; s++) {
                const v = Math.abs(arr[s]);
                if (v > peakPerBus[b]) peakPerBus[b] = v;
                if (v > globalPeak) globalPeak = v;
            }
        }
    }

    // Write bus 0 (capped at remaining samples)
    const n = Math.min(blockSize, totalSamples - i * blockSize);
    if (outputBuffers.length > 0 && outputBuffers[0].length >= 2) {
        outL.set(outputBuffers[0][0].subarray(0, n), i * blockSize);
        outR.set(outputBuffers[0][1].subarray(0, n), i * blockSize);
    }
}

plugin.dispose();

console.error('');
console.error('=== PEAK PER BUS ===');
peakPerBus.forEach((p, i) => {
    if (p > 0) console.error(`  bus ${i}: ${p.toFixed(6)}`);
});
if (globalPeak === 0) console.error('  (all buses silent)');
console.error(`Overall peak: ${globalPeak.toFixed(6)}`);

// Write WAV
const numFrames = outL.length;
const buf = Buffer.alloc(44 + numFrames * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + numFrames * 4, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(44100, 24);
buf.writeUInt32LE(44100 * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(numFrames * 4, 40);
for (let i = 0; i < numFrames; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outL[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outR[i])) * 32767), 44 + i * 4 + 2);
}
fs.writeFileSync('test-note.wav', buf);
console.error('Wrote test-note.wav');
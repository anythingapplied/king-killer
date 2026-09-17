// Synthesizes a short bell chime with the Web Audio API so no audio asset has
// to be bundled. The context is created lazily (browsers suspend it until the
// first user gesture, so the first chime after an interaction just resumes it).
let context: AudioContext | null = null;

const getContext = (): AudioContext | null => {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
    if (!context) context = new AudioContext();
    if (context.state === 'suspended') void context.resume();
    return context;
};

export const playBellChime = () => {
    const ac = getContext();
    if (!ac) return;
    const now = ac.currentTime;

    const master = ac.createGain();
    // exponentialRampToValueAtTime cannot target 0, so fade to near-silence.
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.4, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);
    master.connect(ac.destination);

    // A bell is inharmonic: the partials sit at non-integer multiples of the
    // fundamental, and the higher ones ring down faster than the fundamental.
    const baseFreq = 660; // E5
    const partials = [
        { ratio: 1, gain: 0.8, decay: 2.8 },
        { ratio: 2.0, gain: 0.4, decay: 1.6 },
        { ratio: 2.76, gain: 0.2, decay: 1.1 },
        { ratio: 5.4, gain: 0.1, decay: 0.65 },
    ];

    for (const p of partials) {
        const osc = ac.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = baseFreq * p.ratio;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(p.gain, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + p.decay + 0.05);
    }
};
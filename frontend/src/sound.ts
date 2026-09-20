// Synthesizes a short bell chime with the Web Audio API so no audio asset has
// to be bundled.
//
// Browsers only let audio start from a user gesture. Two consequences drive the
// shape of this module:
//
//  1. A context created outside a gesture starts `suspended`, and on iOS it
//     stays that way however many times `resume()` is called later. So the
//     context is created during the first real interaction with the page
//     (`installAudioUnlock`), not on the first chime — the turn chime is rung
//     from a state update, which is never a gesture.
//  2. A suspended context has a frozen clock. Scheduling an envelope against
//     `currentTime` while suspended puts the whole thing in the past by the
//     time playback resumes, so the chime is silently swallowed. Playback
//     therefore resumes first and only schedules once the context is running.
let context: AudioContext | null = null;

const MUTE_KEY = 'kingkiller_muted';

// localStorage throws in some private-browsing modes, so every access is
// guarded and simply falls back to "not muted".
const readMuted = (): boolean => {
    try {
        return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
        return false;
    }
};

let muted = readMuted();

export const isMuted = (): boolean => muted;

export const setMuted = (value: boolean): void => {
    muted = value;
    try {
        localStorage.setItem(MUTE_KEY, value ? '1' : '0');
    } catch { /* not persisted this session */ }
};

const getContext = (): AudioContext | null => {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
    if (!context) {
        try {
            context = new AudioContext();
        } catch {
            return null;
        }
    }
    return context;
};

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

/**
 * Arms audio on the first interaction with the page, so later chimes (which
 * fire from state updates) actually sound. Returns a teardown function.
 */
export const installAudioUnlock = (): (() => void) => {
    if (typeof window === 'undefined') return () => {};

    const teardown = () => {
        for (const event of UNLOCK_EVENTS) window.removeEventListener(event, unlock);
    };

    const unlock = () => {
        teardown();
        const ac = getContext();
        if (ac && ac.state !== 'running') void ac.resume().catch(() => {});
    };

    for (const event of UNLOCK_EVENTS) {
        window.addEventListener(event, unlock, { passive: true });
    }
    return teardown;
};

const ring = (ac: AudioContext) => {
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

export const playBellChime = () => {
    if (muted) return;
    const ac = getContext();
    if (!ac) return;
    if (ac.state === 'running') {
        ring(ac);
        return;
    }
    // Resume before scheduling, or the envelope lands entirely in the past.
    void ac.resume().then(() => {
        if (ac.state === 'running') ring(ac);
    }).catch(() => {});
};

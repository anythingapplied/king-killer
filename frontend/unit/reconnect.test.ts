import { describe, it, expect } from 'vitest';
import { decideBufferedActionsToReplay } from '../src/reconnectLogic';
import type { GameAction } from '../src/types';

const actions: GameAction[] = [
    { type: 'PlayCards', payload: { indices: [0, 2] } },
    { type: 'Yield' },
];

const stateJson = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({ players: [], current_player_index: 0, ...patch });

describe('decideBufferedActionsToReplay', () => {
    it('replays the buffer when the server reports the same state (asleep)', () => {
        const json = stateJson();
        expect(decideBufferedActionsToReplay(actions, json, json)).toEqual(actions);
    });

    it('discards the buffer when the state advanced while disconnected', () => {
        const lastSeen = stateJson({ current_player_index: 0 });
        const advanced = stateJson({ current_player_index: 1 });
        expect(decideBufferedActionsToReplay(actions, advanced, lastSeen)).toEqual([]);
    });

    it('discards the buffer when we never had a previous state', () => {
        expect(decideBufferedActionsToReplay(actions, stateJson(), null)).toEqual([]);
    });

    it('returns nothing when the buffer is empty', () => {
        expect(decideBufferedActionsToReplay([], stateJson(), stateJson())).toEqual([]);
    });

    it('does not replay a partial buffer even if only field ordering differs', () => {
        // JSON serialization order is stable for the same object, but a truly
        // different value must never be treated as equal.
        const a = JSON.stringify({ a: 1, b: 2 });
        const b = JSON.stringify({ b: 2, a: 1 });
        expect(decideBufferedActionsToReplay(actions, a, b)).toEqual([]);
    });
});
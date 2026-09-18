import type { ChatMessage } from './types';

/**
 * Number of messages newer than the last one the user saw.
 *
 * Counts by timestamp rather than by length: the server caps history at 100
 * messages, so once that cap is reached `chat.length` stops growing and a
 * count-based badge would freeze and never report another unread message.
 */
export function unreadCount(chat: Pick<ChatMessage, 'at'>[], seenAt: number): number {
    return chat.reduce((n, m) => (m.at > seenAt ? n + 1 : n), 0);
}

/** Newest timestamp in `chat`, or `seenAt` if there's nothing newer. */
export function newestSeen(chat: Pick<ChatMessage, 'at'>[], seenAt: number): number {
    return chat.reduce((max, m) => Math.max(max, m.at), seenAt);
}

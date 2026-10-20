/**
 * The shape of a card id wherever an id NAMES something on disk or in the runner — its history, its
 * markers, its uploads, its token file. Card ids are UUIDs minted by the registry; anything not
 * plainly id-shaped is refused rather than resolved, so no path from a request ever touches the fs.
 * One rule, here, instead of a copy per module that could drift.
 */
export const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

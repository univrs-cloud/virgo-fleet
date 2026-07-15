const toMs = (value) => {
	return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

/**
 * Reconstruct the online/offline timeline for the fleet grid's 24h connectivity bar from a node's
 * recorded transition events.
 *
 * Returns non-overlapping segments spanning [windowStartMs, nowMs]:
 *   { online: true | false | null, startMs, endMs }
 * where `online: null` means "no data" — a stretch before we have any event to establish the
 * node's state (rendered gray). Green/orange are only claimed for periods we actually observed.
 *
 * @param {Array<{ online: boolean, createdAt: Date|string|number }>} events - transitions, any order
 * @param {number} windowStartMs - start of the window (typically now - 24h)
 * @param {number} nowMs - end of the window
 * @param {boolean} liveOnline - the node's current live presence, used to reconcile the trailing
 *   segment when no transition happened inside the window (guards against a disconnect that a
 *   server crash never recorded).
 */
const buildConnectivitySegments = ({ events, windowStartMs, nowMs, liveOnline }) => {
	const sorted = [...(events || [])]
		.map((event) => { return { online: Boolean(event.online), ts: toMs(event.createdAt) }; })
		.filter((event) => { return Number.isFinite(event.ts); })
		.sort((a, b) => { return a.ts - b.ts; });

	// No history at all: the whole window is unknown.
	if (sorted.length === 0) {
		return [{ online: null, startMs: windowStartMs, endMs: nowMs }];
	}

	// `seed` is the state as the window opens: the most recent event at or before windowStart. If
	// there is none, the pre-window state is unknown (null) until the first in-window transition.
	const seed = sorted.filter((event) => { return event.ts <= windowStartMs }).at(-1);
	const inWindow = sorted.filter((event) => { return event.ts > windowStartMs && event.ts <= nowMs; });

	const segments = [];
	let cursor = windowStartMs;
	let state = seed ? seed.online : null;
	for (const event of inWindow) {
		if (event.ts > cursor) {
			segments.push({ online: state, startMs: cursor, endMs: event.ts });
			cursor = event.ts;
		}
		state = event.online;
	}

	// No transition inside the window means a steady state since before it — trust live presence for
	// the current truth. With in-window transitions the recorded ones are precise, so keep them.
	if (inWindow.length === 0 && typeof liveOnline === 'boolean') {
		state = liveOnline;
	}
	if (cursor < nowMs) {
		segments.push({ online: state, startMs: cursor, endMs: nowMs });
	}

	// Collapse adjacent same-state runs so the bar renders as few segments as possible.
	return segments.reduce((merged, segment) => {
		const previous = merged.at(-1);
		if (previous && previous.online === segment.online) {
			previous.endMs = segment.endMs;
		} else {
			merged.push({ ...segment });
		}
		return merged;
	}, []);
};

export { buildConnectivitySegments };

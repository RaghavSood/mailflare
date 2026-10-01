/** Milliseconds a zone is ahead of UTC at an instant. */
function zoneOffset(instant: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(instant));
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time in `timeZone` happens. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
	const guess = Date.UTC(year, month - 1, day, hour, minute);
	let instant = guess - zoneOffset(guess, timeZone);
	instant = guess - zoneOffset(instant, timeZone);
	return new Date(instant);
}

function localDate(now: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		weekday: "short",
	}).formatToParts(now);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
	return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), weekday };
}

function addDays(date: { year: number; month: number; day: number }, days: number) {
	const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/**
 * When a snooze choice ends, in the viewer's zone: later today is 6 PM (or three
 * hours from now after 5 PM), tomorrow and the weekend start at 8 AM, next week
 * is Monday 8 AM. A custom value is a datetime-local string in that zone.
 */
export function resolveSnoozeTime(choice: string, custom: string | null, timeZone: string, now = new Date()): Date | null {
	const today = localDate(now, timeZone);
	let result: Date | null = null;
	if (choice === "later") {
		result = today.hour < 17 ? zonedTime(today.year, today.month, today.day, 18, 0, timeZone) : new Date(now.getTime() + 3 * 3600_000);
	} else if (choice === "tomorrow") {
		const next = addDays(today, 1);
		result = zonedTime(next.year, next.month, next.day, 8, 0, timeZone);
	} else if (choice === "weekend") {
		const days = today.weekday === 6 ? 7 : (6 - today.weekday + 7) % 7 || 7;
		const next = addDays(today, days);
		result = zonedTime(next.year, next.month, next.day, 8, 0, timeZone);
	} else if (choice === "nextweek") {
		const days = (1 - today.weekday + 7) % 7 || 7;
		const next = addDays(today, days);
		result = zonedTime(next.year, next.month, next.day, 8, 0, timeZone);
	} else if (choice === "custom" && custom) {
		const match = custom.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
		if (match) result = zonedTime(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), timeZone);
	}
	return result && result.getTime() > now.getTime() ? result : null;
}

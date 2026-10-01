/**
 * Server-rendered HTML for the v2 interface. Every interpolated value is
 * escaped unless it is already an `Html` fragment, so rendering untrusted mail
 * fields can only produce text. `raw` is the one way to opt out; use it only
 * for markup built here (icons, pre-escaped attribute documents).
 */
export class Html {
	constructor(readonly value: string) {}
	toString(): string {
		return this.value;
	}
}

type Renderable = Html | string | number | boolean | null | undefined | Renderable[];

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function render(value: Renderable): string {
	if (value instanceof Html) return value.value;
	if (Array.isArray(value)) return value.map(render).join("");
	if (value === null || value === undefined || value === false || value === true) return "";
	return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Renderable[]): Html {
	let out = strings[0];
	for (let index = 0; index < values.length; index += 1) {
		out += render(values[index]) + strings[index + 1];
	}
	return new Html(out);
}

export function raw(value: string): Html {
	return new Html(value);
}

export function join(items: Renderable[], separator: Renderable = ""): Html {
	const sep = render(separator);
	return new Html(items.map(render).join(sep));
}

/** A `class` attribute value from conditional parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}

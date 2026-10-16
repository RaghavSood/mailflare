/** Splits a migration file into statements, keeping trigger bodies (BEGIN … END) whole. */
export function splitSql(sql) {
	const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]+|;|[^\S\n]+|\n|./g) ?? [];
	const statements = [];
	let current = "";
	let triggerDepth = 0;
	let insideTrigger = false;

	for (const token of tokens) {
		if (token.startsWith("--") || token.startsWith("/*")) {
			current += " ";
			continue;
		}

		const word = token.toUpperCase();
		if (word === "TRIGGER") insideTrigger = true;
		if (insideTrigger && (word === "BEGIN" || word === "CASE")) triggerDepth += 1;
		if (insideTrigger && word === "END") triggerDepth -= 1;
		current += token;

		if (token === ";" && triggerDepth === 0) {
			if (current.trim()) statements.push(current.trim());
			current = "";
			insideTrigger = false;
		}
	}

	if (current.trim()) statements.push(current.trim());
	return statements;
}

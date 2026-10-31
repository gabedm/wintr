/** JSON.parse has already validated syntax; retain duplicate-key refusal, including escaped spellings. */
export function refuseDuplicateKeys(text: string, failure: () => Error): void {
  const stack: (Set<string> | null)[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = at++;
      while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
      let next = at + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const keys = stack.at(-1);
        const key = JSON.parse(text.slice(start, at + 1)) as string;
        if (!keys || keys.has(key)) throw failure();
        keys.add(key);
      }
    }
  }
}

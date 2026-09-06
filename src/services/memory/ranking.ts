/** Language-independent lexical retrieval; identifiers remain exact-match triggers. */
function terms(text: string): string[] {
    const expanded = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return expanded.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1);
}

export function bm25Scores(documents: string[][], query: string[]): number[] {
    const frequencies = documents.map(document => {
        const counts = new Map<string, number>();
        for (const word of terms(document.join(' '))) { counts.set(word, (counts.get(word) ?? 0) + 1); }
        return counts;
    });
    const lengths = frequencies.map(counts => [...counts.values()].reduce((sum, count) => sum + count, 0));
    const average = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, documents.length);
    const queryTerms = new Set(terms(query.join(' ')));
    const documentFrequency = new Map([...queryTerms].map(word => [word, frequencies.filter(counts => counts.has(word)).length]));
    return frequencies.map((counts, index) => [...queryTerms].reduce((score, word) => {
        const tf = counts.get(word) ?? 0;
        if (tf === 0) { return score; }
        const df = documentFrequency.get(word)!;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        return score + idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * lengths[index] / Math.max(1, average)));
    }, 0));
}

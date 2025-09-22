import { NormalizedLang } from "./chainTypes";

export function normalizeLanguageCode(input: string): NormalizedLang {
    const t = (input || '').trim().toLowerCase();
    if (!t) { return 'other'; }
    // English
    if (['en', 'en-us', 'en-gb', 'english', 'eng', '英语', '英文'].includes(t)) { return 'en'; }
    // Chinese (treat simplified/traditional the same for detection)
    if ([
        'zh', 'zh-cn', 'zh-sg', 'zh-hans', 'zh-hant', 'zh-tw', 'zh-hk',
        'chinese', 'zhongwen', '中文', '简体中文', '繁體中文', '漢語', '汉语', '華語', '华语'
    ].includes(t)) { return 'zh'; }
    // Japanese
    if (['ja', 'ja-jp', 'japanese', '日本語', 'にほんご', '日语', '日文'].includes(t)) { return 'ja'; }
    // Korean
    if (['ko', 'ko-kr', 'korean', '한국어', '한글', '韓國語', '韩语', '韓文', '朝鲜语'].includes(t)) { return 'ko'; }
    // German
    if (['de', 'de-de', 'german', 'deutsch', '德语', '德文'].includes(t)) { return 'de'; }
    // French
    if (['fr', 'fr-fr', 'french', 'francais', 'français', '法语', '法文'].includes(t)) { return 'fr'; }
    // Spanish
    if (['es', 'es-es', 'spanish', 'espanol', 'español', '西班牙语', '西文'].includes(t)) { return 'es'; }
    // Portuguese
    if (['pt', 'pt-pt', 'pt-br', 'portuguese', 'portugues', 'português', '葡萄牙语', '葡文'].includes(t)) { return 'pt'; }
    // Russian
    if (['ru', 'ru-ru', 'russian', 'русский', '俄语', '俄文'].includes(t)) { return 'ru'; }
    // Italian
    if (['it', 'it-it', 'italian', 'italiano', '意大利语', '意大利文'].includes(t)) { return 'it'; }
    return 'other';
}

export function extractNarrativeTextForLanguageCheck(message: string): string {
    if (!message) { return ''; }
    const lines = message.split('\n');
    if (lines.length === 0) { return ''; }

    const header = lines[0] || '';
    const colonIdx = header.indexOf(':');
    const desc = colonIdx !== -1 ? header.slice(colonIdx + 1).trim() : header.trim();

    // Find body start: first blank line after header
    let i = 1;
    while (i < lines.length && lines[i].trim() !== '') { i++; }
    const bodyStart = i + 1;

    // Find footers start: first token-like footer (BREAKING CHANGE or Token: value)
    const footerTokenPattern = /^(BREAKING CHANGE|[A-Za-z][A-Za-z-]+):\s/;
    let footersStart = lines.length;
    for (let j = bodyStart; j < lines.length; j++) {
        if (footerTokenPattern.test(lines[j])) { footersStart = j; break; }
    }

    const bodyLines: string[] = [];
    for (let j = bodyStart; j < footersStart; j++) {
        const l = lines[j];
        // strip common bullet prefixes
        const m = l.match(/^\s*([-*])\s+(.*)$/);
        bodyLines.push(m ? m[2] : l);
    }

    return [desc, ...bodyLines].join(' ').trim();
}

// Detect Latin-based target languages by diacritics/punctuation signals.
function detectLatinLanguageBySignals(text: string): 'de' | 'fr' | 'es' | 'pt' | 'it' | null {
    const s = (text || '').toLowerCase();
    if (!s) { return null; }

    // Strong markers first
    if (/[ãõ]/i.test(s)) { return 'pt'; }
    if (/[ñ¡¿]/i.test(s)) { return 'es'; }
    if (/ß/.test(s)) { return 'de'; }
    if (/œ/.test(s)) { return 'fr'; }

    // Weighted counts for languages with overlapping accents
    const countMatches = (re: RegExp): number => {
        const m = s.match(re);
        return m ? m.length : 0;
    };

    const scoreDe = countMatches(/[äöü]/gi) + 2 * countMatches(/ß/g);
    const scoreFr = countMatches(/[àâçéèêëîïôœùûüÿ]/gi) + countMatches(/œ/gi);
    const scoreEs = countMatches(/[áéíóúñü]/gi) + 2 * countMatches(/[¡¿]/g);
    const scorePt = countMatches(/[áàâãéêíóôõúç]/gi) + 2 * countMatches(/[ãõ]/gi);
    const scoreIt = countMatches(/[àèéìíòóù]/gi);

    const scores: Array<{ lang: 'de' | 'fr' | 'es' | 'pt' | 'it'; score: number }> = [
        { lang: 'de', score: scoreDe },
        { lang: 'fr', score: scoreFr },
        { lang: 'es', score: scoreEs },
        { lang: 'pt', score: scorePt },
        { lang: 'it', score: scoreIt },
    ];
    scores.sort((a, b) => b.score - a.score);

    if (scores[0].score === 0) { return null; }
    if (scores.length === 1 || scores[0].score >= scores[1].score + 2) { return scores[0].lang; }
    return null; // ambiguous
}

export function isLikelyTargetLanguage(text: string, target: NormalizedLang): 'yes' | 'no' | 'uncertain' {
    const scores = countScripts(text);

    // Total letters seen (approximate narrative signal)
    const totalSignal = scores.asciiLetters + scores.cjk + scores.hiragana + scores.katakana + scores.hangul + scores.cyrillic;
    if (totalSignal === 0) { return 'uncertain'; }

    switch (target) {
        case 'en': {
            const nonLatin = scores.cjk + scores.hiragana + scores.katakana + scores.hangul + scores.cyrillic;
            if (nonLatin === 0) { return 'yes'; }
            if (nonLatin > 0 && scores.asciiLetters === 0) { return 'no'; }
            return 'uncertain';
        }
        case 'zh': {
            // Favor CJK without kana/hangul; allow some ASCII for code/tokens
            const kanaHangul = scores.hiragana + scores.katakana + scores.hangul;
            if (scores.cjk >= 4 && kanaHangul === 0) { return 'yes'; }
            if (scores.cjk >= 2 && scores.cjk >= scores.asciiLetters) { return 'yes'; }
            if (scores.cjk === 0 && (scores.hiragana + scores.katakana + scores.hangul) > 0) { return 'no'; }
            if (scores.cjk === 0 && scores.asciiLetters > 0) { return 'uncertain'; }
            return 'uncertain';
        }
        case 'ja': {
            // Presence of kana is a strong indicator
            if ((scores.hiragana + scores.katakana) >= 2) { return 'yes'; }
            if (scores.cjk >= 2 && (scores.hiragana + scores.katakana) >= 1) { return 'yes'; }
            if ((scores.hiragana + scores.katakana + scores.hangul) === 0 && scores.asciiLetters > 0) { return 'no'; }
            return 'uncertain';
        }
        case 'ko': {
            if (scores.hangul >= 2) { return 'yes'; }
            if (scores.hangul === 0 && (scores.hiragana + scores.katakana + scores.cjk) > 0) { return 'no'; }
            return 'uncertain';
        }
        case 'ru': {
            if (scores.cyrillic >= 2) { return 'yes'; }
            if (scores.cyrillic === 0 && (scores.cjk + scores.hiragana + scores.katakana + scores.hangul) > 0) { return 'no'; }
            return 'uncertain';
        }
        case 'de':
        case 'fr':
        case 'es':
        case 'pt':
        case 'it': {
            const detected = detectLatinLanguageBySignals(text);
            if (detected === target) { return 'yes'; }
            if (detected && detected !== target) { return 'no'; }
            // If other scripts dominate, it's unlikely the Latin target
            const otherScripts = scores.cjk + scores.hiragana + scores.katakana + scores.hangul + scores.cyrillic;
            if (otherScripts > 0 && scores.asciiLetters === 0) { return 'no'; }
            return 'uncertain';
        }
        default:
            return 'uncertain';
    }
}

function countScripts(text: string): {
    asciiLetters: number;
    cjk: number;
    hiragana: number;
    katakana: number;
    hangul: number;
    cyrillic: number;
} {
    let asciiLetters = 0;
    let cjk = 0;
    let hiragana = 0;
    let katakana = 0;
    let hangul = 0;
    let cyrillic = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const code = ch.charCodeAt(0);
        // ASCII letters
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) { asciiLetters++; continue; }
        // CJK Unified Ideographs + Ext A + Compatibility Ideographs (BMP ranges)
        if (
            (code >= 0x3400 && code <= 0x4DBF) ||
            (code >= 0x4E00 && code <= 0x9FFF) ||
            (code >= 0xF900 && code <= 0xFAFF)
        ) { cjk++; continue; }
        // Hiragana
        if (code >= 0x3040 && code <= 0x309F) { hiragana++; continue; }
        // Katakana (including Phonetic Extensions)
        if ((code >= 0x30A0 && code <= 0x30FF) || (code >= 0x31F0 && code <= 0x31FF)) { katakana++; continue; }
        // Hangul (Jamo + Syllables + Compatibility Jamo)
        if ((code >= 0x1100 && code <= 0x11FF) || (code >= 0x3130 && code <= 0x318F) || (code >= 0xAC00 && code <= 0xD7AF)) { hangul++; continue; }
        // Cyrillic (basic + supplement)
        if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) { cyrillic++; continue; }
    }
    return { asciiLetters, cjk, hiragana, katakana, hangul, cyrillic };
}


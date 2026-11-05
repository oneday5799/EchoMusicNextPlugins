// Enhanced LRC assembly from Kugou word-timed lines. Interlude lines (empty
// text) push a bare timestamp into the translation/romanization tracks so
// players keep their blank-line alignment.

import type { KugouDto_lyric_Lyrics, KugouDto_search_lyric_Candidate } from 'echo:plugin-sdk';
import { pad2 } from './codec.ts';

export function formatLrcTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const minutes = Math.floor(total / 6000);
  const seconds = Math.floor((total % 6000) / 100);
  const centiseconds = total % 100;
  const tail = centiseconds < 10 ? `0${centiseconds}` : String(centiseconds);
  return `[${pad2(minutes)}:${pad2(seconds)}.${tail}]`;
}

export interface BuiltLrc {
  content: string;
  translation?: string;
  romanization?: string;
}

export function buildLrcFromKugou(lyrics: KugouDto_lyric_Lyrics | null): BuiltLrc | null {
  const lines = lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : [];
  const main: string[] = [];
  const translation: string[] = [];
  const romanization: string[] = [];
  let hasTranslation = false;
  let hasRomanization = false;
  for (const line of lines) {
    if (!line || typeof line.text !== 'string') continue;
    const stamp = formatLrcTime(line.start_ms);
    const words = Array.isArray(line.words) ? line.words : [];
    let body = '';
    if (words.length > 0) {
      for (const word of words) {
        if (!word || !word.text) continue;
        body += `<${formatLrcTime(word.start_ms)}>${word.text}`;
      }
    }
    if (!body) body = line.text;
    main.push(`${stamp}${body}`);
    // Empty interlude lines keep a bare stamp in the auxiliary tracks.
    const timed = line.text.trim().length > 0;
    if (line.translation) {
      hasTranslation = true;
      translation.push(`${stamp}${line.translation}`);
    } else if (!timed) {
      translation.push(stamp);
    }
    if (line.romanization) {
      hasRomanization = true;
      romanization.push(`${stamp}${line.romanization}`);
    } else if (!timed) {
      romanization.push(stamp);
    }
  }
  if (main.length === 0) return null;
  return {
    content: main.join('\n'),
    translation: hasTranslation ? translation.join('\n') : undefined,
    romanization: hasRomanization ? romanization.join('\n') : undefined,
  };
}

export function pickLyricCandidate(
  candidates: KugouDto_search_lyric_Candidate[],
): KugouDto_search_lyric_Candidate | null {
  let best: KugouDto_search_lyric_Candidate | null = null;
  let bestKey = -1;
  for (const candidate of candidates) {
    if (!candidate || !candidate.source_id || !candidate.access_key) continue;
    const key =
      (candidate.word_timed ? 4 : 0) +
      (candidate.scrollable ? 2 : 0) +
      (typeof candidate.score === 'number' && candidate.score > 0 ? 1 : 0);
    if (key > bestKey) {
      bestKey = key;
      best = candidate;
    }
  }
  return best;
}

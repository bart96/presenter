export * from './Song';
export * from './CcliSong';
export * from './SngSong';
export * from './lyrics';
export * from './detectLanguage';

export type TBlocks = { [key: string]: string[] };

export const SONG_CUSTOM_NUMBER_LIMIT = 10000;
export const SONG_BLOCK_SEPARATOR = '---';
/**
 * A lyric line carrying an explicit language tag: `[DE] Zeile`.
 *
 * Two to five letters, matching what `api/LanguageTags.php` scrapes out of the library — the
 * two used to disagree (`\w{2}` here against `[A-Za-z]{2,5}` there), so a three-letter tag was
 * offered by the style editor's language list and then rendered as ordinary lyrics. The space
 * after the bracket is optional so a hand-typed `[DE]Zeile` still parses.
 *
 * The width is not free: a pasted section marker like `[Intro] …` now reads as a language tag
 * where `[Chorus] …` (six letters) does not. The language review tool lists every tag it finds
 * in the library so anything caught this way is visible rather than silent.
 */
export const SONG_TRANSLATION_LINE_REGEX = /^\[([A-Za-z]{2,5})] ?(.*)$/;

/** Width of a language code, shared by the tag regex, the account pool and the song list. */
export const LANGUAGE_CODE_REGEX = /^[A-Za-z]{2,5}$/;

export interface ISong {
  title: string;
  authors?: string;
  copyright?: string;
  songNumber: number;
  blocks: TBlocks;
  initialOrder?: string[];
  order: Record<string, string[]>;
  account?: number;
  background?: string;
  css?: string;
  /**
   * Ordered language codes the song is written in. The first entry is the default language,
   * whose lines are stored untagged in `blocks`; the rest correspond to `[XX] ` prefixes.
   * Empty or missing on songs saved before the editor tracked this.
   */
  languages?: string[];
  lastUpdate?: number;
  /** Server-side last-modified timestamp (as returned by the API) — used for change detection */
  updatedAt?: string | null;

  getBlock: (order: string, index: number) => string[];
  getBlocks: (order: string) => { name: string; lines: string[]; copyright: boolean }[];
  getOrder: (order: string) => string[];
}

/** Split a stored lyric line into its language tag, if it carries one, and its text. */
export const parseTaggedLine = (line: string): { language?: string; text: string } => {
  const match = line.match(SONG_TRANSLATION_LINE_REGEX);

  return match ? { language: match[1].toUpperCase(), text: match[2] } : { text: line };
};

/**
 * The language that anchors a block's lyric lines — the one whose lines are *the* line, with
 * every other language hanging off it as a translation.
 *
 * `declared` is the song's own first language and is normally the answer. The fallback matters
 * though: a fully tagged block whose declared language appears nowhere in it would otherwise
 * have no anchor at all, which shows up as a block that cannot be navigated line by line. When
 * that happens the first tag present takes over, so the block still works.
 */
export const resolvePrimaryLanguage = (lines: string[], declared?: string): string | undefined => {
  const wanted = declared?.toUpperCase();
  if (!wanted) return undefined;

  for (const line of lines) {
    const { language } = parseTaggedLine(line);
    // An untagged line is an anchor whatever the declared language is, so the block is fine.
    if (!language || language === wanted) return wanted;
  }

  return lines.length > 0 ? parseTaggedLine(lines[0]).language : wanted;
};

/**
 * Whether a stored line anchors a lyric line rather than translating one.
 *
 * Lines used to be marked as primary by carrying no tag at all, and that still counts — songs
 * saved before tagging became explicit are read exactly as before. A tagged line is primary
 * when its language is the block's anchor language.
 */
export const isPrimaryLine = (line: string, primaryLanguage?: string): boolean => {
  const { language } = parseTaggedLine(line);

  if (!language) return true;

  return !!primaryLanguage && language === primaryLanguage.toUpperCase();
};

/**
 * How many lyric lines a block has — the count line-by-line navigation steps through.
 * Translations do not add steps; they move with the line they belong to.
 */
export const countPrimaryLines = (lines: string[], declaredPrimary?: string): number => {
  const primary = resolvePrimaryLanguage(lines, declaredPrimary);

  return lines.filter((line) => isPrimaryLine(line, primary)).length;
};

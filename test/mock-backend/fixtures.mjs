/**
 * Fixture data for the mock backend.
 *
 * Deliberately awkward on purpose: long German titles with umlauts, 7-digit CCLI numbers,
 * multi-author credits, entries carrying both a custom key and a long block-order name.
 * Layout bugs show up on strings like these and hide behind "Song 1" / "Test".
 *
 * Everything is plain data — edit freely, or add a case that reproduces a bug you are chasing.
 */

export const account = { license: 1, mail: 'demo@example.com', name: 'Demo Gemeinde' };

export const songs = [
  { songNumber: 12, title: 'Ich sing dir mein Lied — in ihm klingt mein Leben', authors: 'Fritz Baltruweit', orderCount: 3 },
  { songNumber: 47, title: 'Great Is Thy Faithfulness', authors: 'Thomas O. Chisholm, William M. Runyan', orderCount: 2 },
  { songNumber: 108, title: 'Holy Spirit', authors: 'Bryan Torwalt, Katie Torwalt', orderCount: 1 },
  { songNumber: 4589734, title: 'Way Maker', authors: 'Osinachi Kalu Okoro Egbu', orderCount: 4 },
  { songNumber: 7050671, title: 'Goodness of God (feat. an unusually long subtitle)', authors: 'Jenn Johnson, Ed Cash', orderCount: 2 },
  { songNumber: 7138219, title: 'Build My Life', authors: 'Pat Barrett', orderCount: 1 },
];

/** Full song payloads (GET /rest/Song/{number}), keyed by song number. */
export const songDetails = {
  4589734: {
    account: 1,
    songNumber: 4589734,
    title: 'Way Maker',
    authors: 'Osinachi Kalu Okoro Egbu',
    copyright: '2016 Integrity Music Europe',
    initialOrder: ['Verse 1', 'Chorus', 'Bridge'],
    order: { Default: ['Verse 1', 'Chorus', 'Bridge', 'Chorus'], 'Kurzfassung ohne Bridge': ['Verse 1', 'Chorus'] },
    // Placeholder text only — never put real lyrics in a fixture.
    blocks: { 'Verse 1': ['[verse line 1]', '[verse line 2]'], Chorus: ['[chorus line]'], Bridge: ['[bridge line]'] },
    styleId: null,
    ccliNumber: '4589734',
    key: 'E',
    updatedAt: '2026-08-01 10:00:00',
  },
};

export const shows = [
  {
    title: 'Gottesdienst 14.08.2026 — Familiengottesdienst',
    date: '2026-08-14 09:30:00',
    order: [
      { type: 'song', songNumber: 4589734, order: 'Default' },
      { type: 'song', songNumber: 47 },
      { type: 'media', mediaPath: 'clip.mp4', mediaSubType: 'video' },
    ],
    groups: null,
    styleId: null,
    eventId: 42,
    eventName: 'Sonntagsgottesdienst',
  },
  { title: 'Probe 12.08.2026', date: '2026-08-12 19:00:00', order: [{ type: 'song', songNumber: 108 }], groups: null },
  { title: 'Jugendabend 09.08.2026', date: '2026-08-09 18:00:00', order: [], groups: null },
];

/**
 * Bands. Two of them, one with a colour and members, so the settings editor, the pickers
 * and the chips all have something real to render.
 */
export const bands = [
  { id: 1, name: 'Sonntagsband', color: '#1976d2', members: ['Marcel', 'Lena', 'Tobias'], sortOrder: 0 },
  { id: 2, name: 'Jugendband', color: '#7b1fa2', members: ['Jonas', 'Mira'], sortOrder: 1 },
];

export const setLists = [
  {
    id: 1,
    name: 'Sonntagsband',
    bandIds: [1],
    sortOrder: 0,
    entries: [
      {
        id: 11,
        songNumber: 4589734,
        songTitle: 'Way Maker',
        songAuthors: 'Osinachi Kalu Okoro Egbu',
        sortOrder: 0,
        tags: [{ id: 1, tagName: 'Lobpreis', customKey: 'G', blockOrderName: 'Kurzfassung ohne Bridge' }],
      },
      {
        id: 12,
        songNumber: 7050671,
        songTitle: 'Goodness of God (feat. an unusually long subtitle)',
        songAuthors: 'Jenn Johnson, Ed Cash',
        sortOrder: 1,
        tags: [{ id: 2, tagName: 'Lobpreis', customKey: 'Ab', blockOrderName: null }],
      },
      {
        id: 13,
        songNumber: 47,
        songTitle: 'Great Is Thy Faithfulness',
        songAuthors: 'Thomas O. Chisholm',
        sortOrder: 2,
        tags: [],
      },
    ],
  },
  { id: 2, name: 'Abendmahl', sortOrder: 1, entries: [] },
  { id: 3, name: 'Weihnachten', sortOrder: 2, entries: [] },
];

/** Admin panel: accounts list. */
export const adminAccounts = [
  {
    license: 1,
    mail: 'demo@example.com',
    name: 'Demo Gemeinde',
    active: true,
    created_at: '2025-01-01 12:00:00',
    lastactivity: '2026-08-14 08:00:00',
    church_tools_url: 'https://demo.church.tools/api/',
    church_tools_enabled: true,
    providers: [],
  },
  {
    license: 2,
    mail: 'zweite@example.com',
    name: 'Zweite Gemeinde',
    active: true,
    created_at: '2025-06-01 12:00:00',
    lastactivity: '2026-07-30 08:00:00',
    church_tools_url: null,
    church_tools_enabled: false,
    providers: [],
  },
];

/**
 * Admin song library (GET /rest/AdminSongs/{license}) — includes a deliberate duplicate pair
 * (same normalized title, different numbers) so the merge flow has something to work on.
 */
export const adminSongs = {
  license: 1,
  songs: [
    {
      songNumber: 12,
      title: 'Ich sing dir mein Lied — in ihm klingt mein Leben',
      authors: 'Fritz Baltruweit',
      copyright: '',
      ccliNumber: null,
      key: null,
      updatedAt: '2026-02-02 10:00:00',
      orderCount: 3,
      blockCount: 5,
      pdfCount: 0,
      annotationCount: 0,
      shows: [],
      setLists: [],
    },
    {
      songNumber: 4589734,
      title: 'Way Maker',
      authors: 'Osinachi Kalu Okoro Egbu',
      copyright: '2016 Integrity Music Europe',
      ccliNumber: '4589734',
      key: 'E',
      updatedAt: '2026-08-01 10:00:00',
      orderCount: 4,
      blockCount: 6,
      pdfCount: 2,
      annotationCount: 14,
      shows: ['Gottesdienst 14.08.2026 — Familiengottesdienst'],
      setLists: ['Sonntagsband'],
    },
    {
      songNumber: 900001,
      title: 'Way  Maker!',
      authors: 'Sinach',
      copyright: '',
      ccliNumber: '4589734',
      key: 'G',
      updatedAt: '2025-11-11 10:00:00',
      orderCount: 1,
      blockCount: 4,
      pdfCount: 0,
      annotationCount: 0,
      shows: ['Probe 12.08.2026'],
      setLists: ['Sonntagsband'],
    },
  ],
  groups: [{ id: 1, reasons: ['ccli', 'title'], songNumbers: [4589734, 900001] }],
};

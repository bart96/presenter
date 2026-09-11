import type { ReactNode } from 'react';
import {
  Tune as GeneralIcon,
  Slideshow as PresentationIcon,
  LibraryMusic as LibraryIcon,
  NotificationsNone as NotificationsIcon,
  KeyboardAlt as KeyboardIcon,
  SettingsRemote as RemoteIcon,
  DesktopWindows as DesktopIcon,
  PrivacyTip as PrivacyIcon,
  type SvgIconComponent,
} from '@mui/icons-material';
import type { TranslationFunctions } from '@/i18n/i18n-types';
import type { SettingsState } from '@/store/settingsSlice';

/**
 * The settings catalog: one description of what the settings panel contains.
 *
 * Every row carries its own translated label and description, so the panel can render,
 * search and reset it without a lookup table on the side. Blocks that are more than a
 * label and a control (the keyboard editor, the viewer token, the updater) arrive as a
 * `render` on their section instead, with `keywords` so search can still find them.
 */

export type SelectOption = { value: string; label: string };

export type SettingControl =
  | { kind: 'boolean' }
  | { kind: 'text'; placeholder?: string }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'select'; options: SelectOption[] }
  | { kind: 'color' }
  /** Text field plus a folder picker when the desktop app offers one. */
  | { kind: 'path' };

export type SettingDef = {
  key: keyof SettingsState;
  label: string;
  description?: string;
  control: SettingControl;
};

export type SettingsSection = {
  id: string;
  /** Omitted when `render` brings its own heading. */
  title?: string;
  description?: string;
  settings?: SettingDef[];
  render?: () => ReactNode;
  /** Extra search terms for a section whose content is not made of rows. */
  keywords?: string[];
};

export type SettingsCategory = {
  id: string;
  label: string;
  description: string;
  icon: SvgIconComponent;
  sections: SettingsSection[];
};

/** What the catalog needs to know about the environment to leave out what does not apply. */
export type CatalogContext = {
  isElectron: boolean;
  offlineMode: boolean;
  /** Blocks that need state owned by the panel (dialogs, pickers, API mutations). */
  slots: {
    globalStyle: () => ReactNode;
    showTitleTemplate: () => ReactNode;
    bands: () => ReactNode;
    songLanguages: () => ReactNode;
    viewerToken: () => ReactNode;
    remoteCommands: () => ReactNode;
    keyboardMapping: () => ReactNode;
    companion: () => ReactNode;
    audioMixer: () => ReactNode;
    autoUpdater: () => ReactNode;
    credentials: () => ReactNode;
    desktopDownload: () => ReactNode;
    backup: () => ReactNode;
    privacyNotice: () => ReactNode;
  };
};

/**
 * The show-title description lists the template variables, and typesafe-i18n reads those
 * braces as parameters. Handing each one its own name back prints the list as written.
 */
export const TEMPLATE_VARS = { yyyy: '{yyyy}', MM: '{MM}', dd: '{dd}', HH: '{HH}', mm: '{mm}' };

/**
 * A trailing unit in a label ("Transition duration (ms)") reads better as a suffix on the
 * input than as part of the label. Both locales write it the same way, so one split does.
 */
export const splitUnit = (label: string): { label: string; unit?: string } => {
  const match = /^(.*?)\s*\((ms|%)\)$/.exec(label);
  return match ? { label: match[1], unit: match[2] } : { label };
};

export const buildSettingsCatalog = (LL: TranslationFunctions, ctx: CatalogContext): SettingsCategory[] => {
  const O = LL.SETTINGS.OPTIONS;
  const S = LL.SETTINGS.SECTIONS;
  const V = LL.SETTINGS.VALUES;
  const D = LL.SETTINGS.GROUP_DESC;

  const clickOptions: SelectOption[] = [
    { value: 'click', label: V.CLICK() },
    { value: 'double-click', label: V.DOUBLE_CLICK() },
  ];
  const transitionOptions: SelectOption[] = [
    { value: 'cut', label: V.CUT() },
    { value: 'fade', label: V.FADE() },
  ];

  const general: SettingsCategory = {
    id: 'general',
    label: LL.SETTINGS.GROUP_GENERAL(),
    description: D.GENERAL(),
    icon: GeneralIcon,
    sections: [
      {
        id: 'appearance',
        title: S.APPEARANCE(),
        settings: [
          {
            key: 'uiLanguage',
            label: O.UI_LANGUAGE.TITLE(),
            description: O.UI_LANGUAGE.DESCRIPTION(),
            control: {
              kind: 'select',
              options: [
                { value: 'en', label: LL.HEADER.LANGUAGE_EN() },
                { value: 'de', label: LL.HEADER.LANGUAGE_DE() },
              ],
            },
          },
          {
            key: 'themeMode',
            label: O.THEME_MODE.TITLE(),
            description: O.THEME_MODE.DESCRIPTION(),
            control: {
              kind: 'select',
              options: [
                { value: 'light', label: V.THEME_LIGHT() },
                { value: 'dark', label: V.THEME_DARK() },
                { value: 'system', label: V.THEME_SYSTEM() },
              ],
            },
          },
        ],
      },
      {
        id: 'account-defaults',
        title: S.ACCOUNT_DEFAULTS(),
        description: LL.SETTINGS.GLOBAL_STYLE_HINT(),
        render: () => (
          <>
            {ctx.slots.globalStyle()}
            {ctx.slots.showTitleTemplate()}
          </>
        ),
        keywords: [LL.SETTINGS.GLOBAL_STYLE(), O.SHOW_TITLE_TEMPLATE.TITLE(), O.SHOW_TITLE_TEMPLATE.DESCRIPTION(TEMPLATE_VARS)],
      },
      {
        id: 'bands',
        title: S.BANDS(),
        description: LL.BANDS.SECTION_HINT(),
        render: () => ctx.slots.bands(),
        keywords: [LL.BANDS.TITLE(), LL.BANDS.MEMBERS(), 'band', 'lineup', 'besetzung', 'musiker'],
      },
      // Desktop app only: the browser build always talks to the server it was loaded from and
      // ignores the setting (see getBackendBaseUrl).
      ...(ctx.isElectron
        ? [
            {
              id: 'connection',
              title: S.CONNECTION(),
              settings: [
                {
                  key: 'backendUrl' as const,
                  label: O.BACKEND_URL.TITLE(),
                  description: O.BACKEND_URL.DESCRIPTION(),
                  control: { kind: 'text' as const, placeholder: 'https://...' },
                },
              ],
            },
          ]
        : []),
      {
        id: 'backup',
        title: S.BACKUP(),
        description: LL.SETTINGS.EXPORT_DESC(),
        render: () => ctx.slots.backup(),
        keywords: [LL.SETTINGS.EXPORT_BUTTON(), LL.SETTINGS.IMPORT_BUTTON(), LL.SETTINGS.EXPORT_IMPORT()],
      },
    ],
  };

  const presentation: SettingsCategory = {
    id: 'presentation',
    label: LL.SETTINGS.GROUP_PRESENTATION(),
    description: D.PRESENTATION(),
    icon: PresentationIcon,
    sections: [
      {
        id: 'transitions',
        title: S.TRANSITIONS(),
        settings: [
          {
            key: 'transitionMode',
            label: O.TRANSITION_MODE.TITLE(),
            description: O.TRANSITION_MODE.DESCRIPTION(),
            control: { kind: 'select', options: transitionOptions },
          },
          {
            key: 'transitionDuration',
            label: O.TRANSITION_DURATION.TITLE(),
            description: O.TRANSITION_DURATION.DESCRIPTION(),
            control: { kind: 'number', min: 0, step: 50 },
          },
          {
            key: 'hideTransitionMode',
            label: O.HIDE_TRANSITION_MODE.TITLE(),
            description: O.HIDE_TRANSITION_MODE.DESCRIPTION(),
            control: { kind: 'select', options: transitionOptions },
          },
          {
            key: 'hideTransitionDuration',
            label: O.HIDE_TRANSITION_DURATION.TITLE(),
            description: O.HIDE_TRANSITION_DURATION.DESCRIPTION(),
            control: { kind: 'number', min: 0, step: 50 },
          },
          {
            key: 'videoFadeDuration',
            label: O.VIDEO_FADE_DURATION.TITLE(),
            description: O.VIDEO_FADE_DURATION.DESCRIPTION(),
            control: { kind: 'number', min: 0, step: 50 },
          },
        ],
      },
      {
        // The next-block preview lives in the style editor — a style that sets it wins over
        // anything global, so duplicating it here only invited disagreement.
        id: 'on-screen',
        title: S.ON_SCREEN(),
        settings: [
          {
            key: 'showLicenseNumber',
            label: O.SHOW_LICENSE_NUMBER.TITLE(),
            description: O.SHOW_LICENSE_NUMBER.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
          {
            key: 'resetBlackOnSwitch',
            label: O.RESET_BLACK_ON_SONG_SWITCH.TITLE(),
            description: O.RESET_BLACK_ON_SONG_SWITCH.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
        ],
      },
      {
        // Not the audience's screen — the operator's own window.
        id: 'control-view',
        title: S.CONTROL_VIEW(),
        settings: [
          {
            key: 'mediaPreviewAspect',
            label: O.MEDIA_PREVIEW_ASPECT.TITLE(),
            description: O.MEDIA_PREVIEW_ASPECT.DESCRIPTION(),
            control: {
              kind: 'select',
              options: [
                { value: '16:9', label: '16:9' },
                { value: '16:10', label: '16:10' },
                { value: '4:3', label: '4:3' },
              ],
            },
          },
          {
            key: 'windowFooterVisible',
            label: O.WINDOW_FOOTER_VISIBLE.TITLE(),
            description: O.WINDOW_FOOTER_VISIBLE.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
        ],
      },
    ],
  };

  const library: SettingsCategory = {
    id: 'library',
    label: LL.SETTINGS.GROUP_LIBRARY(),
    description: D.LIBRARY(),
    icon: LibraryIcon,
    sections: [
      {
        id: 'selecting',
        title: S.SELECTING(),
        settings: [
          {
            key: 'songClick',
            label: O.SONG_CLICK_BEHAVIOUR.TITLE(),
            description: O.SONG_CLICK_BEHAVIOUR.DESCRIPTION(),
            control: { kind: 'select', options: clickOptions },
          },
          {
            key: 'verseClick',
            label: O.VERSE_CLICK_BEHAVIOUR.TITLE(),
            description: O.VERSE_CLICK_BEHAVIOUR.DESCRIPTION(),
            control: { kind: 'select', options: clickOptions },
          },
          {
            key: 'touchDuration',
            label: O.TOUCH_DURATION.TITLE(),
            description: O.TOUCH_DURATION.DESCRIPTION(),
            control: { kind: 'number', min: 100, step: 50 },
          },
        ],
      },
      {
        id: 'editing',
        title: S.EDITING(),
        settings: [
          {
            key: 'defaultNewVerseName',
            label: O.DEFAULT_NEW_VERSE_NAME.TITLE(),
            description: O.DEFAULT_NEW_VERSE_NAME.DESCRIPTION(),
            control: { kind: 'text' },
          },
        ],
      },
      {
        id: 'languages',
        title: S.LANGUAGES(),
        render: ctx.slots.songLanguages,
        keywords: ['language', 'translation', 'sprache', 'uebersetzung'],
      },
      {
        id: 'importing',
        title: S.IMPORTING(),
        settings: [
          {
            key: 'overrideSongImport',
            label: O.OVERRIDE_SONG_BY_IMPORT.TITLE(),
            description: O.OVERRIDE_SONG_BY_IMPORT.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
          {
            key: 'showDeleteFromDb',
            label: O.SHOW_REMOVE_SONG_FROM_DATABASE.TITLE(),
            description: O.SHOW_REMOVE_SONG_FROM_DATABASE.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
        ],
      },
      {
        id: 'media',
        title: S.MEDIA(),
        settings: [
          {
            key: 'mediaPath',
            label: O.MEDIA_PATH.TITLE(),
            description: O.MEDIA_PATH.DESCRIPTION(),
            control: { kind: 'path' },
          },
        ],
      },
      {
        id: 'bible',
        title: S.BIBLE(),
        settings: [
          {
            key: 'bibleTranslation',
            label: O.BIBLE_TRANSLATION.TITLE(),
            description: O.BIBLE_TRANSLATION.DESCRIPTION(),
            control: { kind: 'text' },
          },
        ],
      },
    ],
  };

  const notifications: SettingsCategory = {
    id: 'notifications',
    label: LL.SETTINGS.GROUP_NOTIFICATIONS(),
    description: D.NOTIFICATIONS(),
    icon: NotificationsIcon,
    sections: [
      {
        id: 'toasts',
        title: S.TOASTS(),
        settings: [
          {
            key: 'notificationCount',
            label: O.NOTIFICATION_COUNT.TITLE(),
            description: O.NOTIFICATION_COUNT.DESCRIPTION(),
            control: { kind: 'number', min: 1, max: 10 },
          },
          {
            key: 'notificationTime',
            label: O.NOTIFICATION_DISAPPEAR_TIME.TITLE(),
            description: O.NOTIFICATION_DISAPPEAR_TIME.DESCRIPTION(),
            control: { kind: 'number', min: 500, step: 500 },
          },
          {
            key: 'uploadNotifications',
            label: O.SHOW_SONG_UPLOAD_NOTIFICATIONS.TITLE(),
            description: O.SHOW_SONG_UPLOAD_NOTIFICATIONS.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
          {
            key: 'errorBoundaryNotification',
            label: O.ERROR_BOUNDARY_NOTIFICATION.TITLE(),
            description: O.ERROR_BOUNDARY_NOTIFICATION.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
        ],
      },
      {
        id: 'confirmations',
        title: S.CONFIRMATIONS(),
        settings: [
          {
            key: 'confirmPageLeave',
            label: O.CONFIRM_PAGE_LEAVE.TITLE(),
            description: O.CONFIRM_PAGE_LEAVE.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
          {
            key: 'confirmShowDeletion',
            label: O.CONFIRM_SHOW_DELETION.TITLE(),
            description: O.CONFIRM_SHOW_DELETION.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
          {
            key: 'confirmShowOverwrite',
            label: O.CONFIRM_SHOW_OVERWRITE.TITLE(),
            description: O.CONFIRM_SHOW_OVERWRITE.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
          {
            key: 'confirmSongDelete',
            label: O.CONFIRM_SONG_DELETE.TITLE(),
            description: O.CONFIRM_SONG_DELETE.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
        ],
      },
    ],
  };

  const keyboard: SettingsCategory = {
    id: 'keyboard',
    label: LL.SETTINGS.GROUP_KEYBOARD(),
    description: D.KEYBOARD(),
    icon: KeyboardIcon,
    sections: [
      {
        id: 'mapping',
        render: () => ctx.slots.keyboardMapping(),
        keywords: [LL.KEYBOARD.MAPPING(), LL.KEYBOARD.MAPPING_ACTION(), LL.KEYBOARD.MAPPING_KEY()],
      },
    ],
  };

  const remoteSections: SettingsSection[] = [
    {
      id: 'remote-authority',
      settings: [
        {
          key: 'operatorSyncAuthority',
          label: LL.REMOTE.AUTHORITY_TITLE(),
          description: LL.REMOTE.AUTHORITY_HINT(),
          control: {
            kind: 'select',
            options: [
              { value: 'auto', label: LL.REMOTE.AUTHORITY_AUTO() },
              { value: 'always', label: LL.REMOTE.AUTHORITY_ALWAYS() },
              { value: 'never', label: LL.REMOTE.AUTHORITY_NEVER() },
            ],
          },
        },
      ],
    },
    {
      id: 'remote-commands',
      title: S.REMOTE_COMMANDS(),
      description: LL.REMOTE.SETTINGS_HINT(),
      render: () => ctx.slots.remoteCommands(),
      keywords: [LL.REMOTE.TITLE(), LL.REMOTE.OPEN_CONTROL()],
    },
  ];
  // The viewer token is issued by the backend, so it has no meaning while offline.
  if (!ctx.offlineMode) {
    remoteSections.push({
      id: 'viewer',
      render: () => ctx.slots.viewerToken(),
      keywords: [S.VIEWER(), LL.VIEWER_TOKEN.TITLE(), LL.VIEWER_TOKEN.DESCRIPTION()],
    });
  }
  remoteSections.push({
    id: 'audio-mixer',
    render: () => ctx.slots.audioMixer(),
    keywords: [S.AUDIO_MIXER(), LL.SETTINGS.AUDIO_MIXER_DESC(), 'mixer', 'monitor', 'x32', 'xair', 'behringer', 'audio', 'streamer'],
  });
  remoteSections.push({
    id: 'companion',
    title: S.COMPANION(),
    description: LL.SETTINGS.COMPANION_DESC(),
    render: () => ctx.slots.companion(),
    keywords: [LL.COMPANION.HELPER_TITLE(), LL.COMPANION.HELPER_DESC(), 'websocket', 'streamdeck'],
  });

  const remote: SettingsCategory = {
    id: 'remote',
    label: LL.SETTINGS.GROUP_REMOTE(),
    description: D.REMOTE(),
    icon: RemoteIcon,
    sections: remoteSections,
  };

  const desktop: SettingsCategory = {
    id: 'desktop',
    label: LL.SETTINGS.GROUP_DESKTOP(),
    description: D.DESKTOP(),
    icon: DesktopIcon,
    sections: ctx.isElectron
      ? [
          {
            id: 'updates',
            settings: [
              {
                key: 'autoCheckUpdates',
                label: O.AUTO_CHECK_UPDATES.TITLE(),
                description: O.AUTO_CHECK_UPDATES.DESCRIPTION(),
                control: { kind: 'boolean' },
              },
            ],
            render: () => ctx.slots.autoUpdater(),
            keywords: [S.UPDATES(), LL.UPDATER.TITLE()],
          },
          {
            id: 'windows',
            title: S.WINDOWS(),
            settings: [
              {
                key: 'restoreWindowsOnStart',
                label: O.RESTORE_WINDOWS_ON_START.TITLE(),
                description: O.RESTORE_WINDOWS_ON_START.DESCRIPTION(),
                control: { kind: 'boolean' },
              },
            ],
          },
          {
            id: 'credentials',
            render: () => ctx.slots.credentials(),
            keywords: [S.SIGN_IN(), LL.AUTH.SAVED_CREDENTIALS(), LL.AUTH.CREDENTIALS_DESCRIPTION()],
          },
        ]
      : [
          {
            id: 'get-desktop',
            title: S.GET_DESKTOP(),
            description: LL.DESKTOP_APP.MODAL_BODY(),
            render: () => ctx.slots.desktopDownload(),
            keywords: [LL.DESKTOP_APP.SETTINGS_SECTION(), LL.DESKTOP_APP.SETTINGS_DOWNLOAD()],
          },
        ],
  };

  const privacy: SettingsCategory = {
    id: 'privacy',
    label: LL.SETTINGS.GROUP_PRIVACY(),
    description: D.PRIVACY(),
    icon: PrivacyIcon,
    sections: [
      {
        id: 'metrics',
        title: S.METRICS(),
        description: LL.SETTINGS.PRIVACY_DESCRIPTION(),
        settings: [
          {
            key: 'metricsEnabled',
            label: O.METRICS_ENABLED.TITLE(),
            description: O.METRICS_ENABLED.DESCRIPTION(),
            control: { kind: 'boolean' },
          },
        ],
        render: () => ctx.slots.privacyNotice(),
      },
    ],
  };

  return [general, presentation, library, notifications, keyboard, remote, desktop, privacy];
};

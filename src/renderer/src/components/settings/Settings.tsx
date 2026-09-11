import { useMemo, useState } from 'react';
import {
  Box,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { Close as CloseIcon, Search as SearchIcon, Clear as ClearIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetSettings } from '@/store/settingsSlice';
import { KeyboardMappingEditor } from '@/components/settings/KeyboardMappingEditor';
import { exportSettings, importSettings, applyImportedSettings, type SettingsDiff } from '@/utils/settingsExport';
import { CompanionHelper } from '@/components/settings/CompanionHelper';
import { AudioMixerSection } from '@/components/settings/AudioMixerSection';
import { BandsSection } from '@/components/settings/BandsSection';
import { SettingsImportReview } from '@/components/settings/SettingsImportReview';
import { DesktopAppDownloadModal } from '@/components/settings/DesktopAppBanner';
import { AutoUpdaterSection } from '@/components/settings/AutoUpdaterSection';
import { CredentialsSection } from '@/components/settings/CredentialsSection';
import { ViewerTokenSection } from '@/components/settings/ViewerTokenSection';
import { SettingRow } from '@/components/settings/SettingRow';
import {
  BackupBlock,
  CompanionBlock,
  DesktopDownloadBlock,
  GlobalStyleRow,
  PrivacyNoticeBlock,
  RemoteCommandsBlock,
  ShowTitleTemplateRow,
  SongLanguagesBlock,
} from '@/components/settings/SettingsBlocks';
import { buildSettingsCatalog, type SettingsCategory, type SettingsSection } from '@/components/settings/settingsCatalog';
import { isElectronApp } from '@/utils';

const NAV_WIDTH = 210;

/**
 * The settings panel: a category list on the left, the settings of one category on the
 * right, and a search that cuts across both. What it can show comes from the catalog
 * (`settingsCatalog.tsx`) — this file only decides how it is laid out and searched.
 */
export const Settings = (props: { open: boolean; setOpen: (open: boolean) => void }) => {
  const { LL } = useI18nContext();
  const theme = useTheme();
  const settings = useGetSettings();
  // Below this the two panes do not both fit; the categories become a tab strip on top.
  const stacked = useMediaQuery(theme.breakpoints.down('md'));

  const [query, setQuery] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState('general');
  const [companionOpen, setCompanionOpen] = useState(false);
  const [desktopAppModalOpen, setDesktopAppModalOpen] = useState(false);
  /** Pending settings import — reviewed in a diff dialog before anything is applied. */
  const [importDiff, setImportDiff] = useState<SettingsDiff | null>(null);

  const categories = buildSettingsCatalog(LL, {
    isElectron: isElectronApp(),
    offlineMode: settings.offlineMode,
    slots: {
      globalStyle: () => <GlobalStyleRow />,
      showTitleTemplate: () => <ShowTitleTemplateRow />,
      bands: () => <BandsSection />,
      songLanguages: () => <SongLanguagesBlock />,
      viewerToken: () => <ViewerTokenSection />,
      remoteCommands: () => <RemoteCommandsBlock />,
      keyboardMapping: () => <KeyboardMappingEditor />,
      companion: () => <CompanionBlock onOpen={() => setCompanionOpen(true)} />,
      audioMixer: () => <AudioMixerSection />,
      autoUpdater: () => <AutoUpdaterSection />,
      credentials: () => <CredentialsSection />,
      desktopDownload: () => <DesktopDownloadBlock onOpen={() => setDesktopAppModalOpen(true)} />,
      backup: () => (
        <BackupBlock
          onExport={() => exportSettings()}
          onImport={async () => {
            // The review dialog lists every setting that would change, which a confirm()
            // with a bare count never could. It renders the "nothing to import" case too.
            const diff = await importSettings();
            if (diff) setImportDiff(diff);
          }}
        />
      ),
      privacyNotice: () => <PrivacyNoticeBlock />,
    },
  });

  const results = useSearchResults(categories, query);
  const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? categories[0];

  return (
    <Drawer open={props.open} onClose={() => props.setOpen(false)} anchor="right">
      <CompanionHelper open={companionOpen} onClose={() => setCompanionOpen(false)} />
      <DesktopAppDownloadModal open={desktopAppModalOpen} onClose={() => setDesktopAppModalOpen(false)} />
      <SettingsImportReview
        open={!!importDiff}
        diff={importDiff}
        onCancel={() => setImportDiff(null)}
        onConfirm={async () => {
          const diff = importDiff;
          setImportDiff(null);
          if (diff) await applyImportedSettings(diff);
        }}
      />

      <Stack sx={{ width: { xs: '100vw', md: 'min(96vw, 920px)' }, height: '100%' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2, pt: 2, pb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>
            {LL.SETTINGS.SETTINGS()}
          </Typography>
          <TextField
            size="small"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={LL.SETTINGS.FILTER()}
            sx={{ width: { xs: 160, sm: 260 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                  </InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton size="small" aria-label={LL.SETTINGS.SEARCH_CLEAR()} onClick={() => setQuery('')}>
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
          <IconButton onClick={() => props.setOpen(false)} aria-label={LL.COMMON.CLOSE()}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <Divider />

        {/* Searching cuts across every category, so the category nav steps aside for it. */}
        {results ? (
          <Box sx={{ flex: 1, overflow: 'auto', px: { xs: 2, md: 3 }, py: 2 }}>
            <SearchResults results={results} query={query} />
          </Box>
        ) : stacked ? (
          <Stack sx={{ flex: 1, minHeight: 0 }}>
            <Tabs
              value={activeCategory.id}
              onChange={(_, id) => setActiveCategoryId(id)}
              variant="scrollable"
              scrollButtons="auto"
              sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 44 }}
            >
              {categories.map((category) => (
                <Tab key={category.id} value={category.id} label={category.label} sx={{ minHeight: 44, textTransform: 'none' }} />
              ))}
            </Tabs>
            <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 2 }}>
              <CategoryPanel category={activeCategory} showHeading={false} />
            </Box>
          </Stack>
        ) : (
          <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
            <List dense sx={{ width: NAV_WIDTH, flexShrink: 0, borderRight: 1, borderColor: 'divider', overflow: 'auto', py: 1 }}>
              {categories.map((category) => {
                const Icon = category.icon;
                return (
                  <ListItemButton
                    key={category.id}
                    selected={category.id === activeCategory.id}
                    onClick={() => setActiveCategoryId(category.id)}
                    sx={{ borderRadius: 1, mx: 1, mb: 0.25 }}
                  >
                    <ListItemIcon sx={{ minWidth: 34 }}>
                      <Icon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText slotProps={{ primary: { variant: 'body2' } }} primary={category.label} />
                  </ListItemButton>
                );
              })}
            </List>
            <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
              <CategoryPanel category={activeCategory} showHeading />
            </Box>
          </Stack>
        )}
      </Stack>
    </Drawer>
  );
};

/** One category: its heading, then each of its sections. */
const CategoryPanel = ({ category, showHeading }: { category: SettingsCategory; showHeading: boolean }) => {
  const { LL } = useI18nContext();
  const sections = category.sections;

  return (
    <Stack spacing={1}>
      {showHeading && (
        <Box sx={{ pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {category.label}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {category.description}
          </Typography>
        </Box>
      )}
      {sections.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {LL.SETTINGS.NOTHING_HERE()}
        </Typography>
      ) : (
        sections.map((section, index) => <SectionBlock key={section.id} section={section} divider={index > 0} />)
      )}
    </Stack>
  );
};

const SectionBlock = ({ section, divider }: { section: SettingsSection; divider: boolean }) => (
  <Box>
    {divider && <Divider sx={{ my: 1.5 }} />}
    {section.title && (
      <Typography variant="subtitle2" sx={{ fontWeight: 600, pt: 0.5 }}>
        {section.title}
      </Typography>
    )}
    {section.description && (
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', pb: 0.5 }}>
        {section.description}
      </Typography>
    )}
    {section.settings?.map((def) => (
      <SettingRow key={def.key} def={def} />
    ))}
    {section.render?.()}
  </Box>
);

type SearchHit = { category: SettingsCategory; sections: SettingsSection[] };

/**
 * Search across every category. A row matches on its label, description or storage key;
 * a block that is not made of rows matches on its heading, its blurb or its keywords, and
 * is then shown whole — half a keyboard editor would help nobody.
 *
 * Returns null when there is nothing to search for, which is what puts the panel back
 * into its normal category view.
 */
const useSearchResults = (categories: SettingsCategory[], query: string): SearchHit[] | null =>
  useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const hit = (text?: string) => !!text && text.toLowerCase().includes(needle);

    const results: SearchHit[] = [];
    for (const category of categories) {
      const sections: SettingsSection[] = [];
      for (const section of category.sections) {
        const sectionMatches = hit(section.title) || hit(section.description) || (section.keywords ?? []).some((keyword) => hit(keyword));
        if (sectionMatches) {
          sections.push(section);
          continue;
        }
        const settings = (section.settings ?? []).filter((def) => hit(def.label) || hit(def.description) || hit(def.key));
        // Keep the row, drop the custom block: it did not match, and it is rarely small.
        if (settings.length > 0) sections.push({ ...section, settings, render: undefined });
      }
      if (sections.length > 0) results.push({ category, sections });
    }
    return results;
  }, [categories, query]);

const SearchResults = ({ results, query }: { results: SearchHit[]; query: string }) => {
  const { LL } = useI18nContext();

  if (results.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {LL.SETTINGS.SEARCH_NO_RESULTS({ query })}
      </Typography>
    );
  }

  const count = results.reduce(
    (total, hit) => total + hit.sections.reduce((n, section) => n + (section.settings?.length ?? (section.render ? 1 : 0)), 0),
    0,
  );

  return (
    <Stack spacing={2}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {LL.SETTINGS.SEARCH_RESULT_COUNT({ count })}
      </Typography>
      {results.map(({ category, sections }) => {
        const Icon = category.icon;
        return (
          <Box key={category.id}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 0.5 }}>
              <Icon fontSize="small" sx={{ color: 'text.secondary' }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                {category.label}
              </Typography>
            </Stack>
            {sections.map((section) => (
              <SectionBlock key={section.id} section={section} divider={false} />
            ))}
          </Box>
        );
      })}
    </Stack>
  );
};

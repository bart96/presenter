import { Alert, Box, Button, FormControlLabel, IconButton, Stack, Switch, Tooltip, Typography } from '@mui/material';
import { Add as AddIcon, Delete as RemoveIcon, Visibility as VisibleIcon, VisibilityOff as HiddenIcon } from '@mui/icons-material';
import { PropCard } from '@/components/style/StyleFormPrimitives';
import { LanguageStyleEditor } from '@/components/style/LanguageStyleEditor';
import { readLanguageEntries, type InheritedSource, type StyleFormCtx } from '@/components/style/styleFormContext';
import { DEFAULT_STYLE } from '@/utils/styleUtils';
import { MAIN_LANGUAGE_SLOT } from '@/utils/languageSlots';

/**
 * The language slots of a style: how each of a song's languages looks, and whether it is shown.
 *
 * The slots are **positional**, not named. Slot 1 is whichever language the song lists first,
 * slot 2 its second, and so on — the song decides which languages those actually are. A style
 * that says "language 2: italic, 70% opacity" is therefore right for an English song with a
 * German translation and for a German song with an English one, without being edited or
 * duplicated.
 *
 * Language 1 is one of the list rather than a separate "Appearance" panel elsewhere. It is
 * where the typography every line inherits actually lives, and splitting it off made the
 * relationship between the main text and its translations impossible to see at a glance.
 */
export const LanguagesSection = ({ ctx }: { ctx: StyleFormCtx }) => {
  const { LL, updateProp, styleData, setStyleData, setIsDirty } = ctx;

  const entries = readLanguageEntries(ctx);

  /**
   * Where a slot's typography comes from when it sets nothing of its own.
   *
   * A slot is not a cascade property, so the usual "app default then global style" chain does
   * not apply. What it actually falls back to is the main slot — the baseline every line
   * inherits — and below that the app's own default.
   */
  const inheritedForSlot = (slot: number) => (field: keyof (typeof entries)[number]) => {
    const levels: InheritedSource[] = [];
    const appDefault = (DEFAULT_STYLE as Record<string, unknown>)[field as string];

    if (appDefault !== undefined) levels.push({ source: LL.STYLE.INHERITED_FROM_DEFAULT(), value: appDefault });

    if (slot !== MAIN_LANGUAGE_SLOT) {
      const main = entries.find((entry) => entry.slot === MAIN_LANGUAGE_SLOT) as unknown as Record<string, unknown> | undefined;
      // Bold, italic and underline share one toggle, so the flag is not always field + Enabled.
      const flag = field === 'fontBold' || field === 'fontItalic' || field === 'fontUnderline' ? 'fontStyleEnabled' : `${field}Enabled`;

      if (main?.[flag] && main[field as string] !== undefined) {
        levels.push({ source: LL.STYLE.SLOT_MAIN(), value: main[field as string] });
      }
    }

    return levels;
  };

  const writeAll = (list: typeof entries) =>
    updateProp('languageStyles', { enabled: true, value: [...list].sort((a, b) => a.slot - b.slot) });

  const updateSlot = (slot: number, patch: Partial<(typeof entries)[number]>) =>
    writeAll(entries.map((entry) => (entry.slot === slot ? { ...entry, ...patch } : entry)));

  /**
   * Slots are consecutive, so the next one is always one past the highest in use.
   *
   * Computed inside the state update rather than from the rendered list: two clicks in the same
   * render both saw the same highest slot and produced a single entry.
   */
  const addSlot = () => {
    setStyleData((prev) => {
      const current = prev.languageStyles?.value ?? [{ slot: MAIN_LANGUAGE_SLOT }];
      const next = Math.max(MAIN_LANGUAGE_SLOT, ...current.map((entry) => entry.slot)) + 1;

      return { ...prev, languageStyles: { enabled: true, value: [...current, { slot: next }].sort((a, b) => a.slot - b.slot) } };
    });
    setIsDirty(true);
  };

  /**
   * Removing a slot closes the gap behind it. Leaving a hole would silently re-point every
   * later slot at a different language, since a slot means "the Nth language of the song".
   */
  const removeSlot = (slot: number) =>
    writeAll(
      entries.filter((entry) => entry.slot !== slot).map((entry) => (entry.slot > slot ? { ...entry, slot: entry.slot - 1 } : entry)),
    );

  return (
    <>
      {entries.map((entry) => {
        const isMain = entry.slot === MAIN_LANGUAGE_SLOT;
        const shown = entry.visible !== false;

        return (
          <PropCard
            key={entry.slot}
            title={isMain ? LL.STYLE.SLOT_MAIN() : LL.STYLE.SLOT_LABEL({ n: entry.slot })}
            dimmed={!shown}
            action={
              <Stack direction="row" spacing={0}>
                <Tooltip title={shown ? LL.STYLE.SLOT_HIDE() : LL.STYLE.SLOT_SHOW()}>
                  <IconButton size="small" onClick={() => updateSlot(entry.slot, { visible: !shown })}>
                    {shown ? <VisibleIcon sx={{ fontSize: 18 }} /> : <HiddenIcon sx={{ fontSize: 18 }} color="disabled" />}
                  </IconButton>
                </Tooltip>
                {/* Slot 1 has no remove: a song always has a first language. */}
                {!isMain && (
                  <Tooltip title={LL.STYLE.LANG_REMOVE()}>
                    <IconButton size="small" onClick={() => removeSlot(entry.slot)} color="error">
                      <RemoveIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            }
          >
            {isMain && (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', pb: 1, px: 1 }}>
                {LL.STYLE.SLOT_MAIN_HINT()}
              </Typography>
            )}
            {!shown && (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', pb: 1, px: 1 }}>
                {LL.STYLE.SLOT_HIDDEN_HINT()}
              </Typography>
            )}
            <LanguageStyleEditor
              entry={entry}
              onChange={(patch) => updateSlot(entry.slot, patch)}
              inheritedFor={inheritedForSlot(entry.slot)}
              isMainSlot={isMain}
              LL={LL}
            />
          </PropCard>
        );
      })}

      <PropCard>
        <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>
          {LL.STYLE.SLOT_EXPLAINER()}
        </Alert>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
          <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addSlot}>
            {LL.STYLE.SLOT_ADD()}
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={styleData.showAllLanguages ?? false}
                onChange={(e) => {
                  setStyleData((prev) => ({ ...prev, showAllLanguages: e.target.checked }));
                  setIsDirty(true);
                }}
              />
            }
            label={<Typography variant="caption">{LL.STYLE.SHOW_OTHER_LANGUAGES()}</Typography>}
            sx={{ ml: 0 }}
          />
        </Stack>
      </PropCard>
    </>
  );
};

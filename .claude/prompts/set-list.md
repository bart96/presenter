# Feature: Set Lists

## Overview

Add a new feature called **Set Lists** to the song presenter. A Set List is an account-scoped, reusable collection of song entries that helps users organize songs for different bands, projects, tours, seasons, or event types such as Christmas.

Each account can own multiple Set Lists. A Set List contains references to songs from the existing song library, plus per-entry metadata that belongs only to that Set List context and does not modify the base song.

## Goal

The goal of this feature is to let users organize reusable song collections, quickly switch between them, group entries by contextual tags, and transfer entries into the current Agenda / Show while preserving Set List-specific metadata such as key and block-order selection.

## In scope

- Multiple Set Lists per account.
- Set List manager can be opened via an icon in the agenda sidebar between "mobile control page" and "musician view"
- Horizontally scrollable tab-like selector for switching Set Lists.
- Add songs from the existing song library into a Set List.
- If the same Song is added multiple times to the same Set List, it is treated as the same Set List Entry with different, independent tag assignments.
- Highlight items that are already present in the current Show / Agenda.
- Per-entry Set List metadata via tag assignments:
  - Optional literal key string, for example `Bb`.
  - Optional existing block-order name from the song system.
  - One or more tags assigned to that Set List Entry.
- Use autocomplete inputs where appropriate so assigning tags, keys, and block-order names is faster and more consistent.
- Search input in the Set List view with two modes:
  - Filter mode: filters songs already inside the currently open Set List.
  - Import mode: searches the song library to add songs into the currently open Set List.
- Tag-based display using accordion subsections.
- Quick action to add a Set List entry to the current Agenda / Show.
- Persist the last opened Set List and accordion open/closed states inside the existing local settings object that is already exported and imported.

## Out of scope

- Collaborative sharing between accounts.
- Automatic set duration planning.

## Terminology and rules

- A **Song** is the existing base song entity in the song library.
- A **Set List** is a reusable collection owned by one account.
- A **Set List Entry** is the single Set List representation of one Song inside one Set List.
- A **Tag Assignment** is the combination of one Set List Entry and one tag, including tag-specific playback metadata.
- If the same Song is assigned to multiple tags inside the same Set List, this does not create multiple Set List Entries; it creates one Set List Entry with multiple Tag Assignments.
- Tags belong to the **Set List Entry** context, not to the global Song.
- The key shown for a Tag Assignment is a literal display key string such as `Bb`.
- Block order must reuse the already existing named block orders from the application for consistency.
- Because songs already store block orders by name, Tag Assignments should store `blockOrderName` rather than `blockOrderId`.
- No new free-text block-order naming system may be introduced inside Set Lists.
- Existing domain terminology and existing value formats should be reused wherever possible to keep the implementation consistent and reduce ambiguity.

## Functional requirements

### 1. Set List management

Users can create, rename, delete, and switch between multiple Set Lists within their account. Set Lists are selected through a horizontally scrollable tab-like selector.

If many Set Lists exist, the selector must remain usable through horizontal scrolling rather than wrapping into multiple lines. The currently active Set List must be visually distinct.

### 2. Add songs to Set List

Users can add songs from the song library into the currently selected Set List. Inside one Set List, one Song should correspond to one Set List Entry, which can then receive one or more Tag Assignments.

If a user attempts to add the same Song again to the same Set List, the system should treat that as extending the existing Set List Entry with additional independent Tag Assignments rather than creating a second separate Set List Entry for the same Song.

Each Tag Assignment stores its own optional key and optional block-order name so the same Song can be prepared differently depending on tag context.

### 3. Autocomplete-assisted metadata entry

Where tags, keys, or block-order names are assigned, the UI should use autocomplete-style controls to reduce typing effort and improve consistency. Reusing existing values and visible suggestion patterns helps maintain terminology consistency and reduces ambiguous inputs.

Expected behavior:

- Tag inputs suggest existing tags already used in the current Set List, and optionally previously used tags if such data already exists.
- Key inputs suggest common or previously used literal keys.
- Block-order inputs suggest and select from the already existing named block orders available in the application.
- Free-text block-order creation is not allowed from this UI.

### 4. Search behavior

The Set List view contains a single search input with a visible mode control located to the left of the input. The mode control determines whether the search input is used for filtering the current Set List or searching the song library for import. Explicit filter scope improves usability for search and filter interfaces.

- In **Filter mode**, results are limited to entries already present in the active Set List.
- In **Import mode**, results are limited to the global song library and allow adding the selected Song to the active Set List.
- The active mode must always be visually obvious.
- If no results are found, show a clear empty state appropriate to the current mode.

### 5. Tag grouping and accordion display

Songs in the active Set List are shown in tag-based subsections. Each subsection is rendered as an expandable accordion section. Persisted view state such as accordion expansion is a valid UI behavior as long as it is stored predictably and scoped clearly.

If a Set List Entry has multiple Tag Assignments, it must appear in each relevant tag subsection. These repeated appearances are intentional because each Tag Assignment may carry different playback metadata such as key and block-order name.

If a Set List Entry has no tags, it must appear in a default `Untagged` subsection. Accordion state is stored per Set List.

### 6. Agenda / Show integration

Each Set List Entry occurrence provides a quick action such as **Add to Agenda**. When triggered from a tag subsection, the created Agenda item must copy:

- the referenced base Song,
- the key override associated with that specific Tag Assignment,
- the selected existing block-order name associated with that specific Tag Assignment.

This means the agenda payload may differ depending on from which tag subsection the song is added, because playback can vary by event context such as Christmas or shorter non-seasonal versions.

Items that are already present in the current Show / Agenda must be visually highlighted inside the Set List UI so users can see which entries are already planned.

### 7. Removing songs or tags

When a user removes a song from a Set List and that song is assigned to multiple tags, the UI must show a popover confirmation dialog. The dialog must ask whether the user wants to remove only the current Tag Assignment or remove the Song from the Set List entirely.

Expected options:

- **Remove tag only**: remove only the current Tag Assignment and keep the Set List Entry and other Tag Assignments.
- **Remove song entirely**: remove the full Set List Entry and all related Tag Assignments from the Set List.

If the song has only one Tag Assignment, the system may skip this choice and remove the full association directly, or still show a simplified confirmation dialog if that matches existing application behavior.

### 8. Local settings persistence

The feature must reuse the existing local settings object that is already stored in localStorage and is already included in export/import behavior. The goal is to avoid creating many additional top-level localStorage keys.

The following state must be persisted:

- Last opened Set List.
- Accordion open/closed states for tag subsections, scoped per Set List.

Recommended shape:

- `settings.setLists.lastOpenedSetListId`
- `settings.setLists.accordionStateBySetListId[setListId][tagName] = true | false`

## Data model

### SetList

- `id`
- `accountId`
- `name`
- `createdAt`
- `updatedAt`

### SetListEntry

- `id`
- `setListId`
- `songId`
- `createdAt`
- `updatedAt`

### SetListEntryTagAssignment

- `id`
- `setListEntryId`
- `tagName`
- `customKey` nullable
- `blockOrderName` nullable, stores an existing named block order already used by songs

### Settings

- `settings.setLists.lastOpenedSetListId`
- `settings.setLists.accordionStateBySetListId`

## UX behavior

### Set List selector

- Render as horizontally scrollable tabs.
- Active Set List is highlighted.
- Switching tabs loads that Set List and updates the persisted last-opened value.

### Search area

- Place a mode button or switch to the left of the search field.
- The control clearly indicates either **Filter** or **Import** mode.
- Placeholder text should adapt to the selected mode, for example:
  - Filter mode: `Filter songs in this set list`
  - Import mode: `Search song library to add songs`

### Metadata inputs

- Use autocomplete inputs or combobox-style fields where values benefit from reuse or suggestion.
- Tags should be fast to assign with suggestions.
- Existing named block orders should be selectable from suggestions rather than entered manually.
- Key entry should support quick completion from known or recent values.

### Tag accordions

- Each tag has its own accordion subsection.
- Untagged entries are grouped in `Untagged`.
- If one Set List Entry has multiple Tag Assignments, it appears in all matching subsections.
- Expanding and collapsing subsections updates persisted state for the active Set List.

### Highlighting

- If an item is already in the current Show / Agenda, the corresponding visible item in the Set List UI should be highlighted.
- The highlight should be clear enough to support fast visual scanning without making the row look disabled.

### Removal interaction

- Removing from a multi-tag context opens a popover confirmation dialog with explicit choices.
- The dialog text must clearly distinguish between removing only the current Tag Assignment and removing the full Song from the Set List.

## Edge cases

- If the persisted last opened Set List no longer exists, fall back to no selection or the first available Set List.
- If persisted accordion state references tags that no longer exist, ignore those stored values.
- If the same Song is assigned to multiple tags in one Set List, it remains one Set List Entry with multiple independent Tag Assignments.
- If the same Set List Entry appears in multiple tag subsections, adding it to the Agenda from different subsections may create different agenda payloads because key and block-order name are defined per Tag Assignment.
- If a block-order name is renamed in the main song system, behavior should follow the same name-based consistency model already used by songs.
- If a highlighted item already exists in the current Show / Agenda more than once, the highlight should still remain deterministic and not break row actions.

## Acceptance criteria

### Checklist

- An account can create, rename, delete, and switch between multiple Set Lists.
- Set Lists are switched through a horizontally scrollable tab-like selector.
- A user can add Songs from the song library into the active Set List.
- Inside one Set List, one Song is represented by one Set List Entry and may have multiple independent Tag Assignments.
- Items already present in the current Show / Agenda are highlighted in the Set List UI.
- Metadata entry for tags, keys, and block-order names uses autocomplete-style controls where appropriate.
- Each Set List Entry can be assigned one or more tags.
- Key and block-order name are stored per Tag Assignment so the same song can be prepared differently depending on tag context.
- Each Tag Assignment can store an optional literal key string such as `Bb`.
- Each Tag Assignment can store an optional existing block-order name from the application.
- Set Lists do not introduce new free-text block-order names.
- The Set List view provides a search input with a visible mode switch between Filter and Import.
- In Filter mode, the search only filters entries already in the active Set List.
- In Import mode, the search queries the global song library for adding Songs to the active Set List.
- Songs are displayed in tag-based accordion subsections.
- A Set List Entry with multiple Tag Assignments appears in multiple subsections.
- Entries without tags appear in `Untagged`.
- Accordion open/closed state is stored per Set List in the existing settings object.
- The last opened Set List is stored in the existing settings object.
- Clicking **Add to Agenda** from a tag subsection copies the Song reference, tag-specific key override, and tag-specific selected block-order name into the Agenda item.
- Removing a song from a multi-tag situation shows a popover dialog with options to remove only the current Tag Assignment or the full Song from the Set List.
- The feature does not include collaborative sharing or automatic set duration planning.

### Given / When / Then

- **Given** an account with multiple Set Lists, **when** the user selects a Set List tab, **then** that Set List becomes active and is stored as the last opened Set List.
- **Given** the Set List view is in Filter mode, **when** the user enters text, **then** only entries inside the active Set List are filtered.
- **Given** the Set List view is in Import mode, **when** the user enters text, **then** the app searches the song library and allows adding matching Songs into the active Set List.
- **Given** a Set List Entry has Tag Assignments `Christmas` and `Fast`, **when** the Set List is displayed, **then** that same entry appears in both accordion subsections.
- **Given** the `Christmas` Tag Assignment has key `Bb` and block-order name `Christmas Short`, **when** the user clicks **Add to Agenda** from the `Christmas` subsection, **then** the created Agenda item contains the Song reference, key `Bb`, and block-order name `Christmas Short`.
- **Given** the `Fast` Tag Assignment of the same Set List Entry has different playback metadata, **when** the user clicks **Add to Agenda** from the `Fast` subsection, **then** the created Agenda item contains the Song reference and the metadata defined for the `Fast` Tag Assignment.
- **Given** a Set List Entry has no tags, **when** the Set List is displayed, **then** the entry appears in the `Untagged` subsection.
- **Given** the user expands or collapses tag accordions in one Set List, **when** the state is persisted and the user returns later, **then** the accordion state is restored for that Set List only.
- **Given** a Song has multiple Tag Assignments, **when** the user removes it from one tag subsection, **then** a popover asks whether to remove only that Tag Assignment or remove the full Song from the Set List entirely.

## Notes

This feature intentionally treats Set Lists as a reusable planning layer on top of the existing Song library rather than as a separate song model. The updated design keeps existing domain terms, reuses existing named block orders in the same name-based format already used by songs, and allows playback metadata to vary by tag context when that better reflects real event usage.

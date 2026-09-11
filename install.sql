START TRANSACTION;

-- --------------------------------------------------------
-- Accounts / Tenants
-- --------------------------------------------------------
CREATE TABLE `account` (
  `license` int(11) NOT NULL,
  `mail` varchar(200) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `name` varchar(200) DEFAULT NULL,
  `default_style_id` int DEFAULT NULL,
  `default_language` varchar(10) DEFAULT 'EN',
  `show_title_template` varchar(200) DEFAULT 'Show {dd}.{MM}.{yyyy}',
  `window_names` JSON DEFAULT NULL,
  `musician_names` JSON DEFAULT NULL,
  `languages` JSON DEFAULT NULL,
  `church_tools_url` VARCHAR(500) DEFAULT NULL,
  `church_tools_token` VARCHAR(500) DEFAULT NULL,
  `viewer_token` VARCHAR(64) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `lastactivity` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`license`),
  UNIQUE KEY `uk_account_viewer_token` (`viewer_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- OIDC Providers
-- --------------------------------------------------------
CREATE TABLE `oidc_providers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(200) NOT NULL,
  `discovery_url` varchar(500) NOT NULL,
  `client_id` varchar(300) NOT NULL,
  `client_secret` varchar(300) NOT NULL,
  `scopes` varchar(300) NOT NULL DEFAULT 'openid email profile',
  `required_group` varchar(200) DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_oidc_providers_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Which providers are available for which license
CREATE TABLE `account_oidc_providers` (
  `license` int(11) NOT NULL,
  `provider_id` int(11) NOT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`license`,`provider_id`),
  KEY `fk_aop_provider` (`provider_id`),
  CONSTRAINT `fk_aop_account` FOREIGN KEY (`license`) REFERENCES `account` (`license`) ON DELETE CASCADE,
  CONSTRAINT `fk_aop_provider` FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Styles Library
-- --------------------------------------------------------
CREATE TABLE `styles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `enabled` TINYINT(1) DEFAULT 1,
  `data` JSON NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_styles_account_name` (`account`, `name`),
  CONSTRAINT `fk_styles_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Window-name-specific style overrides
CREATE TABLE `style_window_overrides` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `style_id` INT NOT NULL,
  `window_name` VARCHAR(200) NOT NULL,
  `override_style_id` INT NOT NULL,
  UNIQUE KEY `uk_swo` (`style_id`, `window_name`),
  CONSTRAINT `fk_swo_style` FOREIGN KEY (`style_id`)
    REFERENCES `styles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_swo_override` FOREIGN KEY (`override_style_id`)
    REFERENCES `styles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Songs
-- --------------------------------------------------------
CREATE TABLE `songs` (
  `account` int(11) NOT NULL,
  `songnumber` int(11) NOT NULL,
  `title` varchar(300) NOT NULL,
  `authors` varchar(300) NOT NULL,
  `copyright` varchar(600) NOT NULL,
  `ccli_number` varchar(50) DEFAULT NULL,
  `song_key` varchar(10) DEFAULT NULL,
  `initialOrder` varchar(150) NOT NULL,
  `order` JSON NOT NULL,
  `background` varchar(300) DEFAULT NULL,
  `css` mediumtext DEFAULT NULL,
  `style_id` INT DEFAULT NULL,
  `languages` JSON DEFAULT NULL,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`account`,`songnumber`),
  CONSTRAINT `fk_songs_account` FOREIGN KEY (`account`) REFERENCES `account` (`license`) ON DELETE CASCADE,
  CONSTRAINT `fk_songs_style` FOREIGN KEY (`style_id`) REFERENCES `styles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Song Blocks
-- --------------------------------------------------------
CREATE TABLE `blocks` (
  `account` int(11) NOT NULL,
  `songnumber` int(11) NOT NULL,
  `type` varchar(60) NOT NULL,
  `text` mediumtext NOT NULL,
  KEY `fk_song` (`account`,`songnumber`),
  CONSTRAINT `fk_blocks_song` FOREIGN KEY (`account`, `songnumber`) REFERENCES `songs` (`account`, `songnumber`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Shows / Set-Lists
-- --------------------------------------------------------
CREATE TABLE `shows` (
  `account` int(11) NOT NULL,
  `title` varchar(200) NOT NULL,
  `date` timestamp NOT NULL DEFAULT current_timestamp(),
  `order` JSON NOT NULL,
  `groups` JSON DEFAULT NULL,
  `style_id` INT DEFAULT NULL,
  `event_id` INT DEFAULT NULL,
  `event_name` VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`account`,`title`),
  CONSTRAINT `fk_shows_account` FOREIGN KEY (`account`) REFERENCES `account` (`license`) ON DELETE CASCADE,
  CONSTRAINT `fk_shows_style` FOREIGN KEY (`style_id`) REFERENCES `styles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Usage Metrics
-- --------------------------------------------------------
CREATE TABLE `metrics` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `user_sub` VARCHAR(200) DEFAULT NULL,
  `event` VARCHAR(100) NOT NULL,
  `entity_type` VARCHAR(50) DEFAULT NULL,
  `entity_id` VARCHAR(200) DEFAULT NULL,
  `metadata` JSON DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_metrics_account` (`account`),
  INDEX `idx_metrics_event` (`event`),
  INDEX `idx_metrics_created` (`created_at`),
  CONSTRAINT `fk_metrics_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Show Item Type Configuration
-- --------------------------------------------------------
CREATE TABLE `show_item_types` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `type_key` VARCHAR(50) NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `color` VARCHAR(20) NOT NULL DEFAULT '#1976d2',
  `icon` VARCHAR(50) NOT NULL DEFAULT 'MusicNote',
  `is_default` TINYINT(1) DEFAULT 0,
  UNIQUE KEY `uk_sit_account_type` (`account`, `type_key`),
  CONSTRAINT `fk_sit_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Fulltext Indices
-- --------------------------------------------------------
ALTER TABLE `blocks` ADD FULLTEXT KEY `text` (`text`);
ALTER TABLE `songs` ADD FULLTEXT KEY `title` (`title`);

-- --------------------------------------------------------
-- PDF Area Mappings (musician block → PDF region mapping)
-- --------------------------------------------------------
CREATE TABLE `pdf_area_mappings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `songnumber` INT NOT NULL,
  `filename` VARCHAR(300) NOT NULL,
  `mappings` JSON NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Regions describe the PDF itself, so they are shared by everyone who opens that file.
  -- (Annotation layers are the per-musician part — see pdf_annotations.layer.)
  UNIQUE KEY `uk_pam` (`account`, `songnumber`, `filename`),
  CONSTRAINT `fk_pam_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Account default style FK (added after styles table exists)
-- --------------------------------------------------------
ALTER TABLE `account`
  ADD CONSTRAINT `fk_account_style` FOREIGN KEY (`default_style_id`)
    REFERENCES `styles` (`id`) ON DELETE SET NULL;

-- --------------------------------------------------------
-- PDF Annotations (one row per annotation, database-backed)
-- --------------------------------------------------------
CREATE TABLE `pdf_annotations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `songnumber` INT NOT NULL,
  `filename` VARCHAR(300) NOT NULL,
  `layer` VARCHAR(200) NOT NULL,
  `tool` VARCHAR(20) NOT NULL,
  `page` INT NOT NULL,
  `x` DOUBLE NOT NULL,
  `y` DOUBLE NOT NULL,
  `color` VARCHAR(20) NOT NULL DEFAULT '#ff0000',
  `opacity` DOUBLE NOT NULL DEFAULT 1.0,
  `sort_order` INT NOT NULL DEFAULT 0,
  `data` JSON NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_pa_layer_order` (`account`, `songnumber`, `filename`, `layer`, `sort_order`),
  CONSTRAINT `fk_pa_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Set Lists (reusable planning layer on top of the song library)
-- --------------------------------------------------------
CREATE TABLE `set_lists` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_set_lists_account_name` (`account`, `name`),
  CONSTRAINT `fk_set_lists_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- One Set List Entry per (set list, song). `account` is carried so the row can point at
-- the composite songs(account, songnumber) key.
CREATE TABLE `set_list_entries` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `set_list_id` INT NOT NULL,
  `account` INT NOT NULL,
  `songnumber` INT NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_sle_list_song` (`set_list_id`, `songnumber`),
  KEY `idx_sle_song` (`account`, `songnumber`),
  CONSTRAINT `fk_sle_set_list` FOREIGN KEY (`set_list_id`)
    REFERENCES `set_lists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sle_song` FOREIGN KEY (`account`, `songnumber`)
    REFERENCES `songs` (`account`, `songnumber`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- One row per Tag Assignment; playback metadata hangs off the assignment, not the entry.
CREATE TABLE `set_list_entry_tags` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `set_list_entry_id` INT NOT NULL,
  `tag_name` VARCHAR(100) NOT NULL,
  `custom_key` VARCHAR(20) DEFAULT NULL,
  `block_order_name` VARCHAR(200) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_slet_entry_tag` (`set_list_entry_id`, `tag_name`),
  CONSTRAINT `fk_slet_entry` FOREIGN KEY (`set_list_entry_id`)
    REFERENCES `set_list_entries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Stage Monitor Layers
--
-- A layer is a placed band on the presentation output holding an ordered list of cues
-- (clock / countdown / count-up / message). Cues live in `data` rather than a table of
-- their own: nothing queries an individual cue, the editor loads and saves whole layers.
-- --------------------------------------------------------
CREATE TABLE `stage_layers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `enabled` TINYINT(1) DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `data` JSON NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_stage_layers_account_name` (`account`, `name`),
  CONSTRAINT `fk_stage_layers_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Bands
--
-- A band is the group of people that plays a show: a name, a colour for its chips, and
-- the musicians on it. The members are a JSON list rather than a table of their own —
-- nothing ever joins on a single member; they exist to be offered as suggestions on the
-- musician page and wherever an order is named after the band that plays it.
-- --------------------------------------------------------
CREATE TABLE `bands` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account` INT NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `color` VARCHAR(20) DEFAULT NULL,
  `members` JSON DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_bands_account_name` (`account`, `name`),
  CONSTRAINT `fk_bands_account` FOREIGN KEY (`account`)
    REFERENCES `account` (`license`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Band assignments. A show or a set list can name several bands (two bands sharing a
-- service, a list a whole team works from), so this is a join table rather than a column.
-- Deleting a band drops its assignments and leaves the shows themselves alone.
CREATE TABLE `show_bands` (
  `account` INT NOT NULL,
  `show_title` VARCHAR(200) NOT NULL,
  `band_id` INT NOT NULL,
  PRIMARY KEY (`account`, `show_title`, `band_id`),
  KEY `idx_show_bands_band` (`band_id`),
  CONSTRAINT `fk_show_bands_show` FOREIGN KEY (`account`, `show_title`)
    REFERENCES `shows` (`account`, `title`) ON DELETE CASCADE,
  CONSTRAINT `fk_show_bands_band` FOREIGN KEY (`band_id`)
    REFERENCES `bands` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `set_list_bands` (
  `set_list_id` INT NOT NULL,
  `band_id` INT NOT NULL,
  PRIMARY KEY (`set_list_id`, `band_id`),
  KEY `idx_set_list_bands_band` (`band_id`),
  CONSTRAINT `fk_slb_set_list` FOREIGN KEY (`set_list_id`)
    REFERENCES `set_lists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_slb_band` FOREIGN KEY (`band_id`)
    REFERENCES `bands` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------
-- Schema Version Tracking (for migrations)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `schema_version` (
  `version` INT NOT NULL,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `schema_version` (`version`, `description`) VALUES (23, 'Fresh install — all migrations included');

COMMIT;

/*
 * Database migrations are managed through the Admin Panel UI in the "Database" tab.
 *
 * The migration logic lives in api/AdminMigrations.php and is exposed via:
 *   GET  /rest/AdminMigrations → view status
 *   POST /rest/AdminMigrations → run pending migrations
 */

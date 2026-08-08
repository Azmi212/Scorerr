CREATE TABLE `seerr_prevent_search_probes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seerr_connection_id` integer NOT NULL,
	`seerr_radarr_id` integer NOT NULL,
	`original_value` integer NOT NULL,
	`expected_config_fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`tested_at` integer,
	`restored_at` integer,
	`last_error_code` text,
	`last_error_message` text
);
--> statement-breakpoint
CREATE INDEX `seerr_prevent_search_probes_state_index` ON `seerr_prevent_search_probes` (`state`,`id`);

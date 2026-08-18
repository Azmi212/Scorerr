CREATE TABLE `release_probes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`movie_id` integer NOT NULL,
	`movie_title` text,
	`radarr_version` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration_ms` integer,
	`status` text NOT NULL,
	`release_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`summary_json` text
);
--> statement-breakpoint
CREATE INDEX `release_probes_movie_started_index` ON `release_probes` (`movie_id`,`started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_probes_one_searching_movie_unique` ON `release_probes` (`movie_id`) WHERE `status` = 'searching';
--> statement-breakpoint
CREATE TABLE `release_probe_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`probe_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`normalized_json` text NOT NULL,
	`raw_redacted_json` text NOT NULL,
	FOREIGN KEY (`probe_id`) REFERENCES `release_probes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_probe_items_probe_ordinal_unique` ON `release_probe_items` (`probe_id`,`ordinal`);

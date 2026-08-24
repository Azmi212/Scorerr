ALTER TABLE `profiles` ADD `is_default` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_one_default_unique` ON `profiles` (`is_default`) WHERE `is_default` = 1;
--> statement-breakpoint
ALTER TABLE `service_connections` ADD `is_default` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `service_connections`
SET `is_default` = 1
WHERE `is_active` = 1
  AND (
    SELECT COUNT(*)
    FROM `service_connections` AS `candidate`
    WHERE `candidate`.`service` = `service_connections`.`service`
      AND `candidate`.`is_active` = 1
  ) = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `service_connections_one_default_per_service_unique` ON `service_connections` (`service`) WHERE `is_default` = 1;
--> statement-breakpoint
CREATE TABLE `simulations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`movie_id` integer NOT NULL,
	`movie_json` text,
	`radarr_connection_id` integer NOT NULL,
	`radarr_snapshot_json` text NOT NULL,
	`profile_id` integer NOT NULL,
	`profile_revision` integer NOT NULL,
	`profile_schema_version` integer NOT NULL,
	`profile_snapshot_json` text NOT NULL,
	`progress_json` text NOT NULL,
	`summary_json` text,
	`selection_json` text,
	`result_json` text,
	`error_code` text,
	`error_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`last_error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `simulations_started_index` ON `simulations` (`started_at`,`id`);
--> statement-breakpoint
CREATE INDEX `simulations_profile_revision_index` ON `simulations` (`profile_id`,`profile_revision`);
--> statement-breakpoint
CREATE INDEX `simulations_radarr_movie_index` ON `simulations` (`radarr_connection_id`,`movie_id`);
--> statement-breakpoint
CREATE INDEX `simulations_claim_index` ON `simulations` (`status`,`available_at`,`id`);
--> statement-breakpoint
CREATE TABLE `simulation_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`simulation_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`presentation_ordinal` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`category` text NOT NULL,
	`eliminated_at_step` integer,
	`observed_json` text NOT NULL,
	`normalized_json` text NOT NULL,
	`evaluation_json` text NOT NULL,
	`reasons_json` text NOT NULL,
	FOREIGN KEY (`simulation_id`) REFERENCES `simulations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simulation_releases_simulation_ordinal_unique` ON `simulation_releases` (`simulation_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `simulation_releases_presentation_index` ON `simulation_releases` (`simulation_id`,`presentation_ordinal`);
--> statement-breakpoint
CREATE INDEX `simulation_releases_category_index` ON `simulation_releases` (`simulation_id`,`category`);

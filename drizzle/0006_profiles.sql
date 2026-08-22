CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`schema_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`type` text NOT NULL,
	`position` integer NOT NULL,
	`config_version` integer NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_rules_profile_type_unique` ON `profile_rules` (`profile_id`,`type`);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_rules_profile_position_unique` ON `profile_rules` (`profile_id`,`position`);
--> statement-breakpoint
CREATE INDEX `profile_rules_profile_position_index` ON `profile_rules` (`profile_id`,`position`);

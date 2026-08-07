CREATE TABLE `installation_probe_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`report_json` text NOT NULL,
	`created_at` integer NOT NULL
);

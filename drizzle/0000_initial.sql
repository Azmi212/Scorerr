CREATE TABLE `events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source` text NOT NULL,
  `event_type` text,
  `payload_raw` text NOT NULL,
  `payload_raw_hash` text NOT NULL,
  `event_fingerprint` text NOT NULL,
  `received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_event_fingerprint_unique` ON `events` (`event_fingerprint`);
--> statement-breakpoint
CREATE INDEX `events_received_at_index` ON `events` (`received_at`);
--> statement-breakpoint
CREATE TABLE `tasks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` integer NOT NULL,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `available_at` integer NOT NULL,
  `locked_at` integer,
  `locked_by` text,
  `completed_at` integer,
  `result` text,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_claim_index` ON `tasks` (`status`,`available_at`,`id`);

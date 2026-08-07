CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`event_type` text,
	`event_id` integer NOT NULL,
	`event_fingerprint` text NOT NULL,
	`payload_raw_hash` text NOT NULL,
	`duplicate` integer NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_received_index` ON `webhook_deliveries` (`received_at`,`id`);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_event_type_index` ON `webhook_deliveries` (`event_type`,`received_at`);

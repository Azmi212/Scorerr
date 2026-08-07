CREATE TABLE `encrypted_secrets` (`id` text PRIMARY KEY NOT NULL, `ciphertext` text NOT NULL, `iv` text NOT NULL, `auth_tag` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE TABLE `service_connections` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `service` text NOT NULL, `alias` text DEFAULT 'default' NOT NULL, `base_url` text NOT NULL, `secret_ref` text NOT NULL, `is_active` integer DEFAULT false NOT NULL, `connection_status` text DEFAULT 'untested' NOT NULL, `version` text, `instance_name` text, `last_tested_at` integer, `last_successful_test_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_connections_service_url_unique` ON `service_connections` (`service`,`base_url`);
--> statement-breakpoint
CREATE INDEX `service_connections_active_index` ON `service_connections` (`service`,`is_active`);
--> statement-breakpoint
CREATE TABLE `installation_diagnostics` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `status` text NOT NULL, `radarr_connection_id` integer NOT NULL, `seerr_connection_id` integer NOT NULL, `selected_seerr_radarr_id` integer, `result_json` text NOT NULL, `configuration_fingerprint` text NOT NULL, `created_at` integer NOT NULL, `expires_at` integer NOT NULL);
--> statement-breakpoint
CREATE TABLE `installation_snapshots` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `version` integer DEFAULT 1 NOT NULL, `diagnostic_id` integer NOT NULL, `state` text DEFAULT 'valid' NOT NULL, `snapshot_json` text NOT NULL, `configuration_fingerprint` text NOT NULL, `created_at` integer NOT NULL, `applied_at` integer, `rolled_back_at` integer);
--> statement-breakpoint
CREATE TABLE `managed_resources` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `snapshot_id` integer NOT NULL, `service` text NOT NULL, `resource_type` text NOT NULL, `external_id` text NOT NULL, `marker` text NOT NULL, `created_by_scorerr` integer NOT NULL, `expected_state_json` text NOT NULL, `created_at` integer NOT NULL, `removed_at` integer);
--> statement-breakpoint
CREATE INDEX `managed_resources_lookup_index` ON `managed_resources` (`service`,`resource_type`);
--> statement-breakpoint
CREATE TABLE `installation_operations` (`id` text PRIMARY KEY NOT NULL, `action` text NOT NULL, `status` text NOT NULL, `report_json` text, `created_at` integer NOT NULL, `completed_at` integer);
--> statement-breakpoint
CREATE TABLE `installation_audit_log` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `operation_id` text NOT NULL, `action` text NOT NULL, `service` text, `resource_type` text, `resource_id` text, `before_json` text, `after_json` text, `result` text NOT NULL, `error_code` text, `error_message` text, `created_at` integer NOT NULL);

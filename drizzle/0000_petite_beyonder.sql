CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`metadata` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `staff_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_event_time` ON `audit_log` (`event_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `backup_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`reason` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`quick_check_ok` integer NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`space_a_id` text NOT NULL,
	`space_b_id` text NOT NULL,
	`allow_a_to_b` integer DEFAULT true NOT NULL,
	`allow_b_to_a` integer DEFAULT true NOT NULL,
	`label_a_to_b` text DEFAULT 'ENTRÉE +1' NOT NULL,
	`label_b_to_a` text DEFAULT 'SORTIE −1' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`space_a_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`space_b_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_checkpoints_event` ON `checkpoints` (`event_id`);--> statement-breakpoint
CREATE TABLE `device_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`used_at_ms` integer,
	`revoked_at_ms` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `staff_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_invites_token_hash_unique` ON `device_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	`last_seen_at_ms` integer,
	`last_pending_count` integer DEFAULT 0 NOT NULL,
	`last_client_sequence` integer,
	`app_version` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_sessions_token_hash_unique` ON `device_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_device_sessions_event_last_seen` ON `device_sessions` (`event_id`,`last_seen_at_ms`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`timezone` text DEFAULT 'Europe/Paris' NOT NULL,
	`capacity` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`warning_ratio_1` real DEFAULT 0.8 NOT NULL,
	`warning_ratio_2` real DEFAULT 0.9 NOT NULL,
	`starts_at_ms` integer,
	`ends_at_ms` integer,
	`live_started_at_ms` integer,
	`closing_started_at_ms` integer,
	`closed_at_ms` integer,
	`archived_at_ms` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`topology_locked_at_ms` integer,
	`created_by` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `staff_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`instance_name` text DEFAULT 'PaxFlux' NOT NULL,
	`setup_token_hash` text,
	`setup_token_expires_at_ms` integer,
	`initialized_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`checkpoint_id` text,
	`device_session_id` text,
	`actor_user_id` text,
	`kind` text NOT NULL,
	`client_action_id` text,
	`device_sequence` integer,
	`from_space_id` text,
	`to_space_id` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`reverses_movement_id` integer,
	`reason` text,
	`client_time_ms` integer,
	`server_time_ms` integer NOT NULL,
	`event_version` integer NOT NULL,
	`source` text DEFAULT 'online' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_session_id`) REFERENCES `device_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `staff_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movements_client_action_id_unique` ON `movements` (`client_action_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `movements_reverses_movement_id_unique` ON `movements` (`reverses_movement_id`);--> statement-breakpoint
CREATE INDEX `idx_movements_event_time` ON `movements` (`event_id`,`server_time_ms`);--> statement-breakpoint
CREATE INDEX `idx_movements_event_checkpoint_time` ON `movements` (`event_id`,`checkpoint_id`,`server_time_ms`);--> statement-breakpoint
CREATE INDEX `idx_movements_device_time` ON `movements` (`device_session_id`,`server_time_ms`);--> statement-breakpoint
CREATE TABLE `space_state` (
	`event_id` text NOT NULL,
	`space_id` text NOT NULL,
	`occupancy` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`event_id`, `space_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`capacity` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_spaces_event_parent` ON `spaces` (`event_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `staff_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	FOREIGN KEY (`user_id`) REFERENCES `staff_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_sessions_token_hash_unique` ON `staff_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `staff_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'supervisor' NOT NULL,
	`password_hash` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`last_login_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_users_username_normalized_unique` ON `staff_users` (`username_normalized`);